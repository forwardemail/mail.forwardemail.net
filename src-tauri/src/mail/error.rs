//! Typed errors for the mail engine.
//!
//! The kind lets the UI say something specific ("wrong password", "the
//! server's certificate is not trusted") instead of "Request failed". The
//! message is the server's or the system's own text, passed through the log
//! redaction so an address or credential in it does not reach the UI or logs.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct MailError {
    pub kind: &'static str,
    pub message: String,
    /// Which recipient the server refused, counted from 0 in the list the
    /// caller gave. The address itself stays out of the message.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipient: Option<usize>,
}

impl MailError {
    pub fn new(kind: &'static str, message: impl AsRef<str>) -> Self {
        Self {
            kind,
            message: crate::redaction::redact(message.as_ref()),
            recipient: None,
        }
    }

    pub fn recipient(index: usize, message: impl AsRef<str>) -> Self {
        Self {
            recipient: Some(index),
            ..Self::new("recipient", message)
        }
    }

    pub fn input(message: impl AsRef<str>) -> Self {
        Self::new("input", message)
    }

    pub fn timeout(what: &str) -> Self {
        Self::new("timeout", format!("Timed out {what}"))
    }

    /// The connection is gone, so the next call should sign in again.
    pub fn is_connection(&self) -> bool {
        matches!(self.kind, "network" | "timeout" | "closed")
    }
}

impl From<async_imap::error::Error> for MailError {
    fn from(err: async_imap::error::Error) -> Self {
        use async_imap::error::Error as E;
        match err {
            E::Io(e) => MailError::new("network", e.to_string()),
            E::ConnectionLost => MailError::new("closed", "The server closed the connection"),
            E::No(text) => MailError::new("server", text),
            E::Bad(text) => MailError::new("server", text),
            other => MailError::new("server", other.to_string()),
        }
    }
}

impl From<std::io::Error> for MailError {
    fn from(err: std::io::Error) -> Self {
        // rustls reports a certificate or handshake failure as InvalidData.
        if err.kind() == std::io::ErrorKind::InvalidData {
            return MailError::new("tls", err.to_string());
        }
        MailError::new("network", err.to_string())
    }
}
