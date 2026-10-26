//! Windows "External Browser Override": open a link in the browser the user
//! named in Settings instead of the system default.
//!
//! This used to go through `opener:allow-open-url` with `"app": true`, which
//! let any script in the webview run any program with a URL as its command
//! line (`mshta.exe https://…/x.hta`, `powershell.exe https://x/;…`). The
//! command below accepts only an http(s) URL, re-serialized so it holds no
//! space or quote, passed as one quoted argument, and only a known browser
//! executable.

use tauri::Url;

/// Executable names (without `.exe`) accepted as a browser.
const KNOWN_BROWSERS: &[&str] = &[
    "brave",
    "chrome",
    "chromium",
    "duckduckgo",
    "firefox",
    "floorp",
    "iexplore",
    "librewolf",
    "msedge",
    "mullvadbrowser",
    "opera",
    "palemoon",
    "seamonkey",
    "thorium",
    "vivaldi",
    "waterfox",
    "whale",
    "zen",
];

/// The canonical form of an http(s) URL, or an error for anything else.
pub fn validate_url(url: &str) -> Result<String, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "Invalid URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("Only http and https URLs can be opened in a browser".to_string()),
    }
    if parsed.host_str().map_or(true, str::is_empty) {
        return Err("Invalid URL".to_string());
    }
    let canonical = parsed.as_str().to_string();
    // The serializer percent-encodes these; refuse rather than trust it.
    if canonical
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '"')
    {
        return Err("Invalid URL".to_string());
    }
    Ok(canonical)
}

/// The browser program to start: a known browser name ("firefox",
/// "msedge.exe") or an absolute local path to one
/// (`C:\Program Files\Mozilla Firefox\firefox.exe`).
pub fn validate_browser(browser: &str) -> Result<String, String> {
    let browser = browser.trim();
    let refuse = || Err(format!("\"{browser}\" is not a supported browser"));
    if browser.is_empty()
        || browser.len() > 260
        || browser.chars().any(|c| {
            c.is_control()
                || matches!(
                    c,
                    '"' | '%' | '&' | '|' | '<' | '>' | '^' | ';' | ',' | '*' | '?'
                )
        })
    {
        return refuse();
    }

    let has_separator = browser.contains('\\') || browser.contains('/');
    if has_separator {
        // An absolute path on a local drive only: no relative path, no UNC
        // share (\\host\share\x.exe would run a remote binary), no device path.
        let bytes = browser.as_bytes();
        let drive_absolute = bytes.len() > 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/');
        if !drive_absolute || browser.split(['\\', '/']).any(|part| part == "..") {
            return refuse();
        }
    }

    let file_name = browser.rsplit(['\\', '/']).next().unwrap_or_default();
    let lower = file_name.to_ascii_lowercase();
    let stem = match lower.strip_suffix(".exe") {
        Some(stem) => stem,
        // A full path must name the .exe itself
        None if has_separator => return refuse(),
        None => lower.as_str(),
    };
    if !KNOWN_BROWSERS.contains(&stem) {
        return refuse();
    }
    Ok(browser.to_string())
}

/// The argument string handed to the browser: the URL as one quoted argument.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub fn browser_argument(canonical_url: &str) -> String {
    format!("\"{canonical_url}\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_http_and_https_urls_in_canonical_form() {
        assert_eq!(
            validate_url("https://forwardemail.net/docs?a=1#x").unwrap(),
            "https://forwardemail.net/docs?a=1#x"
        );
        assert_eq!(
            validate_url("HTTP://Example.com/a b\"c").unwrap(),
            "http://example.com/a%20b%22c"
        );
    }

    #[test]
    fn refuses_other_schemes_and_junk() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "mailto:a@b.c",
            "ms-settings:",
            "https://",
            "not a url",
            "",
        ] {
            assert!(validate_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn a_url_cannot_add_arguments() {
        let url = validate_url("https://x /c calc.exe").unwrap_or_default();
        assert!(!url.contains(' '));
        let url = validate_url("https://x/\" --load-extension=evil").unwrap();
        assert_eq!(browser_argument(&url).matches('"').count(), 2);
    }

    #[test]
    fn accepts_known_browsers() {
        for browser in [
            "firefox",
            "Chrome",
            "msedge.exe",
            r"C:\Program Files\Mozilla Firefox\firefox.exe",
            r"C:\Users\me\AppData\Local\Google\Chrome\Application\chrome.exe",
        ] {
            assert!(validate_browser(browser).is_ok(), "{browser}");
        }
    }

    #[test]
    fn refuses_other_programs() {
        for browser in [
            "mshta.exe",
            "powershell",
            "cmd.exe",
            "wscript",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            r"\\attacker\share\firefox.exe",
            r"..\firefox.exe",
            r"C:\Temp\..\Windows\firefox.exe",
            r"C:\Program Files\Mozilla Firefox\firefox",
            "firefox.exe\" -new-window",
            "firefox & calc",
            "%COMSPEC%",
            "",
        ] {
            assert!(validate_browser(browser).is_err(), "{browser}");
        }
    }
}
