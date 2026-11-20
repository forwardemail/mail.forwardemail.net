//! IMAP operations, one function per command the app needs.
//!
//! Nothing here parses a message. Headers and bodies go back to the webview
//! as bytes and the JavaScript parser the app already has reads them, so
//! there is one parser for every kind of account.

use std::fmt::Debug;
use std::time::Duration;

use async_imap::types::{Flag, NameAttribute};
use base64::Engine;
use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

use super::error::MailError;
use super::net;

pub type Session = async_imap::Session<TlsStream<TcpStream>>;

/// How long one command may take. A large folder list or a big message on a
/// slow link needs most of this.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(90);
pub(super) const LOGIN_TIMEOUT: Duration = Duration::from_secs(30);
/// The server may answer with more than this; a page never asks for more.
pub const MAX_PAGE: u32 = 250;

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// TLS from the first byte (port 993).
    Tls,
    /// Plain connection upgraded with STARTTLS before sign-in (port 143).
    Starttls,
}

/// What signs the user in.
#[derive(Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Auth {
    #[default]
    Password,
    /// An OAuth access token, in the password field (oauth.rs).
    Xoauth2,
}

// No Debug: the password must never reach a log line.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapSettings {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub auth: Auth,
    /// The user said this server is on their own network.
    #[serde(default)]
    pub allow_local: bool,
}

impl ImapSettings {
    pub fn validate(&self) -> Result<(), MailError> {
        if !net::valid_host(self.host.trim()) {
            return Err(MailError::input("That is not a valid server name"));
        }
        if self.username.is_empty() || self.password.is_empty() {
            return Err(MailError::input("A username and password are required"));
        }
        // A line break would end the command and start another.
        if self.username.contains(['\r', '\n']) || self.password.contains(['\r', '\n']) {
            return Err(MailError::input("The username or password is not valid"));
        }
        Ok(())
    }
}

pub(super) async fn timed<T, E, F>(limit: Duration, what: &str, fut: F) -> Result<T, MailError>
where
    F: std::future::Future<Output = Result<T, E>>,
    MailError: From<E>,
{
    match tokio::time::timeout(limit, fut).await {
        Ok(result) => result.map_err(MailError::from),
        Err(_) => Err(MailError::timeout(what)),
    }
}

pub(super) async fn read_greeting<T>(client: &mut async_imap::Client<T>) -> Result<(), MailError>
where
    T: AsyncRead + AsyncWrite + Unpin + Debug + Send,
{
    let greeting = timed(
        LOGIN_TIMEOUT,
        "waiting for the server",
        client.read_response(),
    )
    .await?;
    if greeting.is_none() {
        return Err(MailError::new("closed", "The server closed the connection"));
    }
    Ok(())
}

/// Connect and sign in. The password is only sent over TLS: with STARTTLS the
/// upgrade has to succeed first, and a server that refuses it is an error.
pub async fn login(settings: &ImapSettings) -> Result<Session, MailError> {
    settings.validate()?;
    let host = settings.host.trim();
    let client = match settings.security {
        Security::Tls => {
            let tls = net::connect_tls(host, settings.port, settings.allow_local).await?;
            let mut client = async_imap::Client::new(tls);
            read_greeting(&mut client).await?;
            client
        }
        Security::Starttls => {
            let tcp = net::connect_plain(host, settings.port, settings.allow_local).await?;
            let mut plain = async_imap::Client::new(tcp);
            read_greeting(&mut plain).await?;
            timed(
                LOGIN_TIMEOUT,
                "securing the connection",
                plain.run_command_and_check_ok("STARTTLS", None),
            )
            .await
            .map_err(|e| {
                MailError::new(
                    "tls",
                    format!("The server did not accept STARTTLS: {}", e.message),
                )
            })?;
            let tls = net::upgrade(host, plain.into_inner()).await?;
            async_imap::Client::new(tls)
        }
    };
    sign_in(
        client,
        &settings.username,
        &settings.password,
        settings.auth,
    )
    .await
}

/// The token goes with the command itself (see `sign_in`), so all that is
/// left to say is nothing: a server that refuses a token explains why first
/// and waits for an empty answer before it says no.
struct NothingMore;

impl async_imap::Authenticator for NothingMore {
    type Response = String;

    fn process(&mut self, _challenge: &[u8]) -> Self::Response {
        String::new()
    }
}

/// Send the user name and password on a connection that is already secure.
pub(super) async fn sign_in(
    client: async_imap::Client<TlsStream<TcpStream>>,
    username: &str,
    password: &str,
    auth: Auth,
) -> Result<Session, MailError> {
    let attempt = async {
        match auth {
            Auth::Password => client.login(username, password).await,
            Auth::Xoauth2 => {
                // Sent on the same line as the command, the way Gmail and
                // Microsoft document it. A strict server refuses XOAUTH2
                // sent in two steps.
                let token = base64::engine::general_purpose::STANDARD
                    .encode(super::oauth::xoauth2(username, password));
                client
                    .authenticate(format!("XOAUTH2 {token}"), NothingMore)
                    .await
            }
        }
    };
    match tokio::time::timeout(LOGIN_TIMEOUT, attempt).await {
        Err(_) => Err(MailError::timeout("signing in")),
        Ok(Ok(session)) => Ok(session),
        Ok(Err((err, _client))) => Err(match err {
            async_imap::error::Error::No(text) | async_imap::error::Error::Bad(text) => {
                MailError::new("auth", text)
            }
            other => other.into(),
        }),
    }
}

fn encode_name(name: &str) -> String {
    utf7_imap::encode_utf7_imap(name.to_string())
}

fn decode_name(name: &str) -> String {
    utf7_imap::decode_utf7_imap(name.to_string())
}

fn flag_text(flag: &Flag<'_>) -> Option<String> {
    Some(match flag {
        Flag::Seen => "\\Seen".into(),
        Flag::Answered => "\\Answered".into(),
        Flag::Flagged => "\\Flagged".into(),
        Flag::Deleted => "\\Deleted".into(),
        Flag::Draft => "\\Draft".into(),
        Flag::Custom(name) => name.to_string(),
        // \Recent and \* say nothing about the message itself.
        _ => return None,
    })
}

