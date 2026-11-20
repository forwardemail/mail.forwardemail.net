//! Signing in with a provider's own sign-in page (OAuth 2.0).
//!
//! Gmail and Microsoft 365 do not take a password over IMAP. The user signs
//! in on the provider's page in their own browser, and the app is handed
//! tokens: a short-lived one that signs in to IMAP and SMTP, and a long-lived
//! one that gets the next short-lived one.
//!
//! This is the flow for an app that cannot keep a secret (RFC 8252): the
//! browser is sent back to a port this app listens on, on this computer only,
//! and a one-time value made here (PKCE) proves the app that finishes the
//! sign-in is the one that started it.
//!
//! The webview names a provider and nothing else. Where its pages and token
//! server are, and what is asked for, is fixed here, so these commands cannot
//! be pointed at another server.

use std::time::Duration;

use base64::Engine;
use ring::rand::SecureRandom;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::error::MailError;
use super::net;

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the user has to finish signing in before the port is closed.
pub const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const MAX_ANSWER: usize = 256 * 1024;

#[derive(Clone)]
pub struct Provider {
    /// The page the browser is sent to.
    authorize_url: String,
    /// Where a code or a refresh token is exchanged for tokens.
    token_host: String,
    token_port: u16,
    token_path: &'static str,
    /// False only for the test provider, which runs on this computer.
    token_tls: bool,
    client_id: String,
    /// Google gives desktop apps a "secret" that is shipped inside the app
    /// and so is not one. It is required all the same.
    client_secret: Option<String>,
    scopes: &'static str,
    /// The host in the address the browser is sent back to. Google expects
    /// the loopback address, Microsoft the word.
    redirect_host: &'static str,
    extra: &'static [(&'static str, &'static str)],
}

/// A provider this build was given a client id for. One without an id cannot
/// be used, so it is not offered.
pub fn provider(name: &str) -> Option<Provider> {
    match name {
        "google" => Some(Provider {
            authorize_url: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token_host: "oauth2.googleapis.com".into(),
            token_port: 443,
            token_path: "/token",
            token_tls: true,
            client_id: option_env!("FE_GOOGLE_OAUTH_CLIENT_ID")?.into(),
            client_secret: option_env!("FE_GOOGLE_OAUTH_CLIENT_SECRET").map(Into::into),
            scopes: "openid email https://mail.google.com/",
            redirect_host: "127.0.0.1",
            // Without these Google gives no refresh token on a second sign-in.
            extra: &[("access_type", "offline"), ("prompt", "consent")],
        }),
        "microsoft" => Some(Provider {
            authorize_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize".into(),
            token_host: "login.microsoftonline.com".into(),
            token_port: 443,
            token_path: "/common/oauth2/v2.0/token",
            token_tls: true,
            client_id: option_env!("FE_MICROSOFT_OAUTH_CLIENT_ID")?.into(),
            client_secret: None,
            scopes: "openid email offline_access https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
            redirect_host: "localhost",
            extra: &[("prompt", "select_account")],
        }),
        _ => None,
    }
    .filter(|p: &Provider| !p.client_id.is_empty())
}

/// The names of the providers this build can sign in with.
pub fn available() -> Vec<&'static str> {
    ["google", "microsoft"]
        .into_iter()
        .filter(|name| provider(name).is_some())
        .collect()
}

/// A provider on this computer, for the tests against ImapKit's sign-in page.
#[cfg(test)]
pub fn test_provider(port: u16, client_id: &str, hint: &'static str) -> Provider {
    Provider {
        authorize_url: format!("http://127.0.0.1:{port}/authorize"),
        token_host: "127.0.0.1".into(),
        token_port: port,
        token_path: "/token",
        token_tls: false,
        client_id: client_id.into(),
        client_secret: None,
        scopes: "openid email offline_access mail",
        redirect_host: "127.0.0.1",
        extra: Box::leak(Box::new([("login_hint", hint)])),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub access_token: String,
    /// A new one when the provider replaces it. The caller keeps the latest.
    pub refresh_token: Option<String>,
    /// Seconds until the access token stops working.
    pub expires_in: u64,
    /// The address that signed in, when the provider says.
    pub email: Option<String>,
}

fn random(bytes: usize) -> Result<String, MailError> {
    let mut buffer = vec![0u8; bytes];
    ring::rand::SystemRandom::new()
        .fill(&mut buffer)
        .map_err(|_| MailError::new("engine", "No random numbers are available"))?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buffer))
}

