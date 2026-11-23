//! Decrypt through the system GnuPG, for keys the app cannot hold.
//!
//! A private key on a hardware token (a YubiKey or another OpenPGP card)
//! never leaves the token, so openpgp.js in the webview cannot use it. The
//! system `gpg` can: gpg-agent and scdaemon talk to the card. The frontend
//! calls this when the user turned on "Use a YubiKey or smartcard"
//! (src/utils/pgp-system-gpg.ts).
//!
//! The PIN is asked for one of two ways. First gpg-agent's own pinentry, so
//! a PIN the agent already holds, or a graphical pinentry, just works. When
//! that pinentry cannot run (a terminal-only pinentry has no terminal in a
//! GUI app: "Inappropriate ioctl for device"), the frontend asks for the PIN
//! itself and calls again with it, and gpg gets it through loopback pinentry.
//!
//! Only decryption is exposed, and the frontend chooses nothing but the
//! ciphertext and the PIN: no arguments, no key ids, no other gpg operation.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::Mutex;

/// Matches the isolation hook's limit for large IPC payloads.
const MAX_INPUT: usize = 50 * 1024 * 1024;

/// Long enough to find the token, type the PIN and touch it.
const TIMEOUT: Duration = Duration::from_secs(180);
const CARD_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

/// One gpg at a time: a burst of opens would otherwise stack PIN prompts.
static GPG_LOCK: Mutex<()> = Mutex::const_new(());

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgDecryptResult {
    pub plaintext: String,
    /// "verified" | "invalid" | "revoked" | "unverified", or None if unsigned.
    pub signature_status: Option<String>,
    /// Email of the signer gpg reported, when it found the key.
    pub signer: Option<String>,
}

/// A failure the frontend can act on: `code` says what to do next.
#[derive(Serialize, Debug)]
pub struct GpgError {
    /// unavailable | invalid_input | no_card | pinentry | bad_pin |
    /// no_secret_key | timeout | failed
    pub code: &'static str,
    pub message: String,
}

impl GpgError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgCardInfo {
    pub present: bool,
    /// User PIN attempts left before the card blocks it.
    pub pin_retries: Option<u32>,
}

/// GUI apps on macOS start with PATH=/usr/bin:/bin:/usr/sbin:/sbin, which
/// misses Homebrew and GPG Suite, so look in their usual places first.
fn find_gpg() -> Option<PathBuf> {
    let candidates = [
        "/opt/homebrew/bin/gpg",
        "/usr/local/bin/gpg",
        "/usr/local/MacGPG2/bin/gpg",
        "/usr/bin/gpg",
        "/usr/bin/gpg2",
        "C:\\Program Files (x86)\\GnuPG\\bin\\gpg.exe",
        "C:\\Program Files\\GnuPG\\bin\\gpg.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    let name = if cfg!(windows) { "gpg.exe" } else { "gpg" };
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    })
}

/// The address in a user id like `Name <a@b.c>`.
fn uid_email(uid: &str) -> Option<String> {
    let start = uid.rfind('<')?;
    let end = uid[start..].find('>')? + start;
    let email = uid[start + 1..end].trim().to_lowercase();
    (!email.is_empty()).then_some(email)
}