/// A flag or keyword as it may be written into a STORE command: an atom,
/// optionally starting with a backslash for a system flag.
fn valid_flag(flag: &str) -> bool {
    let name = flag.strip_prefix('\\').unwrap_or(flag);
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_graphic() && !"(){%*\"\\]".contains(c))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub delimiter: Option<String>,
    /// "sent", "trash", "drafts", "junk", "archive", "all" or "flagged".
    pub special_use: Option<&'static str>,
    pub selectable: bool,
    pub total: Option<u32>,
    pub unseen: Option<u32>,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
}

pub async fn folders(session: &mut Session) -> Result<Vec<Folder>, MailError> {
    let names: Vec<async_imap::types::Name> = timed(COMMAND_TIMEOUT, "listing folders", async {
        session.list(Some(""), Some("*")).await?.try_collect().await
    })
    .await?;

    let mut out = Vec::with_capacity(names.len());
    for name in &names {
        let mut selectable = true;
        let mut special_use = None;
        for attribute in name.attributes() {
            match attribute {
                NameAttribute::NoSelect => selectable = false,
                NameAttribute::Sent => special_use = Some("sent"),
                NameAttribute::Trash => special_use = Some("trash"),
                NameAttribute::Drafts => special_use = Some("drafts"),
                NameAttribute::Junk => special_use = Some("junk"),
                NameAttribute::Archive => special_use = Some("archive"),
                NameAttribute::All => special_use = Some("all"),
                NameAttribute::Flagged => special_use = Some("flagged"),
                NameAttribute::Extension(text) if text.eq_ignore_ascii_case("\\NonExistent") => {
                    selectable = false
                }
                _ => {}
            }
        }
        out.push(Folder {
            path: decode_name(name.name()),
            delimiter: name.delimiter().map(str::to_string),
            special_use,
            selectable,
            total: None,
            unseen: None,
            uid_validity: None,
            uid_next: None,
        });
    }

    // Counts come from STATUS, which does not change the selected folder. A
    // folder the server will not report on keeps empty counts.
    for (folder, name) in out.iter_mut().zip(&names) {
        if !folder.selectable {
            continue;
        }
        let status = timed(
            COMMAND_TIMEOUT,
            "reading a folder",
            session.status(name.name(), "(MESSAGES UNSEEN UIDVALIDITY UIDNEXT)"),
        )
        .await;
        match status {
            Ok(mailbox) => {
                folder.total = Some(mailbox.exists);
                folder.unseen = mailbox.unseen;
                folder.uid_validity = mailbox.uid_validity;
                folder.uid_next = mailbox.uid_next;
            }
            Err(err) if err.is_connection() => return Err(err),
            Err(_) => {}
        }
    }
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub uid: u32,
    pub flags: Vec<String>,
    pub size: Option<u32>,
    /// When the server received the message, RFC 3339.
    pub internal_date: Option<String>,
    /// The message's header block, base64. Headers may hold bytes that are
    /// not valid UTF-8, so they are not sent as text.
    pub header: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub total: u32,
    pub uid_validity: Option<u32>,
    pub uid_next: Option<u32>,
    /// The folder's change counter when it was opened, on a server that
    /// keeps one. Text: it does not fit a JavaScript number.
    pub highest_modseq: Option<String>,
    /// Newest first.
    pub rows: Vec<Row>,
}

const ROW_QUERY: &str = "(UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER])";

fn row_from(fetch: &async_imap::types::Fetch) -> Option<Row> {
    let uid = fetch.uid?;
    Some(Row {
        uid,
        flags: fetch.flags().filter_map(|f| flag_text(&f)).collect(),
        size: fetch.size,
        internal_date: fetch.internal_date().map(|d| d.to_rfc3339()),
        header: base64::engine::general_purpose::STANDARD.encode(fetch.header().unwrap_or(&[])),
    })
}

/// One page of a folder, newest first. Pages count back from the newest
/// message by position, so page 1 is always the latest mail.
pub async fn rows(
    session: &mut Session,
    folder: &str,
    page: u32,
    limit: u32,
    counter: &ChangeCounter,
) -> Result<Page, MailError> {
    let limit = limit.clamp(1, MAX_PAGE);
    let page = page.max(1);
    let mailbox = select_counted(session, folder, counter).await?;
    let total = mailbox.exists;
    let mut out = Page {
        total,
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        highest_modseq: mailbox.highest_modseq.map(|n| n.to_string()),
        rows: Vec::new(),
    };
    let skipped = (page - 1).saturating_mul(limit);
    if skipped >= total {
        return Ok(out);
    }
    let high = total - skipped;
    let low = high.saturating_sub(limit - 1).max(1);
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "listing messages", async {
            session
                .fetch(format!("{low}:{high}"), ROW_QUERY)
                .await?
                .try_collect()
                .await
        })
        .await?;
    out.rows = fetches.iter().filter_map(row_from).collect();
    out.rows.sort_by(|a, b| b.uid.cmp(&a.uid));
    Ok(out)
}

async fn select_mailbox(
    session: &mut Session,
    folder: &str,
) -> Result<async_imap::types::Mailbox, MailError> {
    timed(
        COMMAND_TIMEOUT,
        "opening the folder",
        session.select(encode_name(folder)),
    )
    .await
}

/// Whether the server counts changes to a folder (CONDSTORE, RFC 7162).
/// Asked once for an account and remembered.
#[derive(Default)]
pub struct ChangeCounter(std::sync::atomic::AtomicU8);

impl ChangeCounter {
    const YES: u8 = 1;
    const NO: u8 = 2;

    async fn kept(&self, session: &mut Session) -> Result<bool, MailError> {
        use std::sync::atomic::Ordering::Relaxed;
        match self.0.load(Relaxed) {
            Self::YES => Ok(true),
            Self::NO => Ok(false),
            _ => {
                let kept = has_capability(session, "CONDSTORE").await?;
                self.0
                    .store(if kept { Self::YES } else { Self::NO }, Relaxed);
                Ok(kept)
            }
        }
    }
}

/// Open a folder and, where the server keeps one, learn its change counter.
/// A server only has to report it once the client has asked this way.
async fn select_counted(
    session: &mut Session,
    folder: &str,
    counter: &ChangeCounter,
) -> Result<async_imap::types::Mailbox, MailError> {
    if !counter.kept(session).await? {
        return select_mailbox(session, folder).await;
    }
    timed(
        COMMAND_TIMEOUT,
        "opening the folder",
        session.select_condstore(encode_name(folder)),
    )
    .await
}