/// The value sent with the sign-in request, from the one kept back (PKCE S256).
fn challenge_for(verifier: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest.as_ref())
}

fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn decode(value: &str) -> String {
    let hex = |byte: u8| (byte as char).to_digit(16).map(|digit| digit as u8);
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = match (bytes[i], bytes.get(i + 1), bytes.get(i + 2)) {
            (b'%', Some(high), Some(low)) => hex(*high).zip(hex(*low)),
            _ => None,
        };
        match escaped {
            Some((high, low)) => {
                out.push(high * 16 + low);
                i += 3;
            }
            None => {
                out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// A sign-in that has been started and is waiting for the browser.
pub struct Pending {
    provider: Provider,
    listener: TcpListener,
    redirect_uri: String,
    verifier: String,
    state: String,
    /// The page to open in the user's browser.
    pub url: String,
}

/// Start a sign-in: open a port for the browser to come back to and work out
/// the page to send it to.
pub async fn begin(provider: Provider) -> Result<Pending, MailError> {
    // This computer only, and a port the system picks.
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| MailError::new("network", format!("Could not wait for the sign-in: {e}")))?;
    let port = listener.local_addr().map_err(MailError::from)?.port();
    let redirect_uri = format!("http://{}:{port}/", provider.redirect_host);
    let verifier = random(32)?;
    let state = random(16)?;
    let challenge = challenge_for(&verifier);
    let mut pairs = vec![
        ("response_type", "code"),
        ("client_id", provider.client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("scope", provider.scopes),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    pairs.extend_from_slice(provider.extra);
    let url = format!("{}?{}", provider.authorize_url, form(&pairs));
    Ok(Pending {
        provider,
        listener,
        redirect_uri,
        verifier,
        state,
        url,
    })
}

/// What the browser came back with.
#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    /// The provider's own word for why not, such as "access_denied".
    Refused(String),
    /// A request that is not the answer: a favicon, a stale tab, a prober.
    Other,
}

/// Read the answer out of the first line of the browser's request.
fn read_callback(request_line: &str, state: &str) -> Callback {
    let mut words = request_line.split(' ');
    let (Some("GET"), Some(target)) = (words.next(), words.next()) else {
        return Callback::Other;
    };
    let Some((path, query)) = target.split_once('?') else {
        return Callback::Other;
    };
    if path != "/" {
        return Callback::Other;
    }
    let value = |name: &str| {
        query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .find(|(key, _)| *key == name)
            .map(|(_, value)| decode(value))
    };
    // The state proves the answer belongs to the sign-in this app started.
    if value("state").as_deref() != Some(state) {
        return Callback::Other;
    }
    if let Some(error) = value("error") {
        return Callback::Refused(error);
    }
    match value("code") {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::Other,
    }
}

const PAGE_DONE: &str = "<!doctype html><meta charset=utf-8><title>Forward Email</title><body style=\"font:16px system-ui;margin:4em auto;max-width:28em;text-align:center\"><h1 style=\"font-size:1.3em\">You are signed in</h1><p>You can close this tab and go back to Forward Email.</p>";
const PAGE_REFUSED: &str = "<!doctype html><meta charset=utf-8><title>Forward Email</title><body style=\"font:16px system-ui;margin:4em auto;max-width:28em;text-align:center\"><h1 style=\"font-size:1.3em\">Sign-in was not completed</h1><p>You can close this tab and try again from Forward Email.</p>";

async fn answer(stream: &mut TcpStream, status: &str, page: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

async fn wait_for_code(pending: &Pending) -> Result<String, MailError> {
    loop {
        let (mut stream, _) = pending.listener.accept().await.map_err(MailError::from)?;
        let mut buffer = vec![0u8; 8192];
        let read =
            match tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buffer)).await {
                Ok(Ok(read)) => read,
                _ => continue,
            };
        let request = String::from_utf8_lossy(&buffer[..read]);
        let line = request.lines().next().unwrap_or_default();
        match read_callback(line, &pending.state) {
            Callback::Code(code) => {
                answer(&mut stream, "200 OK", PAGE_DONE).await;
                return Ok(code);
            }
            Callback::Refused(reason) => {
                answer(&mut stream, "200 OK", PAGE_REFUSED).await;
                return Err(MailError::new(
                    "denied",
                    format!("The sign-in was not completed ({reason})"),
                ));
            }
            Callback::Other => answer(&mut stream, "404 Not Found", "").await,
        }
    }
}

/// Wait for the browser to come back, then trade what it brought for tokens.
pub async fn finish(pending: Pending, limit: Duration) -> Result<Tokens, MailError> {
    let code = tokio::time::timeout(limit, wait_for_code(&pending))
        .await
        .map_err(|_| MailError::timeout("waiting for the sign-in to finish"))??;
    let mut pairs = vec![
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", pending.redirect_uri.as_str()),
        ("client_id", pending.provider.client_id.as_str()),
        ("code_verifier", pending.verifier.as_str()),
    ];
    if let Some(secret) = pending.provider.client_secret.as_deref() {
        pairs.push(("client_secret", secret));
    }
    let tokens = request_tokens(&pending.provider, &form(&pairs)).await?;
    if tokens.refresh_token.is_none() {
        return Err(MailError::new(
            "server",
            "The provider did not allow this app to stay signed in",
        ));
    }
    Ok(tokens)
}

/// Get a new access token. Rejects with kind "auth" when the refresh token no
/// longer works: the user has to sign in again.
pub async fn refresh(provider: &Provider, refresh_token: &str) -> Result<Tokens, MailError> {
    let mut pairs = vec![
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", provider.client_id.as_str()),
    ];
    if let Some(secret) = provider.client_secret.as_deref() {
        pairs.push(("client_secret", secret));
    }
    request_tokens(provider, &form(&pairs)).await
}

/// The body of an HTTP answer, with its status.
pub(super) fn read_answer(raw: &[u8]) -> Result<(u16, Vec<u8>), MailError> {
    let unreadable = || {
        MailError::new(
            "server",
            "The sign-in server sent an answer that could not be read",
        )
    };
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(unreadable)?;
    let head = String::from_utf8_lossy(&raw[..split]);
    let status = head
        .lines()
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(unreadable)?;
    let body = &raw[split + 4..];
    let chunked = head.lines().any(|line| {
        let lower = line.to_ascii_lowercase();
        lower.starts_with("transfer-encoding:") && lower.contains("chunked")
    });
    if !chunked {
        return Ok((status, body.to_vec()));
    }
    let mut out = Vec::new();
    let mut rest = body;
    loop {
        let line_end = rest
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or_else(unreadable)?;
        let size_text = String::from_utf8_lossy(&rest[..line_end]);
        let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| unreadable())?;
        rest = &rest[line_end + 2..];
        if size == 0 {
            return Ok((status, out));
        }
        if rest.len() < size {
            return Err(unreadable());
        }
        out.extend_from_slice(&rest[..size]);
        rest = rest.get(size + 2..).ok_or_else(unreadable)?;
    }
}

async fn post<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    host: &str,
    path: &str,
    body: &str,
) -> Result<(u16, Vec<u8>), MailError> {
    let request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/x-www-form-urlencoded\r\nAccept: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    let mut raw = Vec::new();
    // A server that never closes the connection is cut off by the timeout
    // around this, and one that sends too much by the limit.
    (&mut stream)
        .take(MAX_ANSWER as u64)
        .read_to_end(&mut raw)
        .await?;
    read_answer(&raw)
}

