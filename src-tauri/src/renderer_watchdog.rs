//! Renderer watchdog for the desktop main window.
//!
//! On macOS the WebKit content process can be killed out from under the app
//! (memory budget, jetsam, a crash without a report). Wry receives the
//! termination callback but Tauri 2.10 never wires it, so the window just
//! goes blank and stays blank. Seen in the field on 2026-09-13: the renderer
//! died after fifteen hours and the app sat with a white window until the
//! user tried the Services menu, which then hung the main thread waiting on
//! the dead process.
//!
//! Rather than depend on the missing callback, the Rust side pings the page
//! every few seconds and the page answers with a command. Enough unanswered
//! pings in a row on a visible window and the webview is reloaded, which is
//! also what WKWebView needs to relaunch its content process. A reload is
//! only ever attempted after the page has answered at least once since the
//! last reload, so a page that cannot answer at all (an old bundle, a boot
//! error) is reloaded once and then left alone instead of looping.
//!
//! Tauri 2.11 exposes `Builder::on_web_content_process_terminate`; when the
//! tao pin allows that upgrade this can become a direct handler. The state
//! and diagnostics command should survive that swap unchanged.

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// How often the page is pinged.
pub const PING_INTERVAL: Duration = Duration::from_secs(5);
/// Unanswered pings in a row before the window is reloaded. With the
/// interval above this is about twenty seconds of silence, long enough that
/// a slow synchronous unlock (the Argon2 PIN derivation runs for a few
/// seconds on the main thread) never trips it.
pub const MISSES_BEFORE_RELOAD: u32 = 4;

#[derive(Default)]
pub struct WatchdogState {
    inner: Mutex<Inner>,
}

#[derive(Default, Debug)]
struct Inner {
    /// Sequence number of the last ping sent.
    seq: u64,
    /// Highest sequence number the page has answered.
    acked: u64,
    /// Consecutive pings that went unanswered while the window was visible.
    missed: u32,
    /// True once the page has answered since the last reload. Reloads are
    /// only attempted while armed.
    armed: bool,
    /// Set by a reload, cleared when the next heartbeat picks it up so the
    /// page can tell the user what happened.
    pending_notice: bool,
    reloads: u32,
    last_reload_unix_ms: Option<u64>,
}

