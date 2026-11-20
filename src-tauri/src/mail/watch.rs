//! Watching an account's inbox for changes, with IMAP IDLE.
//!
//! IDLE parks a connection on one folder and the server speaks when the
//! folder changes. The connection the commands use cannot be parked, so the
//! watcher keeps a second one. It only ever tells the main window that the
//! inbox changed; the window then reads the folder through the usual
//! commands, so nothing a server sends here reaches the app as data.

use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::error::MailError;
use super::imap::{self, ImapSettings};

/// How long to stay parked before asking again. Servers drop an idle
/// connection after about half an hour, and a connection that died while the
/// computer slept is only noticed when this runs out.
const IDLE_FOR: Duration = Duration::from_secs(5 * 60);
const FIRST_RETRY: Duration = Duration::from_secs(5);
const LAST_RETRY: Duration = Duration::from_secs(5 * 60);

pub const CHANGED_EVENT: &str = "mail:changed";

#[derive(Clone, Serialize)]
struct Changed<'a> {
    handle: &'a str,
    folder: &'a str,
}

fn tell(app: &AppHandle, handle: &str) {
    // Only the main window: it is the one allowed to use the mail commands.
    let _ = app.emit_to(
        "main",
        CHANGED_EVENT,
        Changed {
            handle,
            folder: "INBOX",
        },
    );
}

enum End {
    /// The server has no IDLE. The app keeps checking on a timer instead.
    Unsupported,
}

async fn watch(
    app: &AppHandle,
    handle: &str,
    settings: &ImapSettings,
    was_connected: &mut bool,
    retry: &mut Duration,
) -> Result<End, MailError> {
    let mut session = imap::login(settings).await?;
    if !imap::has_capability(&mut session, "IDLE").await? {
        let _ = tokio::time::timeout(Duration::from_secs(5), session.logout()).await;
        return Ok(End::Unsupported);
    }
    imap::examine(&mut session, "INBOX").await?;
    // Back after a dropped connection: whatever arrived meanwhile was missed.
    if *was_connected {
        tell(app, handle);
    }
    *was_connected = true;

    loop {
        let mut idle = session.idle();
        imap::timed(imap::LOGIN_TIMEOUT, "watching the inbox", idle.init()).await?;
        let response = {
            // Dropping the second value would end the wait at once.
            let (wait, _keep_waiting) = idle.wait_with_timeout(IDLE_FOR);
            wait.await
        };
        session = imap::timed(imap::LOGIN_TIMEOUT, "watching the inbox", idle.done()).await?;
        // A full round trip worked, so the next failure starts from a short wait.
        *retry = FIRST_RETRY;
        if let IdleResponse::NewData(_) = response? {
            tell(app, handle);
        }
    }
}

/// Runs until the task is aborted (the account signed out), the server turns
/// out not to support IDLE, or it refuses the password.
pub async fn run(app: AppHandle, handle: String, settings: ImapSettings) {
    let mut was_connected = false;
    let mut retry = FIRST_RETRY;
    loop {
        match watch(&app, &handle, &settings, &mut was_connected, &mut retry).await {
            Ok(End::Unsupported) => return,
            // Trying a refused password again and again gets accounts locked.
            Err(err) if err.kind == "auth" => return,
            Err(_) => {}
        }
        tokio::time::sleep(retry).await;
        retry = (retry * 2).min(LAST_RETRY);
    }
}
