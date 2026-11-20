//! Mail engine for accounts on a custom IMAP server
//! (docs/custom-imap-smtp-architecture.md).
//!
//! The webview can use these commands to open a TLS connection to a mail
//! server and act on a mailbox, so they are kept narrow:
//!
//! - a release build refuses all of them unless it was compiled with
//!   FE_CUSTOM_MAIL=1
//! - only the main window may call them; the compose windows and anything
//!   else are refused
//! - only `mail_test` and `mail_open` take a server name. Every other command
//!   takes a handle this module issued, and a handle cannot be pointed at
//!   another server. `mail_autoconfig` takes an email address and asks only
//!   the places autoconfig.rs builds from its domain
//! - sign-in attempts and sends are rate limited
//! - no command returns a password

mod autoconfig;
mod error;
mod imap;
mod lean;
#[cfg(test)]
mod live;
mod net;
mod oauth;
mod smtp;
mod watch;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use tauri::{State, WebviewWindow};
use tokio::sync::Mutex;

pub use error::MailError;
use imap::{ImapSettings, Session};

const MAX_ACCOUNTS: usize = 16;
const SIGN_INS_PER_MINUTE: usize = 12;
const SENDS_PER_MINUTE: usize = 30;
const LOOKUPS_PER_MINUTE: usize = 10;
/// A message larger than this is not appended from the webview in one call.
const MAX_APPEND_BYTES: usize = 64 * 1024 * 1024;

struct Account {
    settings: ImapSettings,
    /// One connection, used by one command at a time. None after a dropped
    /// connection; the next command signs in again.
    session: Mutex<Option<Session>>,
    /// A second connection for whole messages and attachments, opened the
    /// first time one is asked for. A download can run for minutes; on the
    /// one connection it held up every list, flag change and move behind it.
    downloads: Mutex<Option<Session>>,
    /// Whether the server counts changes to a folder, once that is known.
    counter: imap::ChangeCounter,
    /// The task parked on the inbox (watch.rs), once the app asks for one.
    watcher: StdMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Account {
    fn stop_watching(&self) {
        let task = self
            .watcher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(task) = task {
            task.abort();
        }
    }
}

#[derive(Default)]
pub struct MailState {
    accounts: Mutex<HashMap<String, Arc<Account>>>,
    /// Outgoing servers, by handle. A send connects, sends and disconnects,
    /// so only the settings are kept.
    senders: Mutex<HashMap<String, Arc<smtp::SmtpSettings>>>,
    sign_ins: StdMutex<VecDeque<Instant>>,
    sends: StdMutex<VecDeque<Instant>>,
    lookups: StdMutex<VecDeque<Instant>>,
    counter: AtomicU64,
    /// Held while a sign-in page is open, so there is one at a time.
    signing_in: Mutex<()>,
}

/// Count one more event in the last minute, or refuse it.
fn allow(
    recent: &StdMutex<VecDeque<Instant>>,
    per_minute: usize,
    refusal: &str,
) -> Result<(), MailError> {
    let mut recent = recent.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    while recent
        .front()
        .is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60))
    {
        recent.pop_front();
    }
    if recent.len() >= per_minute {
        return Err(MailError::new("rate", refusal));
    }
    recent.push_back(now);
    Ok(())
}

impl MailState {
    fn note_sign_in(&self) -> Result<(), MailError> {
        allow(
            &self.sign_ins,
            SIGN_INS_PER_MINUTE,
            "Too many sign-in attempts. Wait a minute and try again.",
        )
    }

    fn note_send(&self) -> Result<(), MailError> {
        allow(
            &self.sends,
            SENDS_PER_MINUTE,
            "Too many messages in a minute. Wait a moment and try again.",
        )
    }

    fn new_handle(&self) -> String {
        let n = self.counter.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("mail-{n}-{nanos:x}")
    }