/// What changed in a folder since its change counter read `since`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub uid_validity: Option<u32>,
    /// The counter now. Asking again with it answers only what is newer.
    pub highest_modseq: String,
    /// New messages and messages whose flags changed, newest first.
    /// Removed messages are not among them: the server does not say.
    pub uids: Vec<u32>,
}

/// The messages that are new or whose flags changed since the folder's
/// change counter read `since`. None when the server keeps no counter for
/// this folder, and the caller has to read the folder as it would anyway.
///
/// When nothing changed this is one command: opening the folder says so.
pub async fn changes(
    session: &mut Session,
    folder: &str,
    since: &str,
    counter: &ChangeCounter,
) -> Result<Option<Changes>, MailError> {
    let since: u64 = since
        .parse()
        .map_err(|_| MailError::input("That is not a change counter"))?;
    if !counter.kept(session).await? {
        return Ok(None);
    }
    let mailbox = select_counted(session, folder, counter).await?;
    let Some(highest) = mailbox.highest_modseq else {
        return Ok(None);
    };
    let mut out = Changes {
        uid_validity: mailbox.uid_validity,
        highest_modseq: highest.to_string(),
        uids: Vec::new(),
    };
    if highest <= since || mailbox.exists == 0 {
        return Ok(Some(out));
    }
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "reading what changed", async {
            session
                .uid_fetch("1:*", format!("(UID) (CHANGEDSINCE {since})"))
                .await?
                .try_collect()
                .await
        })
        .await?;
    out.uids = fetches.iter().filter_map(|f| f.uid).collect();
    out.uids.sort_unstable_by(|a, b| b.cmp(a));
    out.uids.dedup();
    out.uids.truncate(MAX_SEARCH_RESULTS);
    Ok(Some(out))
}

/// How much of the mailbox's storage is used, in bytes.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Storage {
    pub used: u64,
    pub total: u64,
}

/// The tightest storage limit among the quotas a server reported. A server
/// may report several (a user quota and a domain quota); the one closest to
/// full is the one the user will hit. Limits are in units of 1024 bytes.
fn tightest_storage(quotas: &[async_imap::types::Quota]) -> Option<Storage> {
    use async_imap::types::QuotaResourceName;
    quotas
        .iter()
        .flat_map(|quota| quota.resources.iter())
        .filter(|resource| resource.name == QuotaResourceName::Storage && resource.limit > 0)
        .map(|resource| Storage {
            used: resource.usage.saturating_mul(1024),
            total: resource.limit.saturating_mul(1024),
        })
        .max_by(|a, b| {
            // usage / limit compared without floating point
            (u128::from(a.used) * u128::from(b.total))
                .cmp(&(u128::from(b.used) * u128::from(a.total)))
        })
}

/// The mailbox's storage limit and how much of it is used. None when the
/// server has no quota extension or sets no storage limit on the inbox.
pub async fn storage(session: &mut Session) -> Result<Option<Storage>, MailError> {
    if !has_capability(session, "QUOTA").await? {
        return Ok(None);
    }
    let (_roots, quotas) = timed(
        COMMAND_TIMEOUT,
        "reading the storage limit",
        session.get_quota_root("INBOX"),
    )
    .await?;
    Ok(tightest_storage(&quotas))
}

/// Open a folder without the right to change it, for watching.
pub(super) async fn examine(session: &mut Session, folder: &str) -> Result<(), MailError> {
    timed(
        COMMAND_TIMEOUT,
        "opening the folder",
        session.examine(encode_name(folder)),
    )
    .await
    .map(|_| ())
}

pub(super) async fn select(session: &mut Session, folder: &str) -> Result<(), MailError> {
    select_mailbox(session, folder).await.map(|_| ())
}

/// The most rows one call returns for a list of UIDs.
pub const MAX_UIDS: usize = MAX_PAGE as usize;
/// A search that matches more than this is cut to the newest.
const MAX_SEARCH_RESULTS: usize = 10_000;

/// The rows of the given messages, newest first. UIDs the folder no longer
/// has are left out.
pub async fn rows_for(
    session: &mut Session,
    folder: &str,
    uids: &[u32],
) -> Result<Page, MailError> {
    if uids.len() > MAX_UIDS {
        return Err(MailError::input("Too many messages were asked for at once"));
    }
    let mailbox = select_mailbox(session, folder).await?;
    let mut out = Page {
        total: mailbox.exists,
        uid_validity: mailbox.uid_validity,
        uid_next: mailbox.uid_next,
        highest_modseq: None,
        rows: Vec::new(),
    };
    if uids.is_empty() {
        return Ok(out);
    }
    let set = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "listing messages", async {
            session.uid_fetch(set, ROW_QUERY).await?.try_collect().await
        })
        .await?;
    out.rows = fetches.iter().filter_map(row_from).collect();
    out.rows.sort_by(|a, b| b.uid.cmp(&a.uid));
    Ok(out)
}

/// What to look for in a folder. Every field given must match.
///
/// The webview sends these fields and this module writes the IMAP command,
/// so nothing typed into a search box is ever part of a command as it is.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchQuery {
    /// Anywhere in the headers or the body.
    pub text: Option<String>,
    pub subject: Option<String>,
    pub from: Option<String>,
    /// In To or Cc.
    pub to: Option<String>,
    pub body: Option<String>,
    /// true for unread only, false for read only.
    pub unseen: Option<bool>,
    pub flagged: Option<bool>,
    /// A label, which IMAP calls a keyword.
    pub keyword: Option<String>,
    /// Received on or after this day, YYYY-MM-DD.
    pub since: Option<String>,
    /// Received before this day, YYYY-MM-DD.
    pub before: Option<String>,
    /// The exact Message-ID header.
    pub message_id: Option<String>,
    /// Has a file attached, as far as the outer content type tells.
    pub has_attachment: Option<bool>,
}

/// One word of a search command.
#[derive(Debug, PartialEq)]
enum Token {
    /// A keyword or a value this module wrote itself.
    Atom(String),
    /// Text from the search box.
    Text(String),
}