async fn run_gpg(
    gpg: &Path,
    args: &[&str],
    input: Vec<u8>,
    timeout: Duration,
) -> Result<Output, GpgError> {
    let mut child = Command::new(gpg)
        .args(["--batch", "--no-tty"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| GpgError::new("unavailable", format!("Could not start gpg: {e}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| GpgError::new("failed", "gpg stdin unavailable"))?;
    let writer = tokio::spawn(async move {
        let _ = stdin.write_all(&input).await;
        let _ = stdin.shutdown().await;
    });

    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| {
            GpgError::new(
                "timeout",
                "Timed out waiting for gpg (PIN or touch not given?)",
            )
        })?
        .map_err(|e| GpgError::new("failed", format!("gpg failed: {e}")))?;
    let _ = writer.await;
    Ok(output)
}

/// What went wrong, from gpg's status lines and messages.
fn classify_failure(stderr: &str) -> GpgError {
    let lower = stderr.to_lowercase();
    let last_message = stderr
        .lines()
        .filter(|l| !l.starts_with("[GNUPG:] ") && !l.trim().is_empty())
        .last()
        .unwrap_or("decryption failed")
        .trim()
        .to_string();

    let status = |prefix: &str| {
        stderr.lines().any(|l| {
            l.strip_prefix("[GNUPG:] ")
                .is_some_and(|s| s.starts_with(prefix))
        })
    };

    // CARDCTRL 4/5/6: no card, no reader, card not usable.
    if status("CARDCTRL 4")
        || status("CARDCTRL 5")
        || status("CARDCTRL 6")
        || lower.contains("card not present")
        || lower.contains("card removed")
        || lower.contains("no such device")
    {
        return GpgError::new("no_card", last_message);
    }
    // SC_OP_FAILURE 2 is a wrong PIN; BAD_PASSPHRASE is the loopback form.
    if status("SC_OP_FAILURE 2") || status("BAD_PASSPHRASE") || lower.contains("bad pin") {
        return GpgError::new("bad_pin", last_message);
    }
    if lower.contains("inappropriate ioctl")
        || lower.contains("no pinentry")
        || lower.contains("pinentry")
        || lower.contains("no tty")
    {
        return GpgError::new("pinentry", last_message);
    }
    if lower.contains("no secret key") {
        return GpgError::new("no_secret_key", last_message);
    }
    GpgError::new("failed", last_message)
}

/// Ciphertext in a private temporary file, for loopback mode, where stdin
/// carries the PIN. It is ciphertext, so nothing readable touches the disk.
struct TempCiphertext(PathBuf);

impl TempCiphertext {
    fn create(data: &[u8]) -> Result<Self, GpgError> {
        use std::io::Write;
        let n = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "fe-mail-gpg-{}-{nanos}-{n}.asc",
            std::process::id()
        ));
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(&path)
            .map_err(|e| GpgError::new("failed", format!("Could not write temp file: {e}")))?;
        file.write_all(data)
            .map_err(|e| GpgError::new("failed", format!("Could not write temp file: {e}")))?;
        Ok(Self(path))
    }
}

impl Drop for TempCiphertext {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[tauri::command]
pub async fn gpg_available() -> bool {
    find_gpg().is_some()
}

/// Whether a card is in the reader, and how many PIN tries it has left.
#[tauri::command]
pub async fn gpg_card_info() -> Result<GpgCardInfo, GpgError> {
    let gpg = find_gpg().ok_or_else(|| GpgError::new("unavailable", "gpg not found"))?;
    let _guard = GPG_LOCK.lock().await;
    let output = run_gpg(
        &gpg,
        &["--card-status", "--with-colons"],
        Vec::new(),
        CARD_STATUS_TIMEOUT,
    )
    .await?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let pin_retries = stdout
        .lines()
        .find_map(|l| l.strip_prefix("pinretry:"))
        .and_then(|rest| rest.split(':').next())
        .and_then(|n| n.parse().ok());
    Ok(GpgCardInfo {
        present: output.status.success() && pin_retries.is_some(),
        pin_retries,
    })
}

#[tauri::command]
pub async fn gpg_decrypt(
    armored: String,
    pin: Option<String>,
) -> Result<GpgDecryptResult, GpgError> {
    if armored.len() > MAX_INPUT {
        return Err(GpgError::new("invalid_input", "Message too large"));
    }
    if !armored.contains("-----BEGIN PGP MESSAGE-----") {
        return Err(GpgError::new("invalid_input", "No PGP armor block"));
    }
    if let Some(pin) = &pin {
        if pin.is_empty() || pin.len() > 127 || pin.contains(['\n', '\r', '\0']) {
            return Err(GpgError::new("invalid_input", "Invalid PIN"));
        }
    }
    let gpg = find_gpg().ok_or_else(|| {
        GpgError::new("unavailable", "GnuPG (gpg) was not found on this computer")
    })?;

    // Fetching a signer's key from a keyserver would tell the keyserver who
    // just read the message.
    let base = ["--no-auto-key-retrieve", "--status-fd", "2"];

    let _guard = GPG_LOCK.lock().await;
    let output = match pin {
        None => {
            let mut args = base.to_vec();
            args.push("--decrypt");
            run_gpg(&gpg, &args, armored.into_bytes(), TIMEOUT).await?
        }
        Some(pin) => {
            let file = TempCiphertext::create(armored.as_bytes())?;
            let path = file.0.to_string_lossy().into_owned();
            let mut args = base.to_vec();
            args.extend([
                "--pinentry-mode",
                "loopback",
                "--passphrase-fd",
                "0",
                "--decrypt",
                path.as_str(),
            ]);
            let output = run_gpg(&gpg, &args, format!("{pin}\n").into_bytes(), TIMEOUT).await?;
            drop(file);
            output
        }
    };

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut decrypted_ok = false;
    let mut signature_status: Option<&str> = None;
    let mut signer = None;
    for status in stderr.lines().filter_map(|l| l.strip_prefix("[GNUPG:] ")) {
        let mut parts = status.splitn(3, ' ');
        match parts.next().unwrap_or("") {
            "DECRYPTION_OKAY" => decrypted_ok = true,
            "GOODSIG" => {
                signature_status.get_or_insert("verified");
                signer = parts.nth(1).and_then(uid_email);
            }
            "BADSIG" => signature_status = Some("invalid"),
            "REVKEYSIG" => signature_status = Some("revoked"),
            "EXPSIG" | "EXPKEYSIG" | "ERRSIG" => {
                signature_status.get_or_insert("unverified");
            }
            _ => {}
        }
    }

    if !decrypted_ok || output.stdout.is_empty() {
        return Err(classify_failure(&stderr));
    }

    Ok(GpgDecryptResult {
        plaintext: String::from_utf8_lossy(&output.stdout).into_owned(),
        signature_status: signature_status.map(str::to_string),
        signer,
    })
}

#[cfg(test)]
mod tests {
    use super::{classify_failure, uid_email};

    #[test]
    fn email_from_user_id() {
        assert_eq!(
            uid_email("Jane Doe <Jane@Example.com>"),
            Some("jane@example.com".into())
        );
        assert_eq!(uid_email("no address"), None);
        assert_eq!(uid_email("empty <>"), None);
    }

    #[test]
    fn classifies_failures() {
        let pinentry = "gpg: public key decryption failed: Inappropriate ioctl for device\n\
                        gpg: decryption failed: No secret key\n";
        assert_eq!(classify_failure(pinentry).code, "pinentry");

        let no_card = "[GNUPG:] CARDCTRL 4\ngpg: decryption failed: No secret key\n";
        assert_eq!(classify_failure(no_card).code, "no_card");

        let bad_pin = "[GNUPG:] SC_OP_FAILURE 2\ngpg: public key decryption failed: Bad PIN\n";
        assert_eq!(classify_failure(bad_pin).code, "bad_pin");

        let no_key = "gpg: decryption failed: No secret key\n";
        let err = classify_failure(no_key);
        assert_eq!(err.code, "no_secret_key");
        assert_eq!(err.message, "gpg: decryption failed: No secret key");
    }
}
