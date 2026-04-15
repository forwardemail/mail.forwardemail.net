//! Shared redaction module (Rust side).
//!
//! Mirrors `src/utils/redaction.ts`. Both implementations are validated against
//! `tests/fixtures/redaction-cases.json` so they cannot drift. Run `cargo test`
//! from `src-tauri/` to verify parity.

use regex::{Captures, Regex};
use std::sync::OnceLock;

#[allow(dead_code)]
pub const REDACTION_VERSION: u32 = 1;

// Regex instances are built once on first use.
struct Patterns {
    bearer: Regex,
    credential_kv: Regex,
    authorization: Regex,
    posix_home: Regex,
    windows_home: Regex,
    email: Regex,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| Patterns {
        // (?i) enables case-insensitive matching to mirror the JS /gi flag.
        bearer: Regex::new(r"(?i)\b(Basic|Bearer)\s+[A-Za-z0-9+/=_-]{8,}").unwrap(),
        credential_kv: Regex::new(
            r"(?i)\b(alias_auth|api_key|password|token|secret|credential)[=:]\s*\S+",
        )
        .unwrap(),
        authorization: Regex::new(
            r#"(?i)(["']?authorization["']?\s*[:=]\s*["']?)[^"'\s,}]+"#,
        )
        .unwrap(),
        posix_home: Regex::new(r"/(?:Users|home)/[A-Za-z0-9._-]+").unwrap(),
        windows_home: Regex::new(r"([A-Za-z]):\\Users\\[A-Za-z0-9._-]+").unwrap(),
        email: Regex::new(r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b").unwrap(),
    })
}

/// FNV-1a 32-bit hash over the UTF-8 bytes of the lowercased input.
pub fn fnv1a32(input: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for b in input.to_lowercase().as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

pub fn hash_email(email: &str) -> String {
    format!("{:08x}", fnv1a32(email))
}

/// Redact sensitive patterns from a string. Empty input passes through.
pub fn redact(input: &str) -> String {
    if input.is_empty() {
        return String::new();
    }
    let p = patterns();

    // Stage 1 — credentials.
    let s = p.bearer.replace_all(input, |caps: &Captures| {
        format!("{} [REDACTED]", &caps[1])
    });
    let s = p.credential_kv.replace_all(&s, |caps: &Captures| {
        format!("{}=[REDACTED]", &caps[1])
    });
    let s = p.authorization.replace_all(&s, |caps: &Captures| {
        format!("{}[REDACTED]", &caps[1])
    });

    // Stage 2 — home directory paths.
    let s = p.posix_home.replace_all(&s, "~");
    let s = p.windows_home.replace_all(&s, |caps: &Captures| {
        format!("{}:\\Users\\~", &caps[1])
    });

    // Stage 3 — email addresses.
    let s = p.email.replace_all(&s, |caps: &Captures| {
        format!("<email:{}>", hash_email(&caps[0]))
    });

    s.into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct Case {
        name: String,
        input: String,
        expected: String,
    }

    #[derive(Deserialize)]
    struct Fixture {
        version: u32,
        cases: Vec<Case>,
    }

    const FIXTURE: &str = include_str!("../../tests/fixtures/redaction-cases.json");

    #[test]
    fn fixture_parity() {
        let fixture: Fixture = serde_json::from_str(FIXTURE).expect("fixture parse");
        assert_eq!(fixture.version, REDACTION_VERSION, "fixture version drift");
        let mut failures = Vec::new();
        for c in &fixture.cases {
            let got = redact(&c.input);
            if got != c.expected {
                failures.push(format!(
                    "case {:?}\n  input    = {:?}\n  expected = {:?}\n  got      = {:?}",
                    c.name, c.input, c.expected, got
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} case(s) failed:\n{}",
            failures.len(),
            failures.join("\n\n")
        );
    }

    #[test]
    fn hash_email_is_case_insensitive() {
        assert_eq!(hash_email("Alice@Example.COM"), hash_email("alice@example.com"));
    }

    #[test]
    fn hash_email_known_values() {
        assert_eq!(hash_email("user@example.com"), "ddaa05fb");
        assert_eq!(hash_email("shaun@forwardemail.net"), "3192f268");
    }

    #[test]
    fn empty_input_passes_through() {
        assert_eq!(redact(""), "");
    }
}