/// A string as an IMAP quoted string.
fn quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// YYYY-MM-DD as the day-month-year form IMAP searches take.
fn search_date(value: &str) -> Result<String, MailError> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let parts: Vec<&str> = value.split('-').collect();
    let numbers: Vec<u32> = parts.iter().filter_map(|p| p.parse().ok()).collect();
    match (parts.len(), numbers.as_slice()) {
        (3, [year, month, day])
            if (1970..=9999).contains(year)
                && (1..=12).contains(month)
                && (1..=31).contains(day) =>
        {
            Ok(format!("{day}-{}-{year}", MONTHS[(*month - 1) as usize]))
        }
        _ => Err(MailError::input("That date is not valid")),
    }
}

fn search_tokens(query: &SearchQuery) -> Result<Vec<Token>, MailError> {
    let mut tokens: Vec<Token> = Vec::new();
    let atom = |tokens: &mut Vec<Token>, text: &str| tokens.push(Token::Atom(text.to_string()));
    let value = |text: &Option<String>| -> Result<Option<String>, MailError> {
        let Some(text) = text.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
            return Ok(None);
        };
        // A line break would end the command and start another.
        if text.chars().any(|c| c.is_control()) || text.len() > 1024 {
            return Err(MailError::input("That search cannot be sent to the server"));
        }
        Ok(Some(text.to_string()))
    };
    for (key, field) in [
        ("TEXT", &query.text),
        ("SUBJECT", &query.subject),
        ("FROM", &query.from),
        ("BODY", &query.body),
        ("HEADER Message-ID", &query.message_id),
    ] {
        if let Some(text) = value(field)? {
            atom(&mut tokens, key);
            tokens.push(Token::Text(text));
        }
    }
    if let Some(to) = value(&query.to)? {
        atom(&mut tokens, "OR TO");
        tokens.push(Token::Text(to.clone()));
        atom(&mut tokens, "CC");
        tokens.push(Token::Text(to));
    }
    match query.unseen {
        Some(true) => atom(&mut tokens, "UNSEEN"),
        Some(false) => atom(&mut tokens, "SEEN"),
        None => {}
    }
    match query.flagged {
        Some(true) => atom(&mut tokens, "FLAGGED"),
        Some(false) => atom(&mut tokens, "UNFLAGGED"),
        None => {}
    }
    if let Some(keyword) = query.keyword.as_deref().filter(|k| !k.is_empty()) {
        if keyword.starts_with('\\') || !valid_flag(keyword) {
            return Err(MailError::input("That label name is not valid"));
        }
        atom(&mut tokens, &format!("KEYWORD {keyword}"));
    }
    if let Some(since) = query.since.as_deref() {
        atom(&mut tokens, &format!("SINCE {}", search_date(since)?));
    }
    if let Some(before) = query.before.as_deref() {
        atom(&mut tokens, &format!("BEFORE {}", search_date(before)?));
    }
    match query.has_attachment {
        Some(true) => atom(&mut tokens, "HEADER Content-Type \"multipart/mixed\""),
        Some(false) => atom(&mut tokens, "NOT HEADER Content-Type \"multipart/mixed\""),
        None => {}
    }
    if tokens.is_empty() {
        atom(&mut tokens, "ALL");
    }
    Ok(tokens)
}

/// The command as the lines it is sent in.
///
/// Plain text goes in quotes. Text that is not plain ASCII cannot: a quoted
/// string is 7-bit, and a strict server answers BAD to anything else. It is
/// sent as a literal instead, which is a byte count on one line and the
/// bytes at the start of the next, after the server says to go on.
fn search_lines(tokens: &[Token]) -> Vec<String> {
    let needs_charset = tokens
        .iter()
        .any(|t| matches!(t, Token::Text(text) if !text.is_ascii()));
    let mut lines = Vec::new();
    let mut line = String::from(if needs_charset {
        "UID SEARCH CHARSET UTF-8"
    } else {
        "UID SEARCH"
    });
    for token in tokens {
        match token {
            Token::Atom(text) => {
                line.push(' ');
                line.push_str(text);
            }
            Token::Text(text) if text.is_ascii() => {
                line.push(' ');
                line.push_str(&quoted(text));
            }
            Token::Text(text) => {
                line.push_str(&format!(" {{{}}}", text.len()));
                lines.push(std::mem::replace(&mut line, text.clone()));
            }
        }
    }
    lines.push(line);
    lines
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub uid_validity: Option<u32>,
    /// Newest first.
    pub uids: Vec<u32>,
}

/// Send a search and read its answer.
///
/// Done here and not with the library's own search: that one reads the
/// matches and ignores whether the server said OK, so a search the server
/// refused came back as "nothing found".
async fn run_search(session: &mut Session, lines: &[String]) -> Result<Vec<u32>, MailError> {
    use async_imap::imap_proto::{MailboxDatum, Response, Status};

    let closed = || MailError::new("closed", "The server closed the connection");
    let (first, rest) = lines.split_first().expect("a search has at least one line");
    // The library adds the tag, so drop the command name's leading word only
    // when it is there: run_command takes the command itself.
    let id = session.run_command(first).await?;
    for line in rest {
        // The server has to say "go on" before the bytes of a literal.
        loop {
            let response = session.read_response().await?.ok_or_else(closed)?;
            match response.parsed() {
                Response::Continue { .. } => break,
                Response::Done { tag, outcome, .. } if *tag == id => {
                    return Err(MailError::new(
                        "server",
                        outcome
                            .information
                            .as_deref()
                            .unwrap_or("The search was refused"),
                    ));
                }
                _ => {}
            }
        }
        session.run_command_untagged(line).await?;
    }
    let mut uids = Vec::new();
    loop {
        let response = session.read_response().await?.ok_or_else(closed)?;
        match response.parsed() {
            Response::MailboxData(MailboxDatum::Search(found)) => {
                uids.extend(found.iter().copied())
            }
            Response::Done {
                tag,
                status,
                outcome,
            } if *tag == id => {
                return match status {
                    Status::Ok => Ok(uids),
                    _ => Err(MailError::new(
                        "server",
                        outcome
                            .information
                            .as_deref()
                            .unwrap_or("The search was refused"),
                    )),
                };
            }
            _ => {}
        }
    }
}