    async fn account(&self, handle: &str) -> Result<Arc<Account>, MailError> {
        self.accounts
            .lock()
            .await
            .get(handle)
            .cloned()
            .ok_or_else(|| MailError::new("handle", "This account is not connected"))
    }
}

/// Whether a build has the engine switched on. A release build has it off
/// unless it was compiled with FE_CUSTOM_MAIL=1, so the commands refuse every
/// caller until custom servers are released on purpose. The answer is fixed
/// when the app is compiled and nothing the webview says can change it.
fn enabled_for(debug_build: bool, flag: Option<&str>) -> bool {
    debug_build || flag == Some("1")
}

fn engine_enabled() -> bool {
    enabled_for(cfg!(debug_assertions), option_env!("FE_CUSTOM_MAIL"))
}

fn main_only(window: &WebviewWindow) -> Result<(), MailError> {
    if !engine_enabled() {
        return Err(MailError::new(
            "disabled",
            "Custom mail servers are not available in this version",
        ));
    }
    if window.label() == "main" {
        Ok(())
    } else {
        Err(MailError::new(
            "forbidden",
            "Mail commands are only available to the main window",
        ))
    }
}

/// Lets the app decide whether to offer a custom server at all.
#[tauri::command]
pub fn mail_enabled(window: WebviewWindow) -> bool {
    main_only(&window).is_ok()
}

/// Run one operation on the account's connection. A connection that has gone
/// away is replaced and the operation tried once more; every operation here
/// is safe to repeat.
macro_rules! with_session {
    ($account:expr, |$session:ident| $body:expr) => {
        with_session!(@on $account.session, $account, |$session| $body)
    };
    // The same, on the connection kept for downloads.
    (downloads $account:expr, |$session:ident| $body:expr) => {
        with_session!(@on $account.downloads, $account, |$session| $body)
    };
    (@on $connection:expr, $account:expr, |$session:ident| $body:expr) => {{
        let mut guard = $connection.lock().await;
        let mut retried = false;
        loop {
            if guard.is_none() {
                *guard = Some(imap::login(&$account.settings).await?);
            }
            let $session = guard.as_mut().expect("session was just set");
            match $body.await {
                Ok(value) => break Ok(value),
                Err(err) => {
                    let err: MailError = err;
                    if err.is_connection() {
                        *guard = None;
                        if !retried {
                            retried = true;
                            continue;
                        }
                    }
                    break Err(err);
                }
            }
        }
    }};
}

/// Suggest IMAP and SMTP settings for an address. Answers with nothing when
/// none are published; that is not an error.
#[tauri::command]
pub async fn mail_autoconfig(
    window: WebviewWindow,
    state: State<'_, MailState>,
    email: String,
) -> Result<Option<autoconfig::Found>, MailError> {
    main_only(&window)?;
    if autoconfig::split_address(&email).is_none() {
        return Err(MailError::input("Enter your full email address first"));
    }
    allow(
        &state.lookups,
        LOOKUPS_PER_MINUTE,
        "Too many lookups. Wait a minute and try again.",
    )?;
    Ok(autoconfig::find(&email, &autoconfig::Live::new()).await)
}

/// The providers this build can sign in with through their own sign-in page.
#[tauri::command]
pub fn oauth_providers(window: WebviewWindow) -> Result<Vec<&'static str>, MailError> {
    main_only(&window)?;
    Ok(oauth::available())
}

/// Open a provider's sign-in page in the user's browser and wait for them to
/// finish. Answers with the tokens and the address that signed in.
#[tauri::command]
pub async fn oauth_sign_in(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, MailState>,
    provider: String,
) -> Result<oauth::Tokens, MailError> {
    use tauri_plugin_opener::OpenerExt;

    main_only(&window)?;
    let provider = oauth::provider(&provider)
        .ok_or_else(|| MailError::input("That sign-in is not available in this build"))?;
    state.note_sign_in()?;
    let _one_at_a_time = state
        .signing_in
        .try_lock()
        .map_err(|_| MailError::new("rate", "A sign-in is already open in your browser"))?;
    let pending = oauth::begin(provider).await?;
    app.opener()
        .open_url(&pending.url, None::<&str>)
        .map_err(|e| MailError::new("engine", format!("Could not open the browser: {e}")))?;
    oauth::finish(pending, oauth::SIGN_IN_TIMEOUT).await
}

