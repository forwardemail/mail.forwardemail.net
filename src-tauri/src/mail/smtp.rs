//! Sending a message through an SMTP server.
//!
//! The webview builds the whole message and hands it over as bytes, the same
//! bytes it then saves to Sent, so nothing here writes a header. This module
//! only speaks the protocol: greeting, EHLO, STARTTLS, sign-in, envelope and
//! the message.
//!
//! One connection per message. A send is never repeated on its own: once the
//! message has been handed over and the answer is lost, the caller is told
//! the outcome is unknown, because sending again could deliver it twice.

use std::time::Duration;

use base64::Engine;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;

use super::error::MailError;
use super::imap::{Auth, ImapSettings, Security};
use super::net;

/// An outgoing server is described by the same fields as an incoming one.
pub type SmtpSettings = ImapSettings;

const REPLY_TIMEOUT: Duration = Duration::from_secs(60);
/// Servers scan a message before they answer, so the last reply gets longer.
const ACCEPT_TIMEOUT: Duration = Duration::from_secs(300);
const WRITE_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_REPLY_LINES: usize = 64;
const MAX_LINE: u64 = 2048;
pub const MAX_RECIPIENTS: usize = 500;

#[derive(Debug)]
pub(super) struct Reply {
    pub(super) code: u16,
    lines: Vec<String>,
}

impl Reply {
    fn text(&self) -> String {
        self.lines.join(" ")
    }

    /// The server said no. 5xx will not change on a retry, 4xx might.
    fn refusal(&self) -> MailError {
        let kind = match self.code {
            530 | 534 | 535 | 538 => "auth",
            500..=599 => "rejected",
            _ => "busy",
        };
        MailError::new(kind, format!("{} {}", self.code, self.text()))
    }
}

#[derive(Debug, Default, PartialEq)]
pub(super) struct Capabilities {
    starttls: bool,
    auth_plain: bool,
    auth_login: bool,
    auth_xoauth2: bool,
    /// The largest message the server takes, when it says.
    size: Option<u64>,
    smtputf8: bool,
    eight_bit: bool,
}