#[derive(Debug, PartialEq)]
enum TickAction {
    /// Window hidden or minimized: nothing to measure.
    Skip,
    /// Send a ping carrying this sequence number.
    Ping(u64),
    /// Reload the webview, then keep going.
    Reload,
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Inner {
    fn tick(&mut self, window_visible: bool) -> TickAction {
        if !window_visible {
            // An occluded or hidden page may be suspended by WebKit; silence
            // there says nothing about the process.
            self.missed = 0;
            return TickAction::Skip;
        }
        if self.armed && self.seq > self.acked {
            self.missed += 1;
        } else {
            self.missed = 0;
        }
        if self.missed >= MISSES_BEFORE_RELOAD {
            self.missed = 0;
            self.armed = false;
            self.pending_notice = true;
            self.reloads += 1;
            self.last_reload_unix_ms = Some(now_unix_ms());
            return TickAction::Reload;
        }
        self.seq += 1;
        TickAction::Ping(self.seq)
    }

    /// The page answered ping `seq`. Returns true when this is the first
    /// answer after a reload and the page should show a notice.
    fn ack(&mut self, seq: u64) -> bool {
        if seq > self.acked {
            self.acked = seq;
        }
        self.missed = 0;
        self.armed = true;
        std::mem::take(&mut self.pending_notice)
    }
}

#[derive(Serialize)]
pub struct HeartbeatReply {
    /// True exactly once after a watchdog reload.
    pub reloaded: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchdogStatus {
    pub reloads: u32,
    pub last_reload_unix_ms: Option<u64>,
    pub missed: u32,
    pub armed: bool,
}

#[tauri::command]
pub fn renderer_heartbeat(state: State<'_, WatchdogState>, seq: u64) -> HeartbeatReply {
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    let reloaded = inner.ack(seq);
    HeartbeatReply { reloaded }
}

#[tauri::command]
pub fn renderer_watchdog_status(state: State<'_, WatchdogState>) -> WatchdogStatus {
    let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    WatchdogStatus {
        reloads: inner.reloads,
        last_reload_unix_ms: inner.last_reload_unix_ms,
        missed: inner.missed,
        armed: inner.armed,
    }
}

/// Start the ping loop for the "main" window. Call once from setup.
pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(PING_INTERVAL).await;
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            let visible =
                window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
            let action = {
                let state = app.state::<WatchdogState>();
                let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
                inner.tick(visible)
            };
            match action {
                TickAction::Skip => {}
                TickAction::Ping(seq) => {
                    // A dead content process makes this a no-op; the silence
                    // is the signal.
                    let _ = window.eval(&format!(
                        "window.__feHeartbeat && window.__feHeartbeat({seq})"
                    ));
                }
                TickAction::Reload => {
                    log::warn!(
                        "[watchdog] main webview missed {} heartbeats in a row; reloading it",
                        MISSES_BEFORE_RELOAD
                    );
                    if let Err(e) = window.reload() {
                        log::error!("[watchdog] reload failed: {}", e);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn armed() -> Inner {
        let mut inner = Inner::default();
        assert_eq!(inner.tick(true), TickAction::Ping(1));
        assert!(!inner.ack(1));
        inner
    }

    #[test]
    fn reloads_after_the_configured_run_of_silence() {
        let mut inner = armed();
        for i in 0..MISSES_BEFORE_RELOAD {
            // Each tick sends a ping that never gets answered.
            let action = inner.tick(true);
            assert!(
                matches!(action, TickAction::Ping(_)),
                "tick {i}: {action:?}"
            );
        }
        assert_eq!(inner.tick(true), TickAction::Reload);
        assert_eq!(inner.reloads, 1);
        assert!(inner.last_reload_unix_ms.is_some());
    }

    #[test]
    fn an_answer_resets_the_run() {
        let mut inner = armed();
        let mut last = 0;
        for _ in 0..MISSES_BEFORE_RELOAD - 1 {
            if let TickAction::Ping(seq) = inner.tick(true) {
                last = seq;
            }
        }
        assert!(!inner.ack(last));
        for _ in 0..MISSES_BEFORE_RELOAD {
            assert!(matches!(inner.tick(true), TickAction::Ping(_)));
        }
        assert_eq!(inner.reloads, 0);
    }

    // A page that never answers (old bundle without the handler, a boot
    // error) must not be reloaded every twenty seconds forever.
    #[test]
    fn never_reloads_before_the_page_has_answered_once() {
        let mut inner = Inner::default();
        for _ in 0..MISSES_BEFORE_RELOAD * 3 {
            assert!(matches!(inner.tick(true), TickAction::Ping(_)));
        }
        assert_eq!(inner.reloads, 0);
    }

    #[test]
    fn disarms_after_a_reload_until_the_new_page_answers() {
        let mut inner = armed();
        for _ in 0..MISSES_BEFORE_RELOAD {
            inner.tick(true);
        }
        assert_eq!(inner.tick(true), TickAction::Reload);
        for _ in 0..MISSES_BEFORE_RELOAD * 2 {
            assert!(matches!(inner.tick(true), TickAction::Ping(_)));
        }
        assert_eq!(inner.reloads, 1);
        // The first answer from the reloaded page carries the notice, once.
        assert!(inner.ack(inner.seq));
        assert!(!inner.ack(inner.seq));
        assert!(inner.armed);
    }

    #[test]
    fn a_hidden_window_is_not_measured() {
        let mut inner = armed();
        for _ in 0..MISSES_BEFORE_RELOAD - 1 {
            inner.tick(true);
        }
        assert_eq!(inner.tick(false), TickAction::Skip);
        assert_eq!(inner.missed, 0);
        for _ in 0..MISSES_BEFORE_RELOAD * 2 {
            assert_eq!(inner.tick(false), TickAction::Skip);
        }
        assert_eq!(inner.reloads, 0);
    }
}