/// The address in an ID token. The token came straight from the provider
/// over TLS in answer to this app's own request, so it is read, not checked.
fn email_in(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    ["email", "preferred_username", "upn"]
        .iter()
        .filter_map(|name| claims.get(name)?.as_str())
        .find(|value| value.contains('@'))
        .map(str::to_string)
}

fn tokens_from(status: u16, body: &[u8]) -> Result<Tokens, MailError> {
    let json: serde_json::Value = serde_json::from_slice(body).map_err(|_| {
        MailError::new(
            "server",
            "The sign-in server sent an answer that could not be read",
        )
    })?;
    let text = |name: &str| json.get(name).and_then(|v| v.as_str()).map(str::to_string);
    if status != 200 {
        let error = text("error").unwrap_or_default();
        let detail = text("error_description").unwrap_or_else(|| error.clone());
        // The refresh token was revoked or has expired.
        let kind = if error == "invalid_grant" {
            "auth"
        } else {
            "server"
        };
        return Err(MailError::new(kind, format!("{status} {detail}")));
    }
    let access_token = text("access_token")
        .filter(|token| !token.is_empty())
        .ok_or_else(|| MailError::new("server", "The sign-in server sent no access token"))?;
    Ok(Tokens {
        access_token,
        refresh_token: text("refresh_token").filter(|token| !token.is_empty()),
        expires_in: json
            .get("expires_in")
            .and_then(|v| v.as_u64())
            .unwrap_or(3600),
        email: text("id_token").as_deref().and_then(email_in),
    })
}