/// Trade a refresh token for a new access token. Rejects with kind "auth"
/// when the refresh token no longer works.
#[tauri::command]
pub async fn oauth_refresh(
    window: WebviewWindow,
    state: State<'_, MailState>,
    provider: String,
    refresh_token: String,
) -> Result<oauth::Tokens, MailError> {
    main_only(&window)?;
    let provider = oauth::provider(&provider)
        .ok_or_else(|| MailError::input("That sign-in is not available in this build"))?;
    if refresh_token.is_empty() || refresh_token.chars().any(|c| c.is_control()) {
        return Err(MailError::input("The saved sign-in is not valid"));
    }
    state.note_sign_in()?;
    oauth::refresh(&provider, &refresh_token).await
}

/// Sign in and out again, to check settings before they are saved.
#[tauri::command]
pub async fn mail_test(
    window: WebviewWindow,
    state: State<'_, MailState>,
    imap: ImapSettings,
) -> Result<(), MailError> {
    main_only(&window)?;
    state.note_sign_in()?;
    let mut session = imap::login(&imap).await?;
    let _ = tokio::time::timeout(Duration::from_secs(5), session.logout()).await;
    Ok(())
}

/// Sign in and keep the connection. Returns the handle the other commands take.
#[tauri::command]
pub async fn mail_open(
    window: WebviewWindow,
    state: State<'_, MailState>,
    imap: ImapSettings,
) -> Result<String, MailError> {
    main_only(&window)?;
    state.note_sign_in()?;
    let session = imap::login(&imap).await?;
    let mut accounts = state.accounts.lock().await;
    if accounts.len() >= MAX_ACCOUNTS {
        return Err(MailError::new("rate", "Too many accounts are connected"));
    }
    let handle = state.new_handle();
    accounts.insert(
        handle.clone(),
        Arc::new(Account {
            settings: imap,
            session: Mutex::new(Some(session)),
            downloads: Mutex::new(None),
            counter: imap::ChangeCounter::default(),
            watcher: StdMutex::new(None),
        }),
    );
    Ok(handle)
}

/// Forget an account's connection and its password.
#[tauri::command]
pub async fn mail_close(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.accounts.lock().await.remove(&handle);
    if let Some(account) = account {
        account.stop_watching();
        for connection in [&account.session, &account.downloads] {
            if let Some(mut session) = connection.lock().await.take() {
                let _ = tokio::time::timeout(Duration::from_secs(5), session.logout()).await;
            }
        }
    }
    Ok(())
}

/// Start telling the main window when the account's inbox changes (the
/// "mail:changed" event). Safe to call again; one watcher runs per account.
#[tauri::command]
pub async fn mail_watch(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, MailState>,
    handle: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    let mut watcher = account.watcher.lock().unwrap_or_else(|e| e.into_inner());
    if watcher.is_none() {
        *watcher = Some(tauri::async_runtime::spawn(watch::run(
            app,
            handle,
            account.settings.clone(),
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn imap_folders(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
) -> Result<Vec<imap::Folder>, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::folders(s))
}

#[tauri::command]
pub async fn imap_rows(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    page: u32,
    limit: u32,
) -> Result<imap::Page, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::rows(
        s,
        &folder,
        page,
        limit,
        &account.counter
    ))
}

/// The rows of the given messages, at most a page of them.
#[tauri::command]
pub async fn imap_rows_for(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uids: Vec<u32>,
) -> Result<imap::Page, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::rows_for(s, &folder, &uids))
}

/// The UIDs of the messages in a folder that match, newest first.
#[tauri::command]
pub async fn imap_search(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    query: imap::SearchQuery,
) -> Result<imap::Found, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::search(s, &folder, &query))
}

