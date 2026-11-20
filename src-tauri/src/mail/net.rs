//! Connecting to a mail server.
//!
//! Every connection is TLS before a credential is sent. A certificate the
//! operating system does not trust is an error and there is no way to accept
//! it. Addresses on this machine or the local network are refused unless the
//! user said the server is on their network, so a hostile page that reached
//! these commands could not use them to probe the local network.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use rustls_platform_verifier::BuilderVerifierExt;
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::rustls::ClientConfig;
use tokio_rustls::TlsConnector;

use super::error::MailError;

pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

fn is_local_v4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        // carrier-grade NAT, 100.64.0.0/10
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
}

fn is_local_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_local_v4(v4);
    }
    let first = ip.segments()[0];
    ip.is_loopback()
        || ip.is_unspecified()
        // unique local, fc00::/7
        || (first & 0xfe00) == 0xfc00
        // link local, fe80::/10
        || (first & 0xffc0) == 0xfe80
}

pub fn is_local_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_local_v4(v4),
        IpAddr::V6(v6) => is_local_v6(v6),
    }
}

/// A host name as a user types it: letters, digits, dots and hyphens, or an
/// IP address. Anything else (a URL, a path, spaces) is refused.
pub fn valid_host(host: &str) -> bool {
    if host.is_empty() || host.len() > 253 {
        return false;
    }
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    })
}

/// Resolve the host and pick the address to connect to. The connection is
/// made to this exact address, so a second DNS answer cannot swap in a local
/// one after the check.
async fn resolve(host: &str, port: u16, allow_local: bool) -> Result<SocketAddr, MailError> {
    if !valid_host(host) {
        return Err(MailError::input("That is not a valid server name"));
    }
    if port == 0 {
        return Err(MailError::input("That is not a valid port"));
    }
    let addrs: Vec<SocketAddr> =
        tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
            .await
            .map_err(|_| MailError::timeout("looking up the server"))?
            .map_err(|e| MailError::new("network", format!("Could not find the server: {e}")))?
            .collect();
    if addrs.is_empty() {
        return Err(MailError::new("network", "Could not find the server"));
    }
    if !allow_local && addrs.iter().any(|a| is_local_address(a.ip())) {
        return Err(MailError::new(
            "local",
            "That server is on this computer or the local network",
        ));
    }
    Ok(addrs[0])
}

pub async fn connect_plain(
    host: &str,
    port: u16,
    allow_local: bool,
) -> Result<TcpStream, MailError> {
    let addr = resolve(host, port, allow_local).await?;
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
        .await
        .map_err(|_| MailError::timeout("connecting to the server"))?
        .map_err(|e| MailError::new("network", format!("Could not connect: {e}")))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn tls_config() -> Result<Arc<ClientConfig>, MailError> {
    static CONFIG: OnceLock<Result<Arc<ClientConfig>, String>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
            let config = ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .with_platform_verifier()
                .map_err(|e| e.to_string())?
                .with_no_client_auth();
            Ok(Arc::new(config))
        })
        .clone()
        .map_err(|e| MailError::new("tls", e))
}

pub async fn upgrade(host: &str, stream: TcpStream) -> Result<TlsStream<TcpStream>, MailError> {
    let name = ServerName::try_from(host.to_string())
        .map_err(|_| MailError::input("That is not a valid server name"))?;
    let connector = TlsConnector::from(tls_config()?);
    tokio::time::timeout(CONNECT_TIMEOUT, connector.connect(name, stream))
        .await
        .map_err(|_| MailError::timeout("securing the connection"))?
        .map_err(|e| MailError::new("tls", format!("The connection could not be secured: {e}")))
}

pub async fn connect_tls(
    host: &str,
    port: u16,
    allow_local: bool,
) -> Result<TlsStream<TcpStream>, MailError> {
    let stream = connect_plain(host, port, allow_local).await?;
    upgrade(host, stream).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_addresses_on_this_machine_and_the_local_network() {
        for local in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.9",
            "192.168.1.20",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fd12:3456::1",
            "::ffff:192.168.1.20",
        ] {
            assert!(is_local_address(local.parse().unwrap()), "{local}");
        }
    }

    #[test]
    fn allows_public_addresses() {
        for public in ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111"] {
            assert!(!is_local_address(public.parse().unwrap()), "{public}");
        }
    }

    #[test]
    fn accepts_host_names_and_refuses_anything_else() {
        assert!(valid_host("imap.example.com"));
        assert!(valid_host("mail-1.example.co.uk"));
        assert!(valid_host("192.0.2.10"));
        for bad in [
            "",
            "imap.example.com/inbox",
            "https://imap.example.com",
            "imap example.com",
            "imap.example.com:993",
            "-imap.example.com",
            "imap..example.com",
            "user@imap.example.com",
        ] {
            assert!(!valid_host(bad), "{bad}");
        }
    }
}
