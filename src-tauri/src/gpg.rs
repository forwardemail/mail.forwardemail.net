//! Decrypt and sign through the system GnuPG, for keys the app cannot hold.
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
//! Three operations are exposed: decrypting, signing (alone, or with
//! encryption to the recipients' keys for an encrypted send), and checking
//! the signature on a signed-only message against the keyring. The frontend
//! passes data, the sender's address, recipient public keys and the PIN, never
//! gpg arguments.
//!
//! Plaintext never goes to a file: gpg reads the loopback PIN from the first
//! line of stdin before the message that follows it. Recipient public keys
//! are written to private temporary files for `--recipient-file`, so they are
//! used without being imported into the user's keyring.

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
pub struct GpgSignResult {
    /// A detached signature, or with recipients an encrypted and signed message.
    pub armored: String,
    /// The RFC 3156 micalg for the hash gpg used, e.g. "pgp-sha512".
    pub micalg: Option<String>,
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
        .rfind(|l| !l.starts_with("[GNUPG:] ") && !l.trim().is_empty())
        .unwrap_or("gpg failed")
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
    if status("SC_OP_FAILURE 2")
        || status("BAD_PASSPHRASE")
        || lower.contains("bad pin")
        || lower.contains("bad passphrase")
    {
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

/// A private temporary file, removed on drop. Only ever ciphertext or a
/// public key, so nothing readable touches the disk.
struct TempFile(PathBuf);

impl TempFile {
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

impl Drop for TempFile {
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
    check_pin(&pin)?;
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
            let file = TempFile::create(armored.as_bytes())?;
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
    let decrypted_ok = stderr.contains("[GNUPG:] DECRYPTION_OKAY");
    let (signature_status, signer) = signature_from_status(&stderr);

    if !decrypted_ok || output.stdout.is_empty() {
        return Err(classify_failure(&stderr));
    }

    Ok(GpgDecryptResult {
        plaintext: String::from_utf8_lossy(&output.stdout).into_owned(),
        signature_status: signature_status.map(str::to_string),
        signer,
    })
}

/// The signature gpg reported in its status lines: "verified" | "invalid" |
/// "revoked" | "unverified" (no key, or an expired one), and the signer's
/// address when gpg found the key.
fn signature_from_status(stderr: &str) -> (Option<&'static str>, Option<String>) {
    let mut status_out: Option<&'static str> = None;
    let mut signer = None;
    for status in stderr.lines().filter_map(|l| l.strip_prefix("[GNUPG:] ")) {
        let mut parts = status.splitn(3, ' ');
        match parts.next().unwrap_or("") {
            "GOODSIG" => {
                status_out.get_or_insert("verified");
                signer = parts.nth(1).and_then(uid_email);
            }
            "BADSIG" => status_out = Some("invalid"),
            "REVKEYSIG" => status_out = Some("revoked"),
            "EXPSIG" | "EXPKEYSIG" | "ERRSIG" => {
                status_out.get_or_insert("unverified");
            }
            _ => {}
        }
    }
    (status_out, signer)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpgVerifyResult {
    /// "verified" | "invalid" | "revoked" | "unverified", or None if gpg
    /// found no signature.
    pub signature_status: Option<String>,
    pub signer: Option<String>,
}

/// Check a detached signature (a signed-only RFC 3156 message) against the
/// user's GnuPG keyring. The signed part goes to gpg on stdin; the signature
/// alone goes through a temporary file. No PIN: verifying needs no secret.
#[tauri::command]
pub async fn gpg_verify(signed: String, signature: String) -> Result<GpgVerifyResult, GpgError> {
    if signed.is_empty() || signed.len() > MAX_INPUT || signature.len() > MAX_KEY_SIZE {
        return Err(GpgError::new(
            "invalid_input",
            "Nothing to check, or too large",
        ));
    }
    if !signature.contains("-----BEGIN PGP SIGNATURE-----") {
        return Err(GpgError::new("invalid_input", "No PGP signature"));
    }
    let gpg = find_gpg().ok_or_else(|| {
        GpgError::new("unavailable", "GnuPG (gpg) was not found on this computer")
    })?;
    let sig_file = TempFile::create(signature.as_bytes())?;
    let sig_path = sig_file.0.to_string_lossy().into_owned();
    let output = run_gpg(
        &gpg,
        &[
            "--no-auto-key-retrieve",
            "--status-fd",
            "2",
            "--verify",
            sig_path.as_str(),
            "-",
        ],
        signed.into_bytes(),
        CARD_STATUS_TIMEOUT,
    )
    .await?;
    drop(sig_file);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let (status, signer) = signature_from_status(&stderr);
    Ok(GpgVerifyResult {
        signature_status: status.map(str::to_string),
        signer,
    })
}

/// Most recipients (and the sender's own key) a message is encrypted to.
const MAX_RECIPIENTS: usize = 100;
const MAX_KEY_SIZE: usize = 1024 * 1024;

fn check_pin(pin: &Option<String>) -> Result<(), GpgError> {
    if let Some(pin) = pin {
        if pin.is_empty() || pin.len() > 127 || pin.contains(['\n', '\r', '\0']) {
            return Err(GpgError::new("invalid_input", "Invalid PIN"));
        }
    }
    Ok(())
}

/// A bare email address, safe to put in `<...>` as a gpg user id.
fn valid_signer(signer: &str) -> bool {
    signer.len() <= 254
        && signer.contains('@')
        && !signer.starts_with('-')
        && !signer
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '<' | '>'))
}

/// The micalg for an OpenPGP hash algorithm id (RFC 4880 9.4, RFC 3156 5).
fn micalg(hash_id: &str) -> Option<String> {
    let name = match hash_id {
        "1" => "md5",
        "2" => "sha1",
        "3" => "ripemd160",
        "8" => "sha256",
        "9" => "sha384",
        "10" => "sha512",
        "11" => "sha224",
        _ => return None,
    };
    Some(format!("pgp-{name}"))
}

/// The key to sign with, from `--list-secret-keys --with-colons --fingerprint`
/// for the sender's address: its primary fingerprint.
///
/// Several keys can carry one address (an old key, a laptop key, the one on
/// the token), and `--local-user <address>` takes the first, usable or not.
/// So only keys that can sign right now count: a signing (sub)key whose secret
/// is here or on a card, not expired or revoked, under a primary that is not
/// either. Card keys come first, as the user turned this on for a token, then
/// the newest.
fn pick_signing_key(colons: &str, now: u64) -> Option<String> {
    struct Candidate {
        fpr: String,
        usable: bool,
        on_card: bool,
        created: u64,
        dead: bool,
    }
    let alive = |f: &[&str]| {
        !matches!(f.get(1).copied(), Some("r" | "e" | "d" | "i" | "n"))
            && f.get(6)
                .and_then(|e| e.parse::<u64>().ok())
                .is_none_or(|e| e > now)
    };
    // Field 15: "#" no secret here, "+" secret here, else a card serial.
    let secret = |f: &[&str]| match f.get(14).copied() {
        Some("#") | None => None,
        Some("+") => Some(false),
        Some(_) => Some(true),
    };
    let can_sign = |f: &[&str]| f.get(11).is_some_and(|c| c.contains('s'));

    let mut keys: Vec<Candidate> = Vec::new();
    let mut want_fpr = false;
    for line in colons.lines() {
        let f: Vec<&str> = line.split(':').collect();
        match f[0] {
            "sec" => {
                keys.push(Candidate {
                    fpr: String::new(),
                    usable: false,
                    on_card: false,
                    created: f.get(5).and_then(|c| c.parse().ok()).unwrap_or(0),
                    dead: !alive(&f),
                });
                want_fpr = true;
            }
            "ssb" => want_fpr = false,
            "fpr" if want_fpr => {
                if let Some(k) = keys.last_mut() {
                    k.fpr = f.get(9).unwrap_or(&"").to_string();
                }
                want_fpr = false;
            }
            _ => {}
        }
        if matches!(f[0], "sec" | "ssb") && can_sign(&f) && alive(&f) {
            if let (Some(k), Some(card)) = (keys.last_mut(), secret(&f)) {
                k.usable = true;
                k.on_card |= card;
            }
        }
    }
    keys.into_iter()
        .filter(|k| k.usable && !k.dead && !k.fpr.is_empty())
        .max_by_key(|k| (k.on_card, k.created))
        .map(|k| k.fpr)
}

/// Sign `data` as `signer`: a detached signature, or with `recipient_keys`
/// (armored public keys) a message encrypted to them and signed.
///
/// The key is a usable one in the user's GnuPG keyring for `signer`
/// (pick_signing_key), else gpg's default key, as the app picks its own keys. The PIN is asked for the same
/// two ways as for decryption.
#[tauri::command]
pub async fn gpg_sign(
    data: String,
    signer: String,
    recipient_keys: Vec<String>,
    pin: Option<String>,
) -> Result<GpgSignResult, GpgError> {
    if data.is_empty() || data.len() > MAX_INPUT {
        return Err(GpgError::new(
            "invalid_input",
            "Nothing to sign, or too large",
        ));
    }
    let signer = signer.trim().to_lowercase();
    if !valid_signer(&signer) {
        return Err(GpgError::new("invalid_input", "Invalid sender address"));
    }
    if recipient_keys.len() > MAX_RECIPIENTS
        || recipient_keys
            .iter()
            .any(|k| k.len() > MAX_KEY_SIZE || !k.contains("-----BEGIN PGP PUBLIC KEY BLOCK-----"))
    {
        return Err(GpgError::new("invalid_input", "Invalid recipient key"));
    }
    check_pin(&pin)?;
    let gpg = find_gpg().ok_or_else(|| {
        GpgError::new("unavailable", "GnuPG (gpg) was not found on this computer")
    })?;
    let encrypt = !recipient_keys.is_empty();
    let user_id = format!("<{signer}>");

    let _guard = GPG_LOCK.lock().await;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let signing_key = run_gpg(
        &gpg,
        &[
            "--list-secret-keys",
            "--with-colons",
            "--fingerprint",
            "--",
            &user_id,
        ],
        Vec::new(),
        CARD_STATUS_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.status.success())
    .and_then(|o| pick_signing_key(&String::from_utf8_lossy(&o.stdout), now));

    let key_files = recipient_keys
        .iter()
        .map(|k| TempFile::create(k.as_bytes()))
        .collect::<Result<Vec<_>, _>>()?;
    let key_paths: Vec<String> = key_files
        .iter()
        .map(|f| f.0.to_string_lossy().into_owned())
        .collect();

    let mut args: Vec<&str> = vec!["--no-auto-key-retrieve", "--status-fd", "2", "--armor"];
    if let Some(fpr) = &signing_key {
        args.extend(["--local-user", fpr.as_str()]);
    }
    if pin.is_some() {
        args.extend(["--pinentry-mode", "loopback", "--passphrase-fd", "0"]);
    }
    if encrypt {
        args.extend(["--encrypt", "--sign"]);
        for path in &key_paths {
            args.extend(["--recipient-file", path.as_str()]);
        }
    } else {
        args.push("--detach-sign");
    }

    // gpg reads the PIN's line from stdin before the data after it.
    let mut input = match &pin {
        Some(pin) => format!("{pin}\n").into_bytes(),
        None => Vec::new(),
    };
    input.extend_from_slice(data.as_bytes());
    let output = run_gpg(&gpg, &args, input, TIMEOUT).await?;
    drop(key_files);

    let stderr = String::from_utf8_lossy(&output.stderr);
    let mut hash = None;
    let mut encrypted = false;
    for status in stderr.lines().filter_map(|l| l.strip_prefix("[GNUPG:] ")) {
        let fields: Vec<&str> = status.split(' ').collect();
        match fields.first().copied() {
            // SIG_CREATED <type> <pk_algo> <hash_algo> <class> <time> <fpr>
            Some("SIG_CREATED") => hash = fields.get(3).and_then(|h| micalg(h)).or(hash),
            Some("END_ENCRYPTION") => encrypted = true,
            _ => {}
        }
    }
    let signed = stderr.contains("[GNUPG:] SIG_CREATED ");
    if !output.status.success() || !signed || (encrypt && !encrypted) || output.stdout.is_empty() {
        return Err(classify_failure(&stderr));
    }

    Ok(GpgSignResult {
        armored: String::from_utf8_lossy(&output.stdout).into_owned(),
        micalg: hash,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        classify_failure, micalg, pick_signing_key, signature_from_status, uid_email, valid_signer,
    };

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

        let bad_pass = "[GNUPG:] BEGIN_SIGNING H10\ngpg: signing failed: Bad passphrase\n";
        assert_eq!(classify_failure(bad_pass).code, "bad_pin");

        let no_signer = "[GNUPG:] INV_SGNR 9 a@b.c\ngpg: signing failed: No secret key\n";
        assert_eq!(classify_failure(no_signer).code, "no_secret_key");
    }

    #[test]
    fn signer_is_a_bare_address() {
        assert!(valid_signer("jane@example.com"));
        assert!(!valid_signer("--batch@x"));
        assert!(!valid_signer("jane"));
        assert!(!valid_signer("a b@example.com"));
        assert!(!valid_signer("a>@example.com"));
        assert!(!valid_signer("a@example.com\n"));
    }

    #[test]
    fn picks_a_key_that_can_sign() {
        // An old key (primary offline, card signing subkey expired), a key
        // on disk, and the current key with its signing subkey on a card.
        let colons = "\
sec:-:4096:1:OLD:1400000000:::-:::scESC:::#:::23::0:
fpr:::::::::OLDFPR:
uid:-::::1400000000::H::Me <me@x.com>::::::::::0:
ssb:-:4096:1:OLDE:1400000000::::::e:::D2760001240102000006038292910000:::23:
fpr:::::::::OLDEFPR:
ssb:e:4096:1:OLDS:1400000000:1529181910:::::s:::D2760001240102000006038292910000:::23:
fpr:::::::::OLDSFPR:
sec:u:4096:1:DISK:1450000000:::u:::scESC:::+:::23::0:
fpr:::::::::DISKFPR:
uid:u::::1450000000::H::Me (laptop) <me@x.com>::::::::::0:
sec:u:255:22:CARD:1600000000:::u:::cESCA:::#:::ed25519:::0:
fpr:::::::::CARDFPR:
uid:u::::1600000000::H::Me <me@x.com>::::::::::0:
ssb:u:255:22:CARDS:1600000000::::::s:::D2760001240100000006371904260000:::ed25519::
fpr:::::::::CARDSFPR:
ssb:u:255:18:CARDE:1600000000::::::e:::D2760001240100000006371904260000:::cv25519::
fpr:::::::::CARDEFPR:
";
        let now = 1_800_000_000;
        assert_eq!(pick_signing_key(colons, now).as_deref(), Some("CARDFPR"));

        // Without the card key, the key on disk, never the expired one
        let no_card: String = colons.split("sec:u:255").next().unwrap().to_string();
        assert_eq!(pick_signing_key(&no_card, now).as_deref(), Some("DISKFPR"));

        let only_old: String = colons.split("sec:u:4096").next().unwrap().to_string();
        assert_eq!(pick_signing_key(&only_old, now), None);

        let revoked = colons.replace("sec:u:255", "sec:r:255");
        assert_eq!(pick_signing_key(&revoked, now).as_deref(), Some("DISKFPR"));
    }

    #[test]
    fn reads_signature_status() {
        let good = "[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 671519AACAB1E443 Me <Me@X.com>\n[GNUPG:] VALIDSIG ...\n";
        assert_eq!(
            signature_from_status(good),
            (Some("verified"), Some("me@x.com".into()))
        );
        let bad = "[GNUPG:] BADSIG 671519AACAB1E443 Me <me@x.com>\n";
        assert_eq!(signature_from_status(bad).0, Some("invalid"));
        let no_key = "[GNUPG:] ERRSIG 671519AACAB1E443 22 10 00 1795444922 9 -\n[GNUPG:] NO_PUBKEY 671519AACAB1E443\n";
        assert_eq!(signature_from_status(no_key), (Some("unverified"), None));
        assert_eq!(signature_from_status("gpg: no signature found\n").0, None);
    }

    #[test]
    fn micalg_from_hash_id() {
        assert_eq!(micalg("8").as_deref(), Some("pgp-sha256"));
        assert_eq!(micalg("10").as_deref(), Some("pgp-sha512"));
        assert_eq!(micalg("99"), None);
    }
}