/// The mailbox's storage limit and use, or nothing when the server sets none.
#[tauri::command]
pub async fn imap_storage(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
) -> Result<Option<imap::Storage>, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::storage(s))
}

/// What is new or changed in a folder since the change counter `since`.
/// Nothing (null) when the server keeps no counter.
#[tauri::command]
pub async fn imap_changes(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    since: String,
) -> Result<Option<imap::Changes>, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::changes(
        s,
        &folder,
        &since,
        &account.counter
    ))
}

#[tauri::command]
pub async fn imap_row(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uid: u32,
) -> Result<Option<imap::Row>, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::row(s, &folder, uid))
}

/// The whole message, as bytes. Rejects with kind "missing" when the folder
/// no longer has it.
#[tauri::command]
pub async fn imap_raw(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uid: u32,
) -> Result<tauri::ipc::Response, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    let bytes: Option<Vec<u8>> = with_session!(downloads account, |s| imap::raw(s, &folder, uid))?;
    bytes
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| MailError::new("missing", "The message is no longer on the server"))
}

/// A message to read. A small one comes whole. A large one comes without its
/// attachments, each replaced by a marker (lean.rs), and `imap_part` fetches
/// one when it is opened. Rejects with kind "missing" when it is gone.
#[tauri::command]
pub async fn imap_message(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uid: u32,
) -> Result<tauri::ipc::Response, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    let bytes: Option<Vec<u8>> = with_session!(account, |s| lean::message(s, &folder, uid))?;
    bytes
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| MailError::new("missing", "The message is no longer on the server"))
}

/// One part of a message, as bytes still in the part's transfer encoding.
#[tauri::command]
pub async fn imap_part(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uid: u32,
    section: String,
) -> Result<tauri::ipc::Response, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    let bytes: Option<Vec<u8>> =
        with_session!(downloads account, |s| lean::part(s, &folder, uid, &section))?;
    bytes
        .map(tauri::ipc::Response::new)
        .ok_or_else(|| MailError::new("missing", "The attachment is no longer on the server"))
}

#[tauri::command]
pub async fn imap_delete(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uid: u32,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::delete_message(s, &folder, uid))
}

/// The same change to the flags of several messages in one folder.
#[tauri::command]
pub async fn imap_store_many(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uids: Vec<u32>,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::store_many(
        s, &folder, &uids, &add, &remove
    ))
}

/// Move several messages out of one folder. Answers with one entry per
/// message that was there, and its new place when that could be found.
#[tauri::command]
pub async fn imap_move_many(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uids: Vec<u32>,
    destination: String,
) -> Result<Vec<imap::Moved>, MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::move_many(
        s,
        &folder,
        &uids,
        &destination
    ))
}

#[tauri::command]
pub async fn imap_delete_many(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    uids: Vec<u32>,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::delete_many(s, &folder, &uids))
}

/// Save a message into a folder. `message` is the whole message, base64.
/// Answers with where it was saved, when the server can be asked.
#[tauri::command]
pub async fn imap_append(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    folder: String,
    flags: Vec<String>,
    message: String,
) -> Result<Option<imap::Located>, MailError> {
    main_only(&window)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(message.as_bytes())
        .map_err(|_| MailError::input("The message could not be read"))?;
    if bytes.is_empty() || bytes.len() > MAX_APPEND_BYTES {
        return Err(MailError::input("The message is empty or too large"));
    }
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::append(s, &folder, &flags, &bytes))
}

#[tauri::command]
pub async fn imap_create_folder(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    path: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::create_folder(s, &path))
}

#[tauri::command]
pub async fn imap_rename_folder(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    from: String,
    to: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::rename_folder(s, &from, &to))
}

#[tauri::command]
pub async fn imap_delete_folder(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    path: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    let account = state.account(&handle).await?;
    with_session!(account, |s| imap::delete_folder(s, &path))
}

