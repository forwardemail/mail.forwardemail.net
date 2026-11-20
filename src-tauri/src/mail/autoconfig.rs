//! Finding a mail server's settings from an email address.
//!
//! The places asked, in order, stopping at the first that answers:
//!
//! 1. the domain's own settings file, `https://autoconfig.<domain>/mail/config-v1.1.xml`
//! 2. Thunderbird's public directory, `https://autoconfig.thunderbird.net/v1.1/<domain>`
//! 3. the domain's MX record, to recognise a provider that hosts mail for
//!    other people's domains, and then the directory again for that provider
//! 4. the domain's SRV records (RFC 6186 and RFC 8314)
//!
//! Steps 2 and 3 tell Mozilla the mail domain, never the address. The form
//! says so before the user asks for a lookup.
//!
//! What comes back is a suggestion that fills an editable form. Nothing is
//! connected to and no password is sent until the user signs in. SRV comes
//! last because DNS answers are not signed: the form shows where a suggestion
//! came from so the user can check a server name found that way.
//!
//! The webview gives an address and nothing else. The hosts fetched from are
//! built here from the address's domain, always over HTTPS with the system's
//! certificate checks, with no redirects followed, a size limit and a short
//! timeout.

use std::time::Duration;

use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::error::MailError;
use super::net;
use super::oauth::read_answer;

const DIRECTORY_HOST: &str = "autoconfig.thunderbird.net";
const STEP_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_FILE: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Server {
    pub host: String,
    pub port: u16,
    /// "tls" or "starttls". A server offered without either is not suggested.
    pub security: &'static str,
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Found {
    /// Where the suggestion came from: "domain", "directory", "provider"
    /// or "dns".
    pub source: &'static str,
    pub imap: Option<Server>,
    pub smtp: Option<Server>,
}

/// The parts of an address, lower-cased domain. None when it is not an
/// address on a named domain.
pub fn split_address(email: &str) -> Option<(&str, String)> {
    let email = email.trim();
    let (local, domain) = email.rsplit_once('@')?;
    let domain = domain.to_ascii_lowercase();
    let named = domain.contains('.') && domain.parse::<std::net::IpAddr>().is_err();
    if local.is_empty()
        || local.len() > 64
        || local.chars().any(|c| c.is_whitespace() || c.is_control())
        || !named
        || !net::valid_host(&domain)
    {
        return None;
    }
    Some((local, domain))
}

fn fill(template: &str, email: &str, local: &str, domain: &str) -> String {
    template
        .replace("%EMAILADDRESS%", email)
        .replace("%EMAILLOCALPART%", local)
        .replace("%EMAILDOMAIN%", domain)
}

#[derive(Default)]
struct Entry {
    kind: String,
    host: String,
    port: String,
    socket: String,
    username: String,
}

impl Entry {
    fn server(&self, email: &str, local: &str, domain: &str) -> Option<Server> {
        let security = match self.socket.trim().to_ascii_uppercase().as_str() {
            "SSL" => "tls",
            "STARTTLS" => "starttls",
            _ => return None,
        };
        let host = fill(self.host.trim(), email, local, domain).to_ascii_lowercase();
        let port = self.port.trim().parse::<u16>().ok().filter(|p| *p != 0)?;
        if !net::valid_host(&host) {
            return None;
        }
        let username = fill(self.username.trim(), email, local, domain);
        Some(Server {
            host,
            port,
            security,
            username: if username.is_empty() {
                email.to_string()
            } else {
                username
            },
        })
    }
}

/// Read a settings file in Thunderbird's format. The first IMAP server and
/// the first SMTP server that use TLS are taken, in the order the file lists
/// them, which is the order the provider prefers.
pub fn parse(xml: &str, email: &str) -> Option<(Option<Server>, Option<Server>)> {
    let (local, domain) = split_address(email)?;
    let mut reader = Reader::from_str(xml);
    let mut imap = None;
    let mut smtp = None;
    let mut entry: Option<(bool, Entry)> = None;
    let mut field: Option<Vec<u8>> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                let name = tag.name().as_ref().to_vec();
                if name == b"incomingServer" || name == b"outgoingServer" {
                    let kind = tag
                        .attributes()
                        .flatten()
                        .find(|a| a.key.as_ref() == b"type")
                        .map(|a| String::from_utf8_lossy(&a.value).to_ascii_lowercase())
                        .unwrap_or_default();
                    entry = Some((
                        name == b"incomingServer",
                        Entry {
                            kind,
                            ..Entry::default()
                        },
                    ));
                } else if entry.is_some() {
                    field = Some(name);
                }
            }
            Ok(Event::Text(text)) => {
                if let (Some((_, entry)), Some(field)) = (entry.as_mut(), field.as_deref()) {
                    let value = text.unescape().map(|v| v.into_owned()).unwrap_or_default();
                    let slot = match field {
                        b"hostname" => &mut entry.host,
                        b"port" => &mut entry.port,
                        b"socketType" => &mut entry.socket,
                        b"username" => &mut entry.username,
                        _ => continue,
                    };
                    // Only the first of each: a file may list several ways
                    // to sign in inside one server entry.
                    if slot.is_empty() {
                        *slot = value;
                    }
                }
            }
            Ok(Event::End(tag)) => {
                let name = tag.name().as_ref().to_vec();
                if name == b"incomingServer" || name == b"outgoingServer" {
                    if let Some((incoming, done)) = entry.take() {
                        let server = done.server(email.trim(), local, &domain);
                        if incoming && done.kind == "imap" && imap.is_none() {
                            imap = server;
                        } else if !incoming && done.kind == "smtp" && smtp.is_none() {
                            smtp = server;
                        }
                    }
                }
                field = None;
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(_) => return None,
        }
    }
    if imap.is_none() && smtp.is_none() {
        return None;
    }
    Some((imap, smtp))
}