pub async fn search(
    session: &mut Session,
    folder: &str,
    query: &SearchQuery,
) -> Result<Found, MailError> {
    let lines = search_lines(&search_tokens(query)?);
    let mailbox = select_mailbox(session, folder).await?;
    let mut uids = match tokio::time::timeout(COMMAND_TIMEOUT, run_search(session, &lines)).await {
        Ok(found) => found?,
        Err(_) => return Err(MailError::timeout("searching the folder")),
    };
    uids.sort_unstable_by(|a, b| b.cmp(a));
    uids.dedup();
    uids.truncate(MAX_SEARCH_RESULTS);
    Ok(Found {
        uid_validity: mailbox.uid_validity,
        uids,
    })
}

/// Where a message ended up after it was saved or moved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Located {
    pub uid_validity: Option<u32>,
    pub uid: u32,
}

/// The Message-ID header of a message, from its header block.
fn message_id_of(message: &[u8]) -> Option<String> {
    let end = message
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .or_else(|| message.windows(2).position(|w| w == b"\n\n"))
        .unwrap_or(message.len());
    let header = String::from_utf8_lossy(&message[..end]);
    let mut value: Option<String> = None;
    for line in header.lines() {
        if let Some(current) = value.as_mut() {
            // A line that starts with a space continues the header above it.
            if line.starts_with([' ', '\t']) {
                current.push_str(line.trim());
                continue;
            }
            break;
        }
        if let Some((name, rest)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("message-id") {
                value = Some(rest.trim().to_string());
            }
        }
    }
    value.filter(|v| !v.is_empty() && !v.chars().any(|c| c.is_control()))
}

/// Find a message in a folder by its Message-ID. The newest one, when the
/// folder holds more than one copy. The server does not say what UID a saved
/// or moved message got in a form this library reads, so it is looked up.
async fn locate(
    session: &mut Session,
    folder: &str,
    message_id: &str,
) -> Result<Option<Located>, MailError> {
    let found = search(
        session,
        folder,
        &SearchQuery {
            message_id: Some(message_id.to_string()),
            ..SearchQuery::default()
        },
    )
    .await?;
    Ok(found.uids.first().map(|uid| Located {
        uid_validity: found.uid_validity,
        uid: *uid,
    }))
}

async fn header_of(session: &mut Session, uid: u32) -> Result<Option<Vec<u8>>, MailError> {
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "reading the message", async {
            session
                .uid_fetch(uid.to_string(), "(UID BODY.PEEK[HEADER])")
                .await?
                .try_collect()
                .await
        })
        .await?;
    Ok(fetches
        .iter()
        .filter(|f| f.uid == Some(uid))
        .find_map(|f| f.header().map(<[u8]>::to_vec)))
}

/// One message's row, or None when the folder no longer has that UID.
pub async fn row(session: &mut Session, folder: &str, uid: u32) -> Result<Option<Row>, MailError> {
    select(session, folder).await?;
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "reading the message", async {
            session
                .uid_fetch(uid.to_string(), ROW_QUERY)
                .await?
                .try_collect()
                .await
        })
        .await?;
    Ok(fetches
        .iter()
        .filter(|f| f.uid == Some(uid))
        .find_map(row_from))
}

/// The whole message as the server holds it, without marking it read.
pub async fn raw(
    session: &mut Session,
    folder: &str,
    uid: u32,
) -> Result<Option<Vec<u8>>, MailError> {
    select(session, folder).await?;
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "downloading the message", async {
            session
                .uid_fetch(uid.to_string(), "(UID BODY.PEEK[])")
                .await?
                .try_collect()
                .await
        })
        .await?;
    Ok(fetches
        .iter()
        .filter(|f| f.uid == Some(uid))
        .find_map(|f| f.body().map(<[u8]>::to_vec)))
}

fn flag_list(flags: &[String]) -> Result<Option<String>, MailError> {
    if flags.is_empty() {
        return Ok(None);
    }
    if !flags.iter().all(|f| valid_flag(f)) {
        return Err(MailError::input("That flag or label name is not valid"));
    }
    Ok(Some(format!("({})", flags.join(" "))))
}

/// A list of UIDs as the server reads it: sorted, no repeats, runs written
/// as ranges ("3:7,9,12:14"). None when there is nothing to name.
fn uid_set(uids: &[u32]) -> Option<String> {
    let mut sorted: Vec<u32> = uids.iter().copied().filter(|uid| *uid > 0).collect();
    sorted.sort_unstable();
    sorted.dedup();
    let mut parts: Vec<String> = Vec::new();
    let mut at = 0;
    while at < sorted.len() {
        let first = sorted[at];
        let mut last = first;
        while at + 1 < sorted.len() && sorted[at + 1] == last + 1 {
            at += 1;
            last = sorted[at];
        }
        parts.push(if last == first {
            first.to_string()
        } else {
            format!("{first}:{last}")
        });
        at += 1;
    }
    (!parts.is_empty()).then(|| parts.join(","))
}

fn checked_uid_set(uids: &[u32]) -> Result<Option<String>, MailError> {
    if uids.len() > MAX_UIDS {
        return Err(MailError::input("Too many messages in one request"));
    }
    Ok(uid_set(uids))
}

/// STORE on the folder that is already open.
async fn store_set(
    session: &mut Session,
    set: &str,
    add: &Option<String>,
    remove: &Option<String>,
) -> Result<(), MailError> {
    for (sign, list) in [("+", add), ("-", remove)] {
        let Some(list) = list else { continue };
        timed(COMMAND_TIMEOUT, "changing the message", async {
            session
                .uid_store(set, format!("{sign}FLAGS.SILENT {list}"))
                .await?
                .try_collect::<Vec<_>>()
                .await
        })
        .await?;
    }
    Ok(())
}

pub async fn store(
    session: &mut Session,
    folder: &str,
    uid: u32,
    add: &[String],
    remove: &[String],
) -> Result<(), MailError> {
    store_many(session, folder, &[uid], add, remove).await
}

/// Change the flags of several messages in one folder with one command.
/// UIDs the folder no longer has are skipped by the server.
pub async fn store_many(
    session: &mut Session,
    folder: &str,
    uids: &[u32],
    add: &[String],
    remove: &[String],
) -> Result<(), MailError> {
    let add = flag_list(add)?;
    let remove = flag_list(remove)?;
    let Some(set) = checked_uid_set(uids)? else {
        return Ok(());
    };
    if add.is_none() && remove.is_none() {
        return Ok(());
    }
    select(session, folder).await?;
    store_set(session, &set, &add, &remove).await
}