/// Sign in to an outgoing server and out again, to check settings.
#[tauri::command]
pub async fn smtp_test(
    window: WebviewWindow,
    state: State<'_, MailState>,
    smtp: smtp::SmtpSettings,
) -> Result<(), MailError> {
    main_only(&window)?;
    state.note_sign_in()?;
    smtp::test(&smtp).await
}

/// Remember an outgoing server and return the handle `smtp_send` takes. No
/// connection is made here; each send makes its own.
#[tauri::command]
pub async fn smtp_open(
    window: WebviewWindow,
    state: State<'_, MailState>,
    smtp: smtp::SmtpSettings,
) -> Result<String, MailError> {
    main_only(&window)?;
    smtp.validate()?;
    let mut senders = state.senders.lock().await;
    if senders.len() >= MAX_ACCOUNTS {
        return Err(MailError::new("rate", "Too many accounts are connected"));
    }
    let handle = state.new_handle();
    senders.insert(handle.clone(), Arc::new(smtp));
    Ok(handle)
}

/// Forget an outgoing server and its password.
#[tauri::command]
pub async fn smtp_close(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    state.senders.lock().await.remove(&handle);
    Ok(())
}

/// Send one message. `message` is the whole message, base64. `from` and
/// `recipients` are the envelope: bare addresses, Bcc included.
#[tauri::command]
pub async fn smtp_send(
    window: WebviewWindow,
    state: State<'_, MailState>,
    handle: String,
    from: String,
    recipients: Vec<String>,
    message: String,
) -> Result<(), MailError> {
    main_only(&window)?;
    let settings = state
        .senders
        .lock()
        .await
        .get(&handle)
        .cloned()
        .ok_or_else(|| MailError::new("handle", "This account is not connected"))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(message.as_bytes())
        .map_err(|_| MailError::input("The message could not be read"))?;
    if bytes.is_empty() || bytes.len() > MAX_APPEND_BYTES {
        return Err(MailError::input("The message is empty or too large"));
    }
    state.note_send()?;
    smtp::send(&settings, &from, &recipients, &bytes).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_ins_are_limited_per_minute() {
        let state = MailState::default();
        for _ in 0..SIGN_INS_PER_MINUTE {
            assert!(state.note_sign_in().is_ok());
        }
        assert_eq!(state.note_sign_in().unwrap_err().kind, "rate");
    }

    #[test]
    fn an_old_attempt_stops_counting() {
        let state = MailState::default();
        {
            let mut recent = state.sign_ins.lock().unwrap();
            for _ in 0..SIGN_INS_PER_MINUTE {
                recent.push_back(Instant::now() - Duration::from_secs(61));
            }
        }
        assert!(state.note_sign_in().is_ok());
    }

    #[test]
    fn sends_are_limited_per_minute() {
        let state = MailState::default();
        for _ in 0..SENDS_PER_MINUTE {
            assert!(state.note_send().is_ok());
        }
        assert_eq!(state.note_send().unwrap_err().kind, "rate");
        // Sign-ins are counted on their own.
        assert!(state.note_sign_in().is_ok());
    }

    #[test]
    fn a_release_build_has_the_engine_off_until_it_is_asked_for() {
        assert!(!enabled_for(false, None));
        assert!(enabled_for(false, Some("1")));
        // Anything but the exact value leaves it off.
        assert!(!enabled_for(false, Some("")));
        assert!(!enabled_for(false, Some("0")));
        assert!(!enabled_for(false, Some("true")));
        // A debug build always has it, so development needs no setting.
        assert!(enabled_for(true, None));
    }

    #[test]
    fn handles_are_not_reused() {
        let state = MailState::default();
        assert_ne!(state.new_handle(), state.new_handle());
    }

    #[test]
    fn an_error_message_is_redacted() {
        let err = MailError::new("auth", "LOGIN failed for alice@example.com");
        assert!(!err.message.contains("alice@example.com"));
    }
}