/// The domains to ask the directory about for a mail exchanger's name: its
/// last two labels and then its last three. `aspmx.l.google.com` gives
/// `google.com` and `l.google.com`; `mx.example.co.uk` gives `co.uk` (which
/// the directory does not know) and `example.co.uk`.
pub fn provider_domains(exchanger: &str, own_domain: &str) -> Vec<String> {
    let labels: Vec<&str> = exchanger
        .trim_end_matches('.')
        .split('.')
        .filter(|l| !l.is_empty())
        .collect();
    let mut out = Vec::new();
    for take in [2usize, 3] {
        if labels.len() > take {
            let candidate = labels[labels.len() - take..].join(".").to_ascii_lowercase();
            if candidate != own_domain && net::valid_host(&candidate) && !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

/// Providers recognised from the mail exchanger alone, with no request made.
fn known_provider(exchanger: &str, email: &str) -> Option<(Option<Server>, Option<Server>)> {
    let exchanger = exchanger.trim_end_matches('.').to_ascii_lowercase();
    if exchanger == "forwardemail.net" || exchanger.ends_with(".forwardemail.net") {
        let server = |host: &str, port: u16| Server {
            host: host.to_string(),
            port,
            security: "tls",
            username: email.to_string(),
        };
        return Some((
            Some(server("imap.forwardemail.net", 993)),
            Some(server("smtp.forwardemail.net", 465)),
        ));
    }
    None
}

/// The outside world, as the search sees it. Tests answer from a script.
pub trait Sources {
    /// The body of `https://<host><path>` when the answer is 200.
    async fn fetch(&self, host: &str, path: &str) -> Option<String>;
    /// The preferred mail exchanger of a domain.
    async fn exchanger(&self, domain: &str) -> Option<String>;
    /// The preferred target and port of a service record.
    async fn service(&self, name: &str) -> Option<(String, u16)>;
}

pub async fn find(email: &str, sources: &impl Sources) -> Option<Found> {
    let email = email.trim();
    let (_, domain) = split_address(email)?;
    let found = |source, (imap, smtp)| Found { source, imap, smtp };

    let own_host = format!("autoconfig.{domain}");
    if net::valid_host(&own_host) {
        let path = format!("/mail/config-v1.1.xml?emailaddress={}", query_value(email));
        if let Some(xml) = sources.fetch(&own_host, &path).await {
            if let Some(servers) = parse(&xml, email) {
                return Some(found("domain", servers));
            }
        }
    }

    if let Some(xml) = sources
        .fetch(DIRECTORY_HOST, &format!("/v1.1/{domain}"))
        .await
    {
        if let Some(servers) = parse(&xml, email) {
            return Some(found("directory", servers));
        }
    }

    if let Some(exchanger) = sources.exchanger(&domain).await {
        if let Some(servers) = known_provider(&exchanger, email) {
            return Some(found("provider", servers));
        }
        for provider in provider_domains(&exchanger, &domain) {
            if let Some(xml) = sources
                .fetch(DIRECTORY_HOST, &format!("/v1.1/{provider}"))
                .await
            {
                if let Some(servers) = parse(&xml, email) {
                    return Some(found("provider", servers));
                }
            }
        }
    }

    let imap = service_server(
        sources,
        &domain,
        email,
        &[("_imaps", "tls"), ("_imap", "starttls")],
    )
    .await;
    let smtp = service_server(
        sources,
        &domain,
        email,
        &[("_submissions", "tls"), ("_submission", "starttls")],
    )
    .await;
    if imap.is_some() || smtp.is_some() {
        return Some(found("dns", (imap, smtp)));
    }
    None
}

async fn service_server(
    sources: &impl Sources,
    domain: &str,
    email: &str,
    services: &[(&str, &'static str)],
) -> Option<Server> {
    for (service, security) in services {
        let Some((target, port)) = sources.service(&format!("{service}._tcp.{domain}.")).await
        else {
            continue;
        };
        let host = target.trim_end_matches('.').to_ascii_lowercase();
        // A target of "." says the service is not offered.
        if host.is_empty() || port == 0 || !net::valid_host(&host) {
            continue;
        }
        return Some(Server {
            host,
            port,
            security,
            username: email.to_string(),
        });
    }
    None
}

fn query_value(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// One GET, answered with the body when the status is 200. A redirect is not
/// followed.
async fn get<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(
    mut stream: S,
    host: &str,
    path: &str,
) -> Result<Option<String>, MailError> {
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: text/xml, application/xml\r\nUser-Agent: ForwardEmail\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    stream.flush().await?;
    let mut raw = Vec::new();
    (&mut stream)
        .take(MAX_FILE as u64)
        .read_to_end(&mut raw)
        .await?;
    let (status, body) = read_answer(&raw)?;
    if status != 200 {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&body).into_owned()))
}

/// The network and the system's DNS settings.
pub struct Live {
    resolver: Option<hickory_resolver::TokioResolver>,
}

impl Live {
    pub fn new() -> Self {
        let resolver = hickory_resolver::Resolver::builder_tokio()
            .and_then(|builder| builder.build())
            .ok();
        Self { resolver }
    }
}

impl Sources for Live {
    async fn fetch(&self, host: &str, path: &str) -> Option<String> {
        let exchange = async {
            let stream = net::connect_tls(host, 443, false).await?;
            get(stream, host, path).await
        };
        tokio::time::timeout(STEP_TIMEOUT, exchange)
            .await
            .ok()?
            .ok()?
    }

    async fn exchanger(&self, domain: &str) -> Option<String> {
        use hickory_resolver::proto::rr::RData;
        let resolver = self.resolver.as_ref()?;
        let lookup = tokio::time::timeout(STEP_TIMEOUT, resolver.mx_lookup(format!("{domain}.")))
            .await
            .ok()?
            .ok()?;
        lookup
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::MX(mx) => Some((mx.preference, mx.exchange.to_ascii())),
                _ => None,
            })
            .min_by_key(|(preference, _)| *preference)
            .map(|(_, name)| name)
    }

    async fn service(&self, name: &str) -> Option<(String, u16)> {
        use hickory_resolver::proto::rr::RData;
        let resolver = self.resolver.as_ref()?;
        let lookup = tokio::time::timeout(STEP_TIMEOUT, resolver.srv_lookup(name.to_string()))
            .await
            .ok()?
            .ok()?;
        lookup
            .answers()
            .iter()
            .filter_map(|record| match &record.data {
                RData::SRV(srv) => Some((srv.priority, srv.target.to_ascii(), srv.port)),
                _ => None,
            })
            .min_by_key(|(priority, _, _)| *priority)
            .map(|(_, target, port)| (target, port))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    // Shaped like the entry Thunderbird's directory serves for a large
    // provider: several incoming servers, a POP3 one, and more than one way
    // to sign in on each.
    const PROVIDER_FILE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="bigmail.example">
    <domain>bigmail.example</domain>
    <displayName>Big Mail &amp; Co</displayName>
    <incomingServer type="pop3">
      <hostname>pop.bigmail.example</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.bigmail.example</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>OAuth2</authentication>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <incomingServer type="imap">
      <hostname>imap.bigmail.example</hostname>
      <port>143</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILADDRESS%</username>
      <authentication>password-cleartext</authentication>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>smtp.bigmail.example</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <username>%EMAILLOCALPART%</username>
      <authentication>password-cleartext</authentication>
    </outgoingServer>
    <documentation url="https://bigmail.example/help">
      <descr lang="en">How to set up a mail app</descr>
    </documentation>
  </emailProvider>
</clientConfig>"#;

    fn server(host: &str, port: u16, security: &'static str, username: &str) -> Server {
        Server {
            host: host.into(),
            port,
            security,
            username: username.into(),
        }
    }

    #[test]
    fn reads_the_first_imap_and_smtp_servers_and_fills_in_the_username() {
        let (imap, smtp) = parse(PROVIDER_FILE, "Ana.Silva@bigmail.example").unwrap();
        assert_eq!(
            imap,
            Some(server(
                "imap.bigmail.example",
                993,
                "tls",
                "Ana.Silva@bigmail.example"
            ))
        );
        assert_eq!(
            smtp,
            Some(server("smtp.bigmail.example", 587, "starttls", "Ana.Silva"))
        );
    }

    #[test]
    fn a_server_without_tls_is_never_suggested() {
        let xml = r#"<clientConfig version="1.1"><emailProvider id="old.example">
            <incomingServer type="imap"><hostname>mail.old.example</hostname><port>143</port>
              <socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer>
            <incomingServer type="imap"><hostname>mail.old.example</hostname><port>993</port>
              <socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
            <outgoingServer type="smtp"><hostname>mail.old.example</hostname><port>25</port>
              <socketType>plain</socketType><username>%EMAILADDRESS%</username></outgoingServer>
            </emailProvider></clientConfig>"#;
        let (imap, smtp) = parse(xml, "sam@old.example").unwrap();
        assert_eq!(
            imap,
            Some(server("mail.old.example", 993, "tls", "sam@old.example"))
        );
        assert_eq!(smtp, None);
    }

    #[test]
    fn a_host_name_that_is_not_one_is_dropped() {
        for host in [
            "imap.example.com/steal",
            "imap.example.com:993",
            "https://imap.example.com",
            "user@imap.example.com",
            "",
        ] {
            let xml = format!(
                r#"<clientConfig><emailProvider id="x"><incomingServer type="imap">
                <hostname>{host}</hostname><port>993</port><socketType>SSL</socketType>
                </incomingServer></emailProvider></clientConfig>"#
            );
            assert_eq!(parse(&xml, "sam@example.com"), None, "{host}");
        }
    }

    #[test]
    fn the_domain_placeholder_works_in_a_host_name() {
        let xml = r#"<clientConfig><emailProvider id="x"><incomingServer type="imap">
            <hostname>imap.%EMAILDOMAIN%</hostname><port>993</port><socketType>SSL</socketType>
            </incomingServer></emailProvider></clientConfig>"#;
        let (imap, _) = parse(xml, "sam@Example.com").unwrap();
        assert_eq!(
            imap,
            Some(server("imap.example.com", 993, "tls", "sam@Example.com"))
        );
    }

    #[test]
    fn a_page_that_is_not_a_settings_file_gives_nothing() {
        assert_eq!(
            parse("<html><body>Not found</body></html>", "a@b.example"),
            None
        );
        assert_eq!(parse("<clientConfig><emailProvider", "a@b.example"), None);
        assert_eq!(parse("", "a@b.example"), None);
    }

    #[test]
    fn only_an_address_on_a_named_domain_is_looked_up() {
        assert_eq!(
            split_address(" sam@Example.COM "),
            Some(("sam", "example.com".to_string()))
        );
        for bad in [
            "sam",
            "@example.com",
            "sam@",
            "sam@localhost",
            "sam@192.0.2.1",
            "sam@example.com/path",
            "sam smith@example.com",
            "sam@exa mple.com",
        ] {
            assert_eq!(split_address(bad), None, "{bad}");
        }
    }

    #[test]
    fn provider_domains_come_from_the_end_of_the_exchanger_name() {
        assert_eq!(
            provider_domains("aspmx.l.google.com.", "smallshop.example"),
            vec!["google.com", "l.google.com"]
        );
        assert_eq!(
            provider_domains("mx.mailhost.co.uk", "smallshop.example"),
            vec!["co.uk", "mailhost.co.uk"]
        );
        // The domain's own name was already asked about.
        assert_eq!(
            provider_domains("mail.smallshop.example", "smallshop.example"),
            Vec::<String>::new()
        );
    }

    #[derive(Default)]
    struct Script {
        files: HashMap<String, String>,
        exchangers: HashMap<String, String>,
        services: HashMap<String, (String, u16)>,
        asked: Mutex<Vec<String>>,
    }

    impl Script {
        fn file(mut self, address: &str, xml: &str) -> Self {
            self.files.insert(address.into(), xml.into());
            self
        }
        fn exchanger(mut self, domain: &str, host: &str) -> Self {
            self.exchangers.insert(domain.into(), host.into());
            self
        }
        fn service(mut self, name: &str, host: &str, port: u16) -> Self {
            self.services.insert(name.into(), (host.into(), port));
            self
        }
        fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }

    impl Sources for Script {
        async fn fetch(&self, host: &str, path: &str) -> Option<String> {
            let address = format!("{host}{path}");
            self.asked.lock().unwrap().push(address.clone());
            self.files.get(&address).cloned()
        }
        async fn exchanger(&self, domain: &str) -> Option<String> {
            self.asked.lock().unwrap().push(format!("MX {domain}"));
            self.exchangers.get(domain).cloned()
        }
        async fn service(&self, name: &str) -> Option<(String, u16)> {
            self.asked.lock().unwrap().push(format!("SRV {name}"));
            self.services.get(name).cloned()
        }
    }

    fn file_for(host: &str) -> String {
        format!(
            r#"<clientConfig><emailProvider id="x">
            <incomingServer type="imap"><hostname>imap.{host}</hostname><port>993</port>
              <socketType>SSL</socketType><username>%EMAILADDRESS%</username></incomingServer>
            <outgoingServer type="smtp"><hostname>smtp.{host}</hostname><port>465</port>
              <socketType>SSL</socketType><username>%EMAILADDRESS%</username></outgoingServer>
            </emailProvider></clientConfig>"#
        )
    }

    #[tokio::test]
    async fn a_domain_that_publishes_its_own_settings_is_not_reported_to_the_directory() {
        let script = Script::default().file(
            "autoconfig.smallshop.example/mail/config-v1.1.xml?emailaddress=kim%40smallshop.example",
            &file_for("smallshop.example"),
        );
        let found = find("kim@smallshop.example", &script).await.unwrap();
        assert_eq!(found.source, "domain");
        assert_eq!(found.imap.unwrap().host, "imap.smallshop.example");
        assert_eq!(found.smtp.unwrap().port, 465);
        assert_eq!(script.asked().len(), 1, "{:?}", script.asked());
    }

    #[tokio::test]
    async fn the_directory_is_asked_about_the_domain_and_never_the_address() {
        let script = Script::default().file(
            "autoconfig.thunderbird.net/v1.1/bigmail.example",
            PROVIDER_FILE,
        );
        let found = find("ana@bigmail.example", &script).await.unwrap();
        assert_eq!(found.source, "directory");
        assert_eq!(found.imap.unwrap().username, "ana@bigmail.example");
        for asked in script.asked() {
            if asked.starts_with("autoconfig.thunderbird.net") {
                assert!(!asked.contains("ana"), "{asked}");
            }
        }
    }

    #[tokio::test]
    async fn a_domain_hosted_by_a_provider_gets_the_providers_settings() {
        let script = Script::default()
            .exchanger("smallshop.example", "mx1.bigmail.example.")
            .file(
                "autoconfig.thunderbird.net/v1.1/bigmail.example",
                PROVIDER_FILE,
            );
        let found = find("kim@smallshop.example", &script).await.unwrap();
        assert_eq!(found.source, "provider");
        let imap = found.imap.unwrap();
        assert_eq!(imap.host, "imap.bigmail.example");
        // The username is the user's own address, not one at the provider.
        assert_eq!(imap.username, "kim@smallshop.example");
    }

    #[tokio::test]
    async fn a_domain_on_forward_email_needs_no_directory() {
        let script = Script::default().exchanger("smallshop.example", "mx1.forwardemail.net.");
        let found = find("kim@smallshop.example", &script).await.unwrap();
        assert_eq!(found.source, "provider");
        assert_eq!(
            found.imap,
            Some(server(
                "imap.forwardemail.net",
                993,
                "tls",
                "kim@smallshop.example"
            ))
        );
        assert_eq!(
            found.smtp,
            Some(server(
                "smtp.forwardemail.net",
                465,
                "tls",
                "kim@smallshop.example"
            ))
        );
        // Only the domain's own name went to the directory.
        let directory: Vec<String> = script
            .asked()
            .into_iter()
            .filter(|a| a.starts_with("autoconfig.thunderbird.net"))
            .collect();
        assert_eq!(
            directory,
            vec!["autoconfig.thunderbird.net/v1.1/smallshop.example"]
        );
    }

    #[tokio::test]
    async fn service_records_are_the_last_resort_and_prefer_tls_from_the_start() {
        let script = Script::default()
            .service(
                "_imaps._tcp.smallshop.example.",
                "mail.smallshop.example.",
                993,
            )
            .service(
                "_imap._tcp.smallshop.example.",
                "mail.smallshop.example.",
                143,
            )
            .service("_submissions._tcp.smallshop.example.", ".", 0)
            .service(
                "_submission._tcp.smallshop.example.",
                "mail.smallshop.example.",
                587,
            );
        let found = find("kim@smallshop.example", &script).await.unwrap();
        assert_eq!(found.source, "dns");
        assert_eq!(
            found.imap,
            Some(server(
                "mail.smallshop.example",
                993,
                "tls",
                "kim@smallshop.example"
            ))
        );
        // "." with port 0 says the service is not offered there.
        assert_eq!(
            found.smtp,
            Some(server(
                "mail.smallshop.example",
                587,
                "starttls",
                "kim@smallshop.example"
            ))
        );
    }

    #[tokio::test]
    async fn nothing_found_is_not_an_error() {
        assert_eq!(
            find("kim@smallshop.example", &Script::default()).await,
            None
        );
        assert_eq!(find("not an address", &Script::default()).await, None);
    }

    #[tokio::test]
    async fn a_fetch_asks_for_the_file_and_ignores_a_redirect() {
        use tokio::io::duplex;

        let (client, mut server) = duplex(4096);
        let serve = tokio::spawn(async move {
            let mut seen = vec![0u8; 1024];
            let n = server.read(&mut seen).await.unwrap();
            server
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/xml\r\n\r\n<clientConfig/>")
                .await
                .unwrap();
            String::from_utf8_lossy(&seen[..n]).into_owned()
        });
        let body = get(client, "autoconfig.example.com", "/mail/config-v1.1.xml")
            .await
            .unwrap();
        assert_eq!(body.as_deref(), Some("<clientConfig/>"));
        let request = serve.await.unwrap();
        assert!(request.starts_with("GET /mail/config-v1.1.xml HTTP/1.1\r\n"));
        assert!(request.contains("\r\nHost: autoconfig.example.com\r\n"));

        let (client, mut server) = duplex(4096);
        tokio::spawn(async move {
            let mut seen = vec![0u8; 1024];
            let _ = server.read(&mut seen).await;
            let _ = server
                .write_all(b"HTTP/1.1 302 Found\r\nLocation: https://elsewhere.example/\r\n\r\n")
                .await;
        });
        let body = get(client, "autoconfig.example.com", "/mail/config-v1.1.xml")
            .await
            .unwrap();
        assert_eq!(body, None);
    }

    // Needs the internet, so it is skipped unless asked for:
    // cargo test --lib mail::autoconfig -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn finds_real_providers_over_the_network() {
        let live = Live::new();
        let gmail = find("someone@gmail.com", &live).await.unwrap();
        assert_eq!(gmail.source, "directory");
        assert_eq!(gmail.imap.unwrap().host, "imap.gmail.com");

        let exchanger = live.exchanger("forwardemail.net").await.unwrap();
        assert!(
            exchanger
                .trim_end_matches('.')
                .ends_with("forwardemail.net"),
            "{exchanger}"
        );
        let hosted = find("someone@forwardemail.net", &live).await.unwrap();
        assert_eq!(hosted.imap.unwrap().host, "imap.forwardemail.net");
    }
}