pub(super) async fn has_capability(session: &mut Session, name: &str) -> Result<bool, MailError> {
    let capabilities = timed(COMMAND_TIMEOUT, "asking the server", session.capabilities()).await?;
    Ok(capabilities.has_str(name))
}

async fn expunge_uid(session: &mut Session, uid: u32) -> Result<(), MailError> {
    expunge_set(session, &uid.to_string()).await
}

async fn expunge_set(session: &mut Session, set: &str) -> Result<(), MailError> {
    // UID EXPUNGE removes only these messages. Without it, a plain EXPUNGE
    // would also remove anything another client had marked deleted, so the
    // messages are left marked and the server or that client removes them.
    if has_capability(session, "UIDPLUS").await? {
        timed(COMMAND_TIMEOUT, "deleting the message", async {
            session
                .uid_expunge(set)
                .await?
                .try_collect::<Vec<_>>()
                .await
        })
        .await?;
    }
    Ok(())
}

/// Move a message, and say where it is now when that can be found out.
pub async fn move_message(
    session: &mut Session,
    folder: &str,
    uid: u32,
    destination: &str,
) -> Result<Option<Located>, MailError> {
    select(session, folder).await?;
    // Read before the move: afterwards the message is not here to ask about.
    let message_id = header_of(session, uid)
        .await?
        .as_deref()
        .and_then(message_id_of);
    let dest = encode_name(destination);
    if has_capability(session, "MOVE").await? {
        timed(
            COMMAND_TIMEOUT,
            "moving the message",
            session.uid_mv(uid.to_string(), &dest),
        )
        .await?;
    } else {
        timed(
            COMMAND_TIMEOUT,
            "moving the message",
            session.uid_copy(uid.to_string(), &dest),
        )
        .await?;
        store(session, folder, uid, &["\\Deleted".to_string()], &[]).await?;
        expunge_uid(session, uid).await?;
    }
    // The move is done. Not finding the new copy is not a failed move.
    Ok(match message_id {
        Some(id) => locate(session, destination, &id).await.unwrap_or(None),
        None => None,
    })
}

pub async fn delete_message(
    session: &mut Session,
    folder: &str,
    uid: u32,
) -> Result<(), MailError> {
    store(session, folder, uid, &["\\Deleted".to_string()], &[]).await?;
    expunge_uid(session, uid).await
}

/// Remove several messages from one folder for good.
pub async fn delete_many(
    session: &mut Session,
    folder: &str,
    uids: &[u32],
) -> Result<(), MailError> {
    let Some(set) = checked_uid_set(uids)? else {
        return Ok(());
    };
    store_many(session, folder, uids, &["\\Deleted".to_string()], &[]).await?;
    expunge_set(session, &set).await
}

/// One message of a batch that was moved, and where it is now when that
/// could be found out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Moved {
    /// Its UID in the folder it was moved out of.
    pub uid: u32,
    pub located: Option<Located>,
}

/// The header blocks of the messages in a UID set of the open folder.
async fn headers_of_set(
    session: &mut Session,
    set: &str,
) -> Result<Vec<(u32, Vec<u8>)>, MailError> {
    let fetches: Vec<async_imap::types::Fetch> =
        timed(COMMAND_TIMEOUT, "reading the messages", async {
            session
                .uid_fetch(set, "(UID BODY.PEEK[HEADER])")
                .await?
                .try_collect()
                .await
        })
        .await?;
    Ok(fetches
        .iter()
        .filter_map(|f| Some((f.uid?, f.header()?.to_vec())))
        .collect())
}

/// Pair each moved message with its new UID. `arrived` is what the
/// destination holds from the UID it was about to hand out, in UID order.
/// Messages are matched by Message-ID; two with the same id are taken in
/// order, which is the order a server moves them in.
fn pair_moved(
    sources: &[(u32, Option<String>)],
    arrived: &[(u32, Option<String>)],
    uid_validity: Option<u32>,
) -> Vec<Moved> {
    let mut taken = vec![false; arrived.len()];
    sources
        .iter()
        .map(|(uid, id)| {
            let slot = id.as_ref().and_then(|wanted| {
                arrived
                    .iter()
                    .enumerate()
                    .position(|(at, (_, got))| !taken[at] && got.as_ref() == Some(wanted))
            });
            let located = slot.map(|at| {
                taken[at] = true;
                Located {
                    uid_validity,
                    uid: arrived[at].0,
                }
            });
            Moved { uid: *uid, located }
        })
        .collect()
}

/// Move several messages out of one folder with one command, and say where
/// each one is now when that can be found out.
///
/// The server is asked which UID the destination will hand out next, the
/// messages are moved, and whatever the destination holds from that UID on is
/// read once. That is a fixed number of commands however many messages move.
pub async fn move_many(
    session: &mut Session,
    folder: &str,
    uids: &[u32],
    destination: &str,
) -> Result<Vec<Moved>, MailError> {
    let Some(set) = checked_uid_set(uids)? else {
        return Ok(Vec::new());
    };
    select(session, folder).await?;
    // Read before the move: afterwards the messages are not here to ask about.
    let mut sources: Vec<(u32, Option<String>)> = headers_of_set(session, &set)
        .await?
        .into_iter()
        .map(|(uid, header)| (uid, message_id_of(&header)))
        .collect();
    sources.sort_unstable_by_key(|(uid, _)| *uid);
    sources.dedup_by_key(|(uid, _)| *uid);
    let dest = encode_name(destination);
    // Not knowing this only costs the new ids, so a refusal is not an error.
    let next_uid = timed(
        COMMAND_TIMEOUT,
        "reading a folder",
        session.status(&dest, "(UIDNEXT)"),
    )
    .await
    .ok()
    .and_then(|mailbox| mailbox.uid_next);

    if has_capability(session, "MOVE").await? {
        timed(
            COMMAND_TIMEOUT,
            "moving the messages",
            session.uid_mv(&set, &dest),
        )
        .await?;
    } else {
        timed(
            COMMAND_TIMEOUT,
            "moving the messages",
            session.uid_copy(&set, &dest),
        )
        .await?;
        store_set(session, &set, &Some("(\\Deleted)".to_string()), &None).await?;
        expunge_set(session, &set).await?;
    }

    // The move is done. Not finding the new copies is not a failed move.
    let unknown = |sources: &[(u32, Option<String>)]| {
        sources
            .iter()
            .map(|(uid, _)| Moved {
                uid: *uid,
                located: None,
            })
            .collect::<Vec<_>>()
    };
    let Some(next_uid) = next_uid else {
        return Ok(unknown(&sources));
    };
    let Ok(mailbox) = select_mailbox(session, destination).await else {
        return Ok(unknown(&sources));
    };
    // "n:*" always names the last message, even one older than n.
    let Ok(mut arrived) = headers_of_set(session, &format!("{next_uid}:*")).await else {
        return Ok(unknown(&sources));
    };
    arrived.retain(|(uid, _)| *uid >= next_uid);
    arrived.sort_unstable_by_key(|(uid, _)| *uid);
    let arrived: Vec<(u32, Option<String>)> = arrived
        .into_iter()
        .map(|(uid, header)| (uid, message_id_of(&header)))
        .collect();
    Ok(pair_moved(&sources, &arrived, mailbox.uid_validity))
}