impl Capabilities {
    fn from_ehlo(reply: &Reply) -> Self {
        let mut caps = Capabilities::default();
        // The first line is the server's name.
        for line in reply.lines.iter().skip(1) {
            let upper = line.to_ascii_uppercase();
            let mut words = upper.split([' ', '=']).filter(|w| !w.is_empty());
            match words.next() {
                Some("STARTTLS") => caps.starttls = true,
                Some("SMTPUTF8") => caps.smtputf8 = true,
                Some("8BITMIME") => caps.eight_bit = true,
                Some("SIZE") => caps.size = words.next().and_then(|n| n.parse().ok()),
                Some("AUTH") => {
                    for mechanism in words {
                        match mechanism {
                            "PLAIN" => caps.auth_plain = true,
                            "LOGIN" => caps.auth_login = true,
                            "XOAUTH2" => caps.auth_xoauth2 = true,
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }
        caps
    }
}

pub(super) struct Conn<S> {
    io: BufReader<S>,
}

impl<S: AsyncRead + AsyncWrite + Unpin> Conn<S> {
    pub(super) fn new(stream: S) -> Self {
        Self {
            io: BufReader::new(stream),
        }
    }

    async fn read_reply(&mut self, limit: Duration) -> Result<Reply, MailError> {
        tokio::time::timeout(limit, self.read_reply_lines())
            .await
            .map_err(|_| MailError::timeout("waiting for the server"))?
    }

    async fn read_reply_lines(&mut self) -> Result<Reply, MailError> {
        let mut lines = Vec::new();
        loop {
            let mut raw = Vec::new();
            let read = (&mut self.io)
                .take(MAX_LINE + 1)
                .read_until(b'\n', &mut raw)
                .await?;
            if read == 0 {
                return Err(MailError::new("closed", "The server closed the connection"));
            }
            if raw.last() != Some(&b'\n') {
                return Err(MailError::new(
                    "server",
                    "The server sent a line that is too long",
                ));
            }
            let line = String::from_utf8_lossy(&raw);
            let line = line.trim_end_matches(['\r', '\n']);
            let code = line
                .get(..3)
                .filter(|digits| digits.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|digits| digits.parse::<u16>().ok())
                .ok_or_else(|| {
                    MailError::new("server", "The server sent an answer that is not SMTP")
                })?;
            let more = line.as_bytes().get(3) == Some(&b'-');
            lines.push(line.get(4..).unwrap_or("").to_string());
            if !more {
                return Ok(Reply { code, lines });
            }
            if lines.len() >= MAX_REPLY_LINES {
                return Err(MailError::new(
                    "server",
                    "The server sent an answer that is too long",
                ));
            }
        }
    }

    async fn write(&mut self, bytes: &[u8]) -> Result<(), MailError> {
        let io = self.io.get_mut();
        tokio::time::timeout(WRITE_TIMEOUT, async {
            io.write_all(bytes).await?;
            io.flush().await
        })
        .await
        .map_err(|_| MailError::timeout("sending to the server"))?
        .map_err(MailError::from)
    }

    pub(super) async fn command(&mut self, line: &str) -> Result<Reply, MailError> {
        self.write(format!("{line}\r\n").as_bytes()).await?;
        self.read_reply(REPLY_TIMEOUT).await
    }

    /// The stream back, to upgrade it to TLS. Anything the server sent after
    /// its go-ahead arrived before encryption, so it is not trusted and the
    /// connection is dropped.
    pub(super) fn into_inner(self) -> Result<S, MailError> {
        if !self.io.buffer().is_empty() {
            return Err(MailError::new(
                "tls",
                "The server sent data before the connection was secured",
            ));
        }
        Ok(self.io.into_inner())
    }
}

pub(super) async fn greeting<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut Conn<S>,
) -> Result<(), MailError> {
    let reply = conn.read_reply(REPLY_TIMEOUT).await?;
    if reply.code != 220 {
        return Err(reply.refusal());
    }
    Ok(())
}

pub(super) async fn ehlo<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut Conn<S>,
) -> Result<Capabilities, MailError> {
    // An address literal instead of this computer's name, which is nobody's
    // business and often not a valid host name anyway.
    let reply = conn.command("EHLO [127.0.0.1]").await?;
    if reply.code != 250 {
        return Err(reply.refusal());
    }
    Ok(Capabilities::from_ehlo(&reply))
}

fn b64(value: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(value)
}

pub(super) async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut Conn<S>,
    caps: &Capabilities,
    username: &str,
    password: &str,
    auth: Auth,
) -> Result<(), MailError> {
    let wrong = |reply: &Reply| MailError::new("auth", format!("{} {}", reply.code, reply.text()));
    if auth == Auth::Xoauth2 {
        if !caps.auth_xoauth2 {
            return Err(MailError::new(
                "unsupported",
                "The server does not offer sign-in with a token",
            ));
        }
        let token = b64(super::oauth::xoauth2(username, password).as_bytes());
        let mut reply = conn.command(&format!("AUTH XOAUTH2 {token}")).await?;
        // A refusal comes as an explanation first, which wants an empty
        // answer before the server says no.
        if reply.code == 334 {
            reply = conn.command("").await?;
        }
        return if reply.code == 235 {
            Ok(())
        } else {
            Err(wrong(&reply))
        };
    }
    if caps.auth_plain {
        let token = b64(format!("\0{username}\0{password}").as_bytes());
        let reply = conn.command(&format!("AUTH PLAIN {token}")).await?;
        return if reply.code == 235 {
            Ok(())
        } else {
            Err(wrong(&reply))
        };
    }
    if caps.auth_login {
        let reply = conn.command("AUTH LOGIN").await?;
        if reply.code != 334 {
            return Err(wrong(&reply));
        }
        let reply = conn.command(&b64(username.as_bytes())).await?;
        if reply.code != 334 {
            return Err(wrong(&reply));
        }
        let reply = conn.command(&b64(password.as_bytes())).await?;
        return if reply.code == 235 {
            Ok(())
        } else {
            Err(wrong(&reply))
        };
    }
    Err(MailError::new(
        "unsupported",
        "The server does not offer sign-in with a password",
    ))
}

/// An address that can go inside the angle brackets of MAIL FROM or RCPT TO.
/// A space, a bracket or a line break would change the command.
pub fn valid_address(address: &str) -> bool {
    !address.is_empty()
        && address.len() <= 320
        && address.contains('@')
        && !address
            .chars()
            .any(|c| c.is_control() || c.is_whitespace() || c == '<' || c == '>')
}

/// The message as it goes on the wire: every line ends CRLF, and a line that
/// starts with a dot gets a second one so it cannot end the message early.
fn wire_body(message: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(message.len() + message.len() / 40 + 8);
    let mut at_line_start = true;
    let mut bytes = message.iter().copied().peekable();
    while let Some(byte) = bytes.next() {
        match byte {
            b'\r' | b'\n' => {
                if byte == b'\r' && bytes.peek() == Some(&b'\n') {
                    bytes.next();
                }
                out.extend_from_slice(b"\r\n");
                at_line_start = true;
            }
            _ => {
                if at_line_start && byte == b'.' {
                    out.push(b'.');
                }
                out.push(byte);
                at_line_start = false;
            }
        }
    }
    if !at_line_start {
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b".\r\n");
    out
}

pub(super) async fn deliver<S: AsyncRead + AsyncWrite + Unpin>(
    conn: &mut Conn<S>,
    caps: &Capabilities,
    from: &str,
    recipients: &[String],
    message: &[u8],
) -> Result<(), MailError> {
    if !valid_address(from) {
        return Err(MailError::input("The From address is not valid"));
    }
    if recipients.is_empty() || recipients.len() > MAX_RECIPIENTS {
        return Err(MailError::input(
            "The message has no recipients or too many",
        ));
    }
    if let Some(index) = recipients.iter().position(|r| !valid_address(r)) {
        return Err(MailError::recipient(index, "That address is not valid"));
    }
    if message.is_empty() {
        return Err(MailError::input("The message is empty"));
    }
    if caps
        .size
        .is_some_and(|max| max > 0 && message.len() as u64 > max)
    {
        return Err(MailError::new(
            "rejected",
            "The message is larger than the server accepts",
        ));
    }

    let mut mail = format!("MAIL FROM:<{from}>");
    if caps.size.is_some() {
        mail.push_str(&format!(" SIZE={}", message.len()));
    }
    if caps.eight_bit && !message.is_ascii() {
        mail.push_str(" BODY=8BITMIME");
    }
    if !from.is_ascii() || recipients.iter().any(|r| !r.is_ascii()) {
        if !caps.smtputf8 {
            return Err(MailError::new(
                "rejected",
                "The server does not accept addresses with non-English letters",
            ));
        }
        mail.push_str(" SMTPUTF8");
    }
    let reply = conn.command(&mail).await?;
    if reply.code != 250 {
        return Err(reply.refusal());
    }

    // One refused recipient stops the whole message. Sending to the rest
    // would leave the writer believing everyone got it.
    for (index, recipient) in recipients.iter().enumerate() {
        let reply = conn.command(&format!("RCPT TO:<{recipient}>")).await?;
        if reply.code != 250 && reply.code != 251 {
            let _ = conn.command("RSET").await;
            return Err(MailError::recipient(
                index,
                format!("{} {}", reply.code, reply.text()),
            ));
        }
    }

    let reply = conn.command("DATA").await?;
    if reply.code != 354 {
        return Err(reply.refusal());
    }

    // From here the server may have the message even if we never hear back.
    let unconfirmed = |err: MailError| {
        if err.is_connection() {
            MailError::new(
                "unconfirmed",
                "The server did not confirm the message. It may have been sent.",
            )
        } else {
            err
        }
    };
    conn.write(&wire_body(message)).await.map_err(unconfirmed)?;
    let reply = conn.read_reply(ACCEPT_TIMEOUT).await.map_err(unconfirmed)?;
    if reply.code != 250 {
        return Err(reply.refusal());
    }
    Ok(())
}

async fn quit<S: AsyncRead + AsyncWrite + Unpin>(conn: &mut Conn<S>) {
    let _ = tokio::time::timeout(Duration::from_secs(5), conn.command("QUIT")).await;
}

/// Connect, secure the connection and sign in.
async fn open(
    settings: &SmtpSettings,
) -> Result<(Conn<TlsStream<TcpStream>>, Capabilities), MailError> {
    settings.validate()?;
    let host = settings.host.trim();
    let (mut conn, caps) = match settings.security {
        Security::Tls => {
            let stream = net::connect_tls(host, settings.port, settings.allow_local).await?;
            let mut conn = Conn::new(stream);
            greeting(&mut conn).await?;
            let caps = ehlo(&mut conn).await?;
            (conn, caps)
        }
        Security::Starttls => {
            let stream = net::connect_plain(host, settings.port, settings.allow_local).await?;
            let mut plain = Conn::new(stream);
            greeting(&mut plain).await?;
            // The password is never sent on a connection that stayed plain.
            if !ehlo(&mut plain).await?.starttls {
                return Err(MailError::new("tls", "The server does not offer STARTTLS"));
            }
            let reply = plain.command("STARTTLS").await?;
            if reply.code != 220 {
                return Err(MailError::new(
                    "tls",
                    format!(
                        "The server refused STARTTLS: {} {}",
                        reply.code,
                        reply.text()
                    ),
                ));
            }
            let stream = net::upgrade(host, plain.into_inner()?).await?;
            let mut conn = Conn::new(stream);
            // What the server offered before TLS could have been tampered
            // with, so ask again.
            let caps = ehlo(&mut conn).await?;
            (conn, caps)
        }
    };
    authenticate(
        &mut conn,
        &caps,
        &settings.username,
        &settings.password,
        settings.auth,
    )
    .await?;
    Ok((conn, caps))
}

/// Sign in and out again, to check settings before they are saved.
pub async fn test(settings: &SmtpSettings) -> Result<(), MailError> {
    let (mut conn, _) = open(settings).await?;
    quit(&mut conn).await;
    Ok(())
}

pub async fn send(
    settings: &SmtpSettings,
    from: &str,
    recipients: &[String],
    message: &[u8],
) -> Result<(), MailError> {
    let (mut conn, caps) = open(settings).await?;
    let result = deliver(&mut conn, &caps, from, recipients, message).await;
    if result.is_ok() {
        quit(&mut conn).await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::DuplexStream;

    /// A server that follows a script. Each step waits for one line from the
    /// client (or, after the DATA go-ahead, for the whole message) and sends
    /// the reply. Returns everything the client sent.
    async fn serve(mut io: DuplexStream, greeting: &str, replies: Vec<&str>) -> String {
        let mut seen = Vec::new();
        io.write_all(greeting.as_bytes()).await.unwrap();
        let mut in_data = false;
        for reply in replies {
            let end: &[u8] = if in_data { b"\r\n.\r\n" } else { b"\r\n" };
            let start = seen.len();
            while !seen[start..].ends_with(end) {
                let mut byte = [0u8; 1];
                if io.read_exact(&mut byte).await.is_err() {
                    return String::from_utf8_lossy(&seen).into_owned();
                }
                seen.push(byte[0]);
            }
            in_data = reply.starts_with("354");
            if reply.is_empty() {
                // Hang up without answering.
                break;
            }
            io.write_all(reply.as_bytes()).await.unwrap();
        }
        drop(io);
        String::from_utf8_lossy(&seen).into_owned()
    }

    fn run<F: std::future::Future>(fut: F) -> F::Output {
        tauri::async_runtime::block_on(fut)
    }

    fn all_caps() -> Capabilities {
        Capabilities {
            auth_plain: true,
            size: Some(1000),
            ..Capabilities::default()
        }
    }

    fn to(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_what_the_server_offers() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(
                server,
                "220 mx.example.net ESMTP ready\r\n",
                vec!["250-mx.example.net\r\n250-SIZE 52428800\r\n250-8BITMIME\r\n250-STARTTLS\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8\r\n"],
            ));
            let mut conn = Conn::new(client);
            greeting(&mut conn).await.unwrap();
            let caps = ehlo(&mut conn).await.unwrap();
            assert_eq!(
                caps,
                Capabilities {
                    starttls: true,
                    auth_plain: true,
                    auth_login: true,
                    auth_xoauth2: false,
                    size: Some(52_428_800),
                    smtputf8: true,
                    eight_bit: true,
                }
            );
            drop(conn);
            assert_eq!(script.await.unwrap(), "EHLO [127.0.0.1]\r\n");
        });
    }

    #[test]
    fn a_server_that_is_not_ready_is_an_error() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            tokio::spawn(serve(server, "554 no service for you\r\n", vec![]));
            let mut conn = Conn::new(client);
            let err = greeting(&mut conn).await.unwrap_err();
            assert_eq!(err.kind, "rejected");
        });
    }

    #[test]
    fn signs_in_with_plain() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(server, "", vec!["235 2.7.0 accepted\r\n"]));
            let mut conn = Conn::new(client);
            authenticate(&mut conn, &all_caps(), "ada", "s3cret", Auth::Password)
                .await
                .unwrap();
            drop(conn);
            // base64 of "\0ada\0s3cret"
            assert_eq!(script.await.unwrap(), "AUTH PLAIN AGFkYQBzM2NyZXQ=\r\n");
        });
    }

    #[test]
    fn signs_in_with_login_when_plain_is_not_offered() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(
                server,
                "",
                vec!["334 VXNlcm5hbWU6\r\n", "334 UGFzc3dvcmQ6\r\n", "235 ok\r\n"],
            ));
            let caps = Capabilities {
                auth_login: true,
                ..Capabilities::default()
            };
            let mut conn = Conn::new(client);
            authenticate(&mut conn, &caps, "ada", "s3cret", Auth::Password)
                .await
                .unwrap();
            drop(conn);
            assert_eq!(script.await.unwrap(), "AUTH LOGIN\r\nYWRh\r\nczNjcmV0\r\n");
        });
    }

    #[test]
    fn a_wrong_password_is_an_auth_error() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            tokio::spawn(serve(
                server,
                "",
                vec!["535 5.7.8 authentication failed\r\n"],
            ));
            let mut conn = Conn::new(client);
            let err = authenticate(&mut conn, &all_caps(), "ada", "nope", Auth::Password)
                .await
                .unwrap_err();
            assert_eq!(err.kind, "auth");
            assert!(!err.message.contains("nope"));
        });
    }

    #[test]
    fn signs_in_with_a_token() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(server, "", vec!["235 2.7.0 accepted\r\n"]));
            let caps = Capabilities {
                auth_plain: true,
                auth_xoauth2: true,
                ..Capabilities::default()
            };
            let mut conn = Conn::new(client);
            authenticate(
                &mut conn,
                &caps,
                "ada@example.com",
                "ya29.a0",
                Auth::Xoauth2,
            )
            .await
            .unwrap();
            drop(conn);
            // base64 of "user=ada@example.com^Aauth=Bearer ya29.a0^A^A"
            assert_eq!(
                script.await.unwrap(),
                "AUTH XOAUTH2 dXNlcj1hZGFAZXhhbXBsZS5jb20BYXV0aD1CZWFyZXIgeWEyOS5hMAEB\r\n"
            );
        });
    }

    #[test]
    fn a_refused_token_is_an_auth_error_after_the_servers_explanation() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(
                server,
                "",
                vec![
                    "334 eyJzdGF0dXMiOiI0MDEifQ==\r\n",
                    "535 5.7.8 Username and Password not accepted\r\n",
                ],
            ));
            let caps = Capabilities {
                auth_xoauth2: true,
                ..Capabilities::default()
            };
            let mut conn = Conn::new(client);
            let err = authenticate(
                &mut conn,
                &caps,
                "ada@example.com",
                "expired",
                Auth::Xoauth2,
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind, "auth");
            drop(conn);
            assert!(script.await.unwrap().ends_with("AEB\r\n\r\n"));
        });
    }

    #[test]
    fn a_token_is_never_sent_as_a_password() {
        run(async {
            let (client, _server) = tokio::io::duplex(4096);
            let mut conn = Conn::new(client);
            // The server offers passwords only.
            let err = authenticate(&mut conn, &all_caps(), "ada", "ya29.a0", Auth::Xoauth2)
                .await
                .unwrap_err();
            assert_eq!(err.kind, "unsupported");
        });
    }

    #[test]
    fn no_password_mechanism_is_not_reported_as_a_wrong_password() {
        run(async {
            let (client, _server) = tokio::io::duplex(4096);
            let mut conn = Conn::new(client);
            let err = authenticate(
                &mut conn,
                &Capabilities::default(),
                "ada",
                "s3cret",
                Auth::Password,
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind, "unsupported");
        });
    }

    #[test]
    fn hands_over_the_envelope_and_the_message() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(
                server,
                "",
                vec![
                    "250 ok\r\n",
                    "250 ok\r\n",
                    "250 ok\r\n",
                    "354 go ahead\r\n",
                    "250 2.0.0 queued as 4F2A\r\n",
                ],
            ));
            let mut conn = Conn::new(client);
            let message =
                b"Subject: Lunch\nTo: bob@example.org\n\nSee you at noon.\n.hidden line\n..";
            deliver(
                &mut conn,
                &all_caps(),
                "ada@example.com",
                &to(&["bob@example.org", "carol@example.org"]),
                message,
            )
            .await
            .unwrap();
            drop(conn);
            assert_eq!(
                script.await.unwrap(),
                concat!(
                    "MAIL FROM:<ada@example.com> SIZE=68\r\n",
                    "RCPT TO:<bob@example.org>\r\n",
                    "RCPT TO:<carol@example.org>\r\n",
                    "DATA\r\n",
                    "Subject: Lunch\r\n",
                    "To: bob@example.org\r\n",
                    "\r\n",
                    "See you at noon.\r\n",
                    "..hidden line\r\n",
                    "...\r\n",
                    ".\r\n",
                )
            );
        });
    }

    #[test]
    fn a_refused_recipient_stops_the_message() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            let script = tokio::spawn(serve(
                server,
                "",
                vec![
                    "250 ok\r\n",
                    "250 ok\r\n",
                    "550 5.1.1 no such user\r\n",
                    "250 reset\r\n",
                ],
            ));
            let mut conn = Conn::new(client);
            let err = deliver(
                &mut conn,
                &all_caps(),
                "ada@example.com",
                &to(&["bob@example.org", "nobody@example.org"]),
                b"Subject: Hi\r\n\r\nHello\r\n",
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind, "recipient");
            assert_eq!(err.recipient, Some(1));
            drop(conn);
            let sent = script.await.unwrap();
            assert!(sent.ends_with("RSET\r\n"), "{sent}");
            assert!(!sent.contains("DATA"), "{sent}");
        });
    }

    #[test]
    fn a_lost_answer_after_the_message_is_unconfirmed() {
        run(async {
            let (client, server) = tokio::io::duplex(4096);
            tokio::spawn(serve(
                server,
                "",
                vec!["250 ok\r\n", "250 ok\r\n", "354 go ahead\r\n", ""],
            ));
            let mut conn = Conn::new(client);
            let err = deliver(
                &mut conn,
                &all_caps(),
                "ada@example.com",
                &to(&["bob@example.org"]),
                b"Subject: Hi\r\n\r\nHello\r\n",
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind, "unconfirmed");
        });
    }

    #[test]
    fn a_message_over_the_server_limit_is_not_sent() {
        run(async {
            let (client, _server) = tokio::io::duplex(4096);
            let mut conn = Conn::new(client);
            let err = deliver(
                &mut conn,
                &all_caps(),
                "ada@example.com",
                &to(&["bob@example.org"]),
                &vec![b'a'; 1001],
            )
            .await
            .unwrap_err();
            assert_eq!(err.kind, "rejected");
        });
    }

    #[test]
    fn an_address_cannot_carry_a_second_command() {
        assert!(valid_address("ada@example.com"));
        assert!(valid_address("jos\u{e9}@example.com"));
        for bad in [
            "",
            "ada",
            "ada@example.com>\r\nRCPT TO:<eve@example.net",
            "ada@example.com> SIZE=1",
            "ada @example.com",
            "<ada@example.com>",
        ] {
            assert!(!valid_address(bad), "{bad}");
        }
    }

    #[test]
    fn data_sent_before_tls_is_not_trusted() {
        run(async {
            let (client, mut server) = tokio::io::duplex(4096);
            // A go-ahead with a forged answer to the next command behind it.
            server
                .write_all(b"220 go ahead\r\n250 AUTH PLAIN\r\n")
                .await
                .unwrap();
            let mut conn = Conn::new(client);
            let reply = conn.read_reply(REPLY_TIMEOUT).await.unwrap();
            assert_eq!(reply.code, 220);
            assert_eq!(conn.into_inner().err().map(|e| e.kind), Some("tls"));
        });
    }

    #[test]
    fn an_endless_line_is_cut_off() {
        run(async {
            let (client, mut server) = tokio::io::duplex(8192);
            server.write_all(&vec![b'2'; 4000]).await.unwrap();
            let mut conn = Conn::new(client);
            let err = conn.read_reply(REPLY_TIMEOUT).await.unwrap_err();
            assert_eq!(err.kind, "server");
        });
    }
}