async fn request_tokens(provider: &Provider, body: &str) -> Result<Tokens, MailError> {
    let host = provider.token_host.as_str();
    let exchange = async {
        if provider.token_tls {
            let stream = net::connect_tls(host, provider.token_port, false).await?;
            post(stream, host, provider.token_path, body).await
        } else {
            let stream = TcpStream::connect((host, provider.token_port)).await?;
            post(stream, host, provider.token_path, body).await
        }
    };
    let (status, answer) = tokio::time::timeout(HTTP_TIMEOUT, exchange)
        .await
        .map_err(|_| MailError::timeout("waiting for the sign-in server"))??;
    tokens_from(status, &answer)
}

/// What a client says to sign in with a token (XOAUTH2), before base64.
pub fn xoauth2(username: &str, access_token: &str) -> String {
    format!("user={username}\x01auth=Bearer {access_token}\x01\x01")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_hash_of_the_verifier() {
        // The example in RFC 7636, appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_values_are_long_and_never_repeat() {
        let first = random(32).unwrap();
        assert_eq!(first.len(), 43);
        assert_ne!(first, random(32).unwrap());
    }

    #[test]
    fn the_sign_in_page_address_carries_what_the_provider_needs() {
        tauri::async_runtime::block_on(async {
            let pending = begin(test_provider(8085, "app one", "alice@example.com"))
                .await
                .unwrap();
            let port = pending.listener.local_addr().unwrap().port();
            let (base, query) = pending.url.split_once('?').unwrap();
            assert_eq!(base, "http://127.0.0.1:8085/authorize");
            let has = |pair: String| query.split('&').any(|p| p == pair);
            assert!(has("response_type=code".into()));
            // Spaces, slashes and colons are escaped.
            assert!(has("client_id=app%20one".into()));
            assert!(has(format!(
                "redirect_uri=http%3A%2F%2F127.0.0.1%3A{port}%2F"
            )));
            assert!(has("scope=openid%20email%20offline_access%20mail".into()));
            assert!(has("code_challenge_method=S256".into()));
            assert!(has(format!(
                "code_challenge={}",
                challenge_for(&pending.verifier)
            )));
            assert!(has(format!("state={}", pending.state)));
            assert!(has("login_hint=alice%40example.com".into()));
            // The value kept back never appears.
            assert!(!pending.url.contains(&pending.verifier));
        });
    }

    #[test]
    fn only_the_answer_to_this_sign_in_is_accepted() {
        let state = "s3cr3t-state";
        assert_eq!(
            read_callback(
                "GET /?code=4%2FabC&state=s3cr3t-state&iss=x HTTP/1.1",
                state
            ),
            Callback::Code("4/abC".into())
        );
        assert_eq!(
            read_callback(
                "GET /?error=access_denied&state=s3cr3t-state HTTP/1.1",
                state
            ),
            Callback::Refused("access_denied".into())
        );
        // Someone else's sign-in, or a made-up one.
        assert_eq!(
            read_callback("GET /?code=stolen&state=other HTTP/1.1", state),
            Callback::Other
        );
        assert_eq!(
            read_callback("GET /?code=stolen HTTP/1.1", state),
            Callback::Other
        );
        assert_eq!(
            read_callback("GET /favicon.ico HTTP/1.1", state),
            Callback::Other
        );
        assert_eq!(
            read_callback("POST /?code=x&state=s3cr3t-state HTTP/1.1", state),
            Callback::Other
        );
        assert_eq!(
            read_callback("GET /elsewhere?code=x&state=s3cr3t-state HTTP/1.1", state),
            Callback::Other
        );
        assert_eq!(read_callback("", state), Callback::Other);
    }

    #[test]
    fn reads_tokens_and_the_address_that_signed_in() {
        // header.payload.signature, the payload being {"email":"alice@example.com"}
        let id_token = format!(
            "e30.{}.sig",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(r#"{"email":"alice@example.com"}"#)
        );
        let body = format!(
            r#"{{"access_token":"ya29.a0","refresh_token":"1//0g","expires_in":3599,"id_token":"{id_token}"}}"#
        );
        let tokens = tokens_from(200, body.as_bytes()).unwrap();
        assert_eq!(tokens.access_token, "ya29.a0");
        assert_eq!(tokens.refresh_token.as_deref(), Some("1//0g"));
        assert_eq!(tokens.expires_in, 3599);
        assert_eq!(tokens.email.as_deref(), Some("alice@example.com"));

        // A refresh answers without a new refresh token or an ID token.
        let tokens = tokens_from(200, br#"{"access_token":"ya29.b1","expires_in":3599}"#).unwrap();
        assert_eq!((tokens.refresh_token, tokens.email), (None, None));
    }

    #[test]
    fn a_refresh_token_that_stopped_working_means_sign_in_again() {
        let revoked = tokens_from(
            400,
            br#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
        )
        .unwrap_err();
        assert_eq!(revoked.kind, "auth");
        // Anything else is the server's trouble, not the user's.
        let busy = tokens_from(503, br#"{"error":"temporarily_unavailable"}"#).unwrap_err();
        assert_eq!(busy.kind, "server");
        assert_eq!(tokens_from(200, b"<html>").unwrap_err().kind, "server");
        assert_eq!(
            tokens_from(200, br#"{"token_type":"Bearer"}"#)
                .unwrap_err()
                .kind,
            "server"
        );
    }

    #[test]
    fn reads_an_answer_sent_whole_or_in_chunks() {
        let whole = b"HTTP/1.1 200 OK\r\nContent-Length: 13\r\n\r\n{\"ok\": true}\n";
        assert_eq!(
            read_answer(whole).unwrap(),
            (200, b"{\"ok\": true}\n".to_vec())
        );
        let chunked =
            b"HTTP/1.1 400 Bad Request\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"error\r\n7;ext=1\r\n\":\"x\"}\n\r\n0\r\n\r\n";
        assert_eq!(
            read_answer(chunked).unwrap(),
            (400, b"{\"error\":\"x\"}\n".to_vec())
        );
        assert!(read_answer(b"not http").is_err());
        assert!(
            read_answer(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nff\r\nshort")
                .is_err()
        );
    }

    #[test]
    fn form_values_survive_the_round_trip() {
        let value = "a b&c=d/é+%";
        let sent = form(&[("k", value)]);
        assert_eq!(sent, "k=a%20b%26c%3Dd%2F%C3%A9%2B%25");
        assert_eq!(decode(sent.split_once('=').unwrap().1), value);
        // Not valid escapes: left as they are.
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zz"), "%zz");
    }

    #[test]
    fn says_who_is_signing_in_and_with_what() {
        assert_eq!(
            xoauth2("alice@example.com", "ya29.a0"),
            "user=alice@example.com\u{1}auth=Bearer ya29.a0\u{1}\u{1}"
        );
    }

    #[test]
    fn a_provider_without_a_client_id_is_not_offered() {
        assert!(provider("someone-else").is_none());
        for name in available() {
            assert!(provider(name).is_some());
        }
    }
}