pub async fn append(
    session: &mut Session,
    folder: &str,
    flags: &[String],
    message: &[u8],
) -> Result<Option<Located>, MailError> {
    let flags = flag_list(flags)?;
    timed(
        COMMAND_TIMEOUT,
        "saving the message",
        session.append(encode_name(folder), flags.as_deref(), None, message),
    )
    .await?;
    // Saved. Not finding it again is not a failed save.
    Ok(match message_id_of(message) {
        Some(id) => locate(session, folder, &id).await.unwrap_or(None),
        None => None,
    })
}

pub async fn create_folder(session: &mut Session, path: &str) -> Result<(), MailError> {
    timed(
        COMMAND_TIMEOUT,
        "creating the folder",
        session.create(encode_name(path)),
    )
    .await
}

pub async fn rename_folder(session: &mut Session, from: &str, to: &str) -> Result<(), MailError> {
    timed(
        COMMAND_TIMEOUT,
        "renaming the folder",
        session.rename(encode_name(from), encode_name(to)),
    )
    .await
}

pub async fn delete_folder(session: &mut Session, path: &str) -> Result<(), MailError> {
    // A selected folder cannot be deleted on some servers.
    let _ = timed(
        COMMAND_TIMEOUT,
        "closing the folder",
        session.examine("INBOX"),
    )
    .await;
    timed(
        COMMAND_TIMEOUT,
        "deleting the folder",
        session.delete(encode_name(path)),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quota(root: &str, resources: &[(&str, u64, u64)]) -> async_imap::types::Quota {
        use async_imap::types::{QuotaResource, QuotaResourceName};
        async_imap::types::Quota {
            root_name: root.to_string(),
            resources: resources
                .iter()
                .map(|(name, usage, limit)| QuotaResource {
                    name: match *name {
                        "STORAGE" => QuotaResourceName::Storage,
                        "MESSAGE" => QuotaResourceName::Message,
                        other => QuotaResourceName::Atom(other.to_string()),
                    },
                    usage: *usage,
                    limit: *limit,
                })
                .collect(),
        }
    }

    #[test]
    fn reads_storage_in_bytes_and_ignores_the_message_count() {
        // The server counts in units of 1024 bytes.
        let quotas = [quota(
            "User quota",
            &[("MESSAGE", 812, 100_000), ("STORAGE", 2_048, 10_240)],
        )];
        assert_eq!(
            tightest_storage(&quotas),
            Some(Storage {
                used: 2_048 * 1024,
                total: 10_240 * 1024
            })
        );
    }

    #[test]
    fn reports_the_limit_closest_to_full_when_there_are_several() {
        let quotas = [
            quota("user", &[("STORAGE", 900, 1_000)]),
            quota("domain", &[("STORAGE", 5_000, 100_000)]),
        ];
        assert_eq!(tightest_storage(&quotas).unwrap().total, 1_000 * 1024);
    }

    #[test]
    fn no_storage_limit_is_no_answer() {
        assert_eq!(tightest_storage(&[]), None);
        assert_eq!(
            tightest_storage(&[quota("user", &[("MESSAGE", 3, 10)])]),
            None
        );
        // A limit of zero is "not limited", not "full".
        assert_eq!(
            tightest_storage(&[quota("user", &[("STORAGE", 3, 0)])]),
            None
        );
    }

    #[test]
    fn writes_a_uid_list_as_sorted_ranges() {
        assert_eq!(uid_set(&[7]).as_deref(), Some("7"));
        assert_eq!(
            uid_set(&[12, 3, 5, 4, 14, 13, 9, 4]).as_deref(),
            Some("3:5,9,12:14")
        );
        // 0 is not a UID, and a server refuses a set that names it.
        assert_eq!(uid_set(&[0, 2]).as_deref(), Some("2"));
        assert_eq!(uid_set(&[]), None);
        assert_eq!(uid_set(&[0]), None);
    }

    #[test]
    fn refuses_more_messages_than_one_request_may_name() {
        let many: Vec<u32> = (1..=(MAX_UIDS as u32 + 1)).collect();
        assert!(checked_uid_set(&many).is_err());
        assert!(checked_uid_set(&many[..MAX_UIDS]).unwrap().is_some());
    }

    fn id(text: &str) -> Option<String> {
        Some(text.to_string())
    }

    fn new_uids(moved: &[Moved]) -> Vec<(u32, Option<u32>)> {
        moved
            .iter()
            .map(|m| (m.uid, m.located.as_ref().map(|l| l.uid)))
            .collect()
    }

    #[test]
    fn pairs_moved_messages_with_their_new_uids_by_message_id() {
        let sources = [(4, id("<a@x>")), (9, id("<b@x>")), (11, id("<c@x>"))];
        // The server need not keep the order, and someone else's mail can
        // land in the folder in the same moment.
        let arrived = [
            (40, id("<c@x>")),
            (41, id("<other@y>")),
            (42, id("<a@x>")),
            (43, id("<b@x>")),
        ];
        let moved = pair_moved(&sources, &arrived, Some(7));
        assert_eq!(
            new_uids(&moved),
            vec![(4, Some(42)), (9, Some(43)), (11, Some(40))]
        );
        assert!(moved
            .iter()
            .all(|m| m.located.as_ref().unwrap().uid_validity == Some(7)));
    }

    #[test]
    fn two_copies_of_one_message_each_get_their_own_new_uid() {
        let sources = [(4, id("<dup@x>")), (5, id("<dup@x>"))];
        let arrived = [(40, id("<dup@x>")), (41, id("<dup@x>"))];
        assert_eq!(
            new_uids(&pair_moved(&sources, &arrived, Some(1))),
            vec![(4, Some(40)), (5, Some(41))]
        );
    }

    #[test]
    fn a_moved_message_that_cannot_be_matched_is_reported_without_a_place() {
        let sources = [(4, None), (5, id("<gone@x>")), (6, id("<here@x>"))];
        // One with no Message-ID arrived too: it must not be handed to anyone.
        let arrived = [(40, None), (41, id("<here@x>"))];
        assert_eq!(
            new_uids(&pair_moved(&sources, &arrived, Some(1))),
            vec![(4, None), (5, None), (6, Some(41))]
        );
    }

    fn query(build: impl FnOnce(&mut SearchQuery)) -> Result<Vec<String>, MailError> {
        let mut q = SearchQuery::default();
        build(&mut q);
        Ok(search_lines(&search_tokens(&q)?))
    }

    fn one_line(build: impl FnOnce(&mut SearchQuery)) -> String {
        let lines = query(build).unwrap();
        assert_eq!(lines.len(), 1, "{lines:?}");
        lines.into_iter().next().unwrap()
    }

    #[test]
    fn a_search_is_written_from_its_fields() {
        assert_eq!(one_line(|_| {}), "UID SEARCH ALL");
        assert_eq!(one_line(|q| q.unseen = Some(true)), "UID SEARCH UNSEEN");
        assert_eq!(
            one_line(|q| {
                q.text = Some("quarterly report".into());
                q.from = Some("ada@example.com".into());
                q.unseen = Some(true);
                q.since = Some("2026-03-09".into());
            }),
            "UID SEARCH TEXT \"quarterly report\" FROM \"ada@example.com\" UNSEEN SINCE 9-Mar-2026"
        );
        assert_eq!(
            one_line(|q| q.to = Some("bob".into())),
            "UID SEARCH OR TO \"bob\" CC \"bob\""
        );
        assert_eq!(
            one_line(|q| q.has_attachment = Some(true)),
            "UID SEARCH HEADER Content-Type \"multipart/mixed\""
        );
    }

    #[test]
    fn search_text_cannot_add_to_the_command() {
        // A quote and a backslash stay inside the string.
        assert_eq!(
            one_line(|q| q.subject = Some(r#"say "hi" \ bye"#.into())),
            r#"UID SEARCH SUBJECT "say \"hi\" \\ bye""#
        );
        // A line break would start a second command.
        assert_eq!(
            query(|q| q.text = Some("x\r\nA1 DELETE INBOX".into()))
                .unwrap_err()
                .kind,
            "input"
        );
        assert_eq!(
            query(|q| q.keyword = Some("work) DELETED (".into()))
                .unwrap_err()
                .kind,
            "input"
        );
        assert_eq!(
            query(|q| q.since = Some("2026-13-01".into()))
                .unwrap_err()
                .kind,
            "input"
        );
        assert_eq!(
            query(|q| q.since = Some("1 OR ALL".into()))
                .unwrap_err()
                .kind,
            "input"
        );
    }

    // A quoted string is 7-bit. A strict server answers BAD to one that is
    // not, so other scripts go as literals: a byte count, then the bytes.
    #[test]
    fn a_search_in_another_script_is_sent_as_a_literal() {
        assert_eq!(
            query(|q| q.text = Some("réunion".into())).unwrap(),
            vec!["UID SEARCH CHARSET UTF-8 TEXT {8}", "réunion"]
        );
        // The count is bytes, not letters, and plain text stays quoted.
        assert_eq!(
            query(|q| {
                q.subject = Some("東京".into());
                q.from = Some("zoe".into());
                q.to = Some("renée".into());
                q.unseen = Some(true);
            })
            .unwrap(),
            vec![
                "UID SEARCH CHARSET UTF-8 SUBJECT {6}",
                "東京 FROM \"zoe\" OR TO {6}",
                "renée CC {6}",
                "renée UNSEEN",
            ]
        );
    }

    #[test]
    fn reads_the_message_id_out_of_a_header_block() {
        let message = b"From: ada@example.com\r\nMessage-ID:\r\n <n1@example.com>\r\nSubject: x\r\n\r\nMessage-ID: <body@example.com>\r\n";
        assert_eq!(message_id_of(message).as_deref(), Some("<n1@example.com>"));
        assert_eq!(
            message_id_of(b"message-id: <lower@example.com>\nTo: x\n\nbody").as_deref(),
            Some("<lower@example.com>")
        );
        assert_eq!(message_id_of(b"Subject: none\r\n\r\nbody"), None);
    }

    #[test]
    fn folder_names_survive_the_imap_encoding() {
        for name in ["INBOX", "Entwürfe", "Отправленные", "Clients/Acme & Sons"] {
            assert_eq!(decode_name(&encode_name(name)), name);
        }
        assert_eq!(encode_name("Entwürfe"), "Entw&APw-rfe");
    }

    #[test]
    fn only_atoms_are_written_into_a_store_command() {
        for ok in ["\\Seen", "\\Flagged", "$label1", "work", "NonJunk"] {
            assert!(valid_flag(ok), "{ok}");
        }
        for bad in [
            "",
            "\\",
            "two words",
            "a)b",
            "x\r\nA1 LOGOUT",
            "wild*",
            "q\"uote",
            "\\\\Seen",
        ] {
            assert!(!valid_flag(bad), "{bad:?}");
        }
    }

    #[test]
    fn a_bad_flag_stops_the_whole_change() {
        assert!(flag_list(&["\\Seen".into(), "a b".into()]).is_err());
        assert_eq!(flag_list(&[]).unwrap(), None);
        assert_eq!(
            flag_list(&["\\Seen".into(), "work".into()])
                .unwrap()
                .as_deref(),
            Some("(\\Seen work)")
        );
    }

    #[test]
    fn settings_with_a_line_break_are_refused() {
        let settings = ImapSettings {
            host: "imap.example.com".into(),
            port: 993,
            security: Security::Tls,
            username: "alice@example.com\r\nA1 LOGOUT".into(),
            password: "correct horse".into(),
            auth: Auth::Password,
            allow_local: false,
        };
        assert!(settings.validate().is_err());
    }
}
