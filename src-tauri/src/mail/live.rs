//! The mail engine against a real server.
//!
//! The other tests in this module check how commands are written and how
//! answers are read, with the server played by a script. These run the same
//! functions the app calls against ImapKit, an in-memory IMAP and SMTP server
//! that is strict about the RFCs, so a command a real server would refuse
//! fails here and not in someone's mailbox.
//!
//! `pnpm test:mail-engine` starts the server and runs them. They are ignored
//! by a plain `cargo test`, which has no server to talk to. Every test resets
//! the server to the mailboxes in scripts/test-mail-engine.mjs first:
//!
//!   INBOX  1  "Lunch on Thursday?" from Bob, read
//!          2  "Quarterly report" from Zoe, unread, with a 2 MB PDF
//!          3  "Réunion du comité" from Renée, unread, starred, labelled work
//!   Drafts, Sent, Trash, Archive, Clients/Acme, Entwürfe

use std::sync::Arc;
use std::time::Duration;

use async_imap::extensions::idle::IdleResponse;
use base64::Engine;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::rustls::client::danger::{
    HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
};
use tokio_rustls::rustls::crypto::{
    verify_tls12_signature, verify_tls13_signature, CryptoProvider,
};
use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use tokio_rustls::rustls::{
    ClientConfig, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use tokio_rustls::TlsConnector;

use super::imap::{self, SearchQuery, Session};
use super::{lean, oauth, smtp};

const USER: &str = "testuser";
const PASSWORD: &str = "testpass";

fn port(name: &str) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or_else(|| panic!("{name} is not set. Run these with: pnpm test:mail-engine"))
}

fn run<F: std::future::Future>(fut: F) -> F::Output {
    tauri::async_runtime::block_on(fut)
}

/// The test server's certificate is its own. The engine proper only ever
/// trusts the operating system's store (net.rs); this is for these tests.
#[derive(Debug)]
struct TestServerCert(Arc<CryptoProvider>);

impl ServerCertVerifier for TestServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// TLS to the test server, on a connection that is already open.
async fn secure(tcp: TcpStream) -> tokio_rustls::client::TlsStream<TcpStream> {
    let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(TestServerCert(provider)))
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("localhost").unwrap(), tcp)
        .await
        .expect("TLS to the test server")
}

async fn connect(password: &str) -> Result<Session, super::MailError> {
    connect_as(USER, password, imap::Auth::Password).await
}

async fn connect_as(
    user: &str,
    password: &str,
    auth: imap::Auth,
) -> Result<Session, super::MailError> {
    let tcp = TcpStream::connect(("127.0.0.1", port("MAIL_TEST_IMAP_TLS_PORT")))
        .await
        .expect("the test IMAP server is not listening");
    let tls = secure(tcp).await;
    let mut client = async_imap::Client::new(tls);
    imap::read_greeting(&mut client).await?;
    imap::sign_in(client, user, password, auth).await
}

/// One request to the test server's control port. Returns the answer's body.
async fn control(method: &str, path: &str, body: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port("MAIL_TEST_CONTROL_PORT")))
        .await
        .expect("the test server's control port is not listening");
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let answer = String::from_utf8_lossy(&answer).into_owned();
    let status = answer.lines().next().unwrap_or_default().to_string();
    assert!(
        status.contains(" 200") || status.contains(" 201") || status.contains(" 204"),
        "{method} {path}: {status}\n{answer}"
    );
    answer
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.to_string())
        .unwrap_or_default()
}

/// The mailboxes back as the fixture has them, and a new signed-in session.
async fn fresh() -> Session {
    control("POST", "/v1/reset", "{}").await;
    connect(PASSWORD).await.expect("sign in to the test server")
}

fn counter() -> imap::ChangeCounter {
    imap::ChangeCounter::default()
}

fn header_text(row: &imap::Row) -> String {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&row.header)
        .unwrap();
    String::from_utf8_lossy(&bytes).into_owned()
}

fn uids(page: &imap::Page) -> Vec<u32> {
    page.rows.iter().map(|row| row.uid).collect()
}

async fn find(
    session: &mut Session,
    folder: &str,
    build: impl FnOnce(&mut SearchQuery),
) -> Vec<u32> {
    let mut query = SearchQuery::default();
    build(&mut query);
    imap::search(session, folder, &query)
        .await
        .expect("the server accepted the search")
        .uids
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn signs_in_and_reports_a_wrong_password_as_one() {
    run(async {
        let mut session = fresh().await;
        assert!(session.noop().await.is_ok());

        let refused = connect("not the password").await.err().expect("refused");
        assert_eq!(refused.kind, "auth");
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn lists_folders_with_their_counts_and_roles() {
    run(async {
        let mut session = fresh().await;
        let folders = imap::folders(&mut session).await.unwrap();
        let by_path = |path: &str| {
            folders.iter().find(|f| f.path == path).unwrap_or_else(|| {
                panic!(
                    "no folder {path} in {:?}",
                    folders.iter().map(|f| &f.path).collect::<Vec<_>>()
                )
            })
        };

        let inbox = by_path("INBOX");
        assert_eq!(inbox.total, Some(3));
        assert_eq!(inbox.unseen, Some(2));
        assert!(inbox.uid_validity.is_some());

        assert_eq!(by_path("Drafts").special_use, Some("drafts"));
        assert_eq!(by_path("Sent").special_use, Some("sent"));
        assert_eq!(by_path("Trash").special_use, Some("trash"));
        assert_eq!(by_path("Archive").special_use, Some("archive"));
        assert_eq!(by_path("Clients/Acme").delimiter.as_deref(), Some("/"));
        // Stored by the server as "Entw&APw-rfe".
        assert!(by_path("Entwürfe").selectable);
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn pages_a_folder_newest_first() {
    run(async {
        let mut session = fresh().await;

        let first = imap::rows(&mut session, "INBOX", 1, 2, &counter())
            .await
            .unwrap();
        assert_eq!(first.total, 3);
        assert_eq!(uids(&first), vec![3, 2]);
        let newest = &first.rows[0];
        assert!(newest.flags.iter().any(|f| f == "\\Flagged"));
        assert!(newest.flags.iter().any(|f| f == "work"));
        assert!(newest
            .internal_date
            .as_deref()
            .unwrap()
            .starts_with("2026-11-03"));
        assert!(header_text(newest).contains("Message-ID: <reunion.7@example.fr>"));
        assert!(newest.size.unwrap() > 0);

        let second = imap::rows(&mut session, "INBOX", 2, 2, &counter())
            .await
            .unwrap();
        assert_eq!(uids(&second), vec![1]);
        assert!(second.rows[0].flags.iter().any(|f| f == "\\Seen"));

        let past_the_end = imap::rows(&mut session, "INBOX", 3, 2, &counter())
            .await
            .unwrap();
        assert!(past_the_end.rows.is_empty());
        let empty = imap::rows(&mut session, "Archive", 1, 50, &counter())
            .await
            .unwrap();
        assert_eq!((empty.total, empty.rows.len()), (0, 0));
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn search_finds_what_each_field_asks_for() {
    run(async {
        let mut s = fresh().await;

        assert_eq!(find(&mut s, "INBOX", |_| {}).await, vec![3, 2, 1]);
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(true)).await,
            vec![3, 2]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(false)).await,
            vec![1]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.flagged = Some(true)).await,
            vec![3]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.keyword = Some("work".into())).await,
            vec![3]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.text = Some("usual place".into())).await,
            vec![1]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.subject = Some("lunch".into())).await,
            vec![1]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.from = Some("zoe@example.net".into())).await,
            vec![2]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.to = Some("testuser".into())).await,
            vec![3, 2, 1]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.body = Some("ledger".into())).await,
            vec![2]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.since = Some("2026-11-02".into())).await,
            vec![3, 2]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.before = Some("2026-11-02".into())).await,
            vec![1]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.message_id =
                Some("<lunch.1@example.com>".into()))
            .await,
            vec![1]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.has_attachment = Some(true)).await,
            vec![2]
        );
        // Several fields at once all have to match.
        assert_eq!(
            find(&mut s, "INBOX", |q| {
                q.unseen = Some(true);
                q.from = Some("renee".into());
            })
            .await,
            vec![3]
        );
        assert!(find(&mut s, "INBOX", |q| q.text =
            Some("no such words here".into()))
        .await
        .is_empty());
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn search_text_with_quotes_and_other_scripts_is_accepted() {
    run(async {
        let mut s = fresh().await;

        // Words that are not plain ASCII, in the body and in an encoded subject.
        assert_eq!(
            find(&mut s, "INBOX", |q| q.body =
                Some("reportée à jeudi".into()))
            .await,
            vec![3]
        );
        assert_eq!(
            find(&mut s, "INBOX", |q| q.subject = Some("Réunion".into())).await,
            vec![3]
        );
        // Characters that would end a quoted string if they were not escaped.
        assert!(find(&mut s, "INBOX", |q| q.text =
            Some(r#"say "hi" \ bye"#.into()))
        .await
        .is_empty());
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn a_search_the_server_refuses_is_an_error_not_an_empty_answer() {
    run(async {
        let mut s = fresh().await;
        // Not a folder: the search never gets as far as matching anything.
        let refused = imap::search(&mut s, "No such folder", &SearchQuery::default()).await;
        assert!(refused.is_err());
        // The connection is still good for the next command.
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(false)).await,
            vec![1]
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn fetches_the_rows_of_chosen_messages() {
    run(async {
        let mut session = fresh().await;
        let page = imap::rows_for(&mut session, "INBOX", &[1, 3, 99])
            .await
            .unwrap();
        // Newest first, and a UID the folder does not have is left out.
        assert_eq!(uids(&page), vec![3, 1]);
        assert!(header_text(&page.rows[1]).contains("Subject: Lunch on Thursday?"));
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn changes_flags_and_labels() {
    run(async {
        let mut s = fresh().await;

        imap::store(&mut s, "INBOX", 2, &strings(&["\\Seen", "client-a"]), &[])
            .await
            .unwrap();
        let row = imap::row(&mut s, "INBOX", 2).await.unwrap().unwrap();
        assert!(row.flags.iter().any(|f| f == "\\Seen"));
        assert!(row.flags.iter().any(|f| f == "client-a"));
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(true)).await,
            vec![3]
        );

        imap::store(&mut s, "INBOX", 2, &[], &strings(&["\\Seen"]))
            .await
            .unwrap();
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(true)).await,
            vec![3, 2]
        );
        // The label stays when only the read state changes.
        assert_eq!(
            find(&mut s, "INBOX", |q| q.keyword = Some("client-a".into())).await,
            vec![2]
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn reads_how_much_storage_is_used_and_allowed() {
    run(async {
        let mut s = fresh().await;
        let before = imap::storage(&mut s)
            .await
            .unwrap()
            .expect("the test server sets a storage limit");
        assert_eq!(before.total, 102_400 * 1024);
        assert!(before.used > 0 && before.used < before.total);

        // 64 KB more mail is counted.
        let mut message = b"Message-ID: <big.1@example.com>\r\nSubject: Padding\r\n\r\n".to_vec();
        message.extend(std::iter::repeat(b'x').take(64 * 1024));
        imap::append(&mut s, "INBOX", &[], &message).await.unwrap();
        let after = imap::storage(&mut s).await.unwrap().unwrap();
        assert!(
            after.used >= before.used + 60 * 1024,
            "{before:?} {after:?}"
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn says_only_what_changed_since_the_folder_was_last_read() {
    run(async {
        let mut s = fresh().await;
        let counter = counter();
        let page = imap::rows(&mut s, "INBOX", 1, 50, &counter).await.unwrap();
        let read_at = page.highest_modseq.expect("the server counts changes");

        // Nothing has happened: nothing is listed, and the counter stands.
        let quiet = imap::changes(&mut s, "INBOX", &read_at, &counter)
            .await
            .unwrap()
            .unwrap();
        assert!(quiet.uids.is_empty());
        assert_eq!(quiet.highest_modseq, read_at);
        assert_eq!(quiet.uid_validity, page.uid_validity);

        // A flag changes on an old message and a new message arrives.
        imap::store(&mut s, "INBOX", 1, &strings(&["\\Flagged"]), &[])
            .await
            .unwrap();
        imap::append(
            &mut s,
            "INBOX",
            &[],
            b"Message-ID: <new.1@example.com>\r\nSubject: Just in\r\n\r\nx\r\n",
        )
        .await
        .unwrap();
        let newest = imap::rows(&mut s, "INBOX", 1, 1, &counter)
            .await
            .unwrap()
            .rows[0]
            .uid;

        let changed = imap::changes(&mut s, "INBOX", &read_at, &counter)
            .await
            .unwrap()
            .unwrap();
        // Newest first, and the two untouched messages are not there.
        assert_eq!(changed.uids, vec![newest, 1]);
        assert_ne!(changed.highest_modseq, read_at);

        // Asked again from where that left off, there is nothing more.
        let after = imap::changes(&mut s, "INBOX", &changed.highest_modseq, &counter)
            .await
            .unwrap()
            .unwrap();
        assert!(after.uids.is_empty());

        // An empty folder is not an error.
        let empty = imap::changes(&mut s, "Archive", "0", &counter)
            .await
            .unwrap()
            .unwrap();
        assert!(empty.uids.is_empty());
        assert!(imap::changes(&mut s, "INBOX", "soon", &counter)
            .await
            .is_err());
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn moves_a_message_and_says_where_it_went() {
    run(async {
        let mut s = fresh().await;

        let moved = imap::move_message(&mut s, "INBOX", 1, "Archive")
            .await
            .unwrap()
            .expect("the moved message was found by its Message-ID");

        assert!(imap::row(&mut s, "INBOX", 1).await.unwrap().is_none());
        assert_eq!(
            imap::rows(&mut s, "INBOX", 1, 50, &counter())
                .await
                .unwrap()
                .total,
            2
        );
        let there = imap::row(&mut s, "Archive", moved.uid)
            .await
            .unwrap()
            .unwrap();
        assert!(header_text(&there).contains("Subject: Lunch on Thursday?"));
        assert!(moved.uid_validity.is_some());
        // Read state travels with the message.
        assert!(there.flags.iter().any(|f| f == "\\Seen"));
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn moves_a_message_that_has_no_message_id() {
    run(async {
        let mut s = fresh().await;
        let saved = imap::append(
            &mut s,
            "INBOX",
            &[],
            b"Subject: Scanned page\r\n\r\nNo id on this one.\r\n",
        )
        .await
        .unwrap();
        // Nothing to look it up by.
        assert!(saved.is_none());
        let uid = imap::rows(&mut s, "INBOX", 1, 1, &counter())
            .await
            .unwrap()
            .rows[0]
            .uid;

        let moved = imap::move_message(&mut s, "INBOX", uid, "Clients/Acme")
            .await
            .unwrap();

        assert!(moved.is_none());
        let there = imap::rows(&mut s, "Clients/Acme", 1, 50, &counter())
            .await
            .unwrap();
        assert_eq!(there.total, 1);
        assert!(header_text(&there.rows[0]).contains("Subject: Scanned page"));
        assert_eq!(
            imap::rows(&mut s, "INBOX", 1, 50, &counter())
                .await
                .unwrap()
                .total,
            3
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn moves_several_messages_at_once_and_says_where_each_went() {
    run(async {
        let mut s = fresh().await;
        // Something already in the destination, so new UIDs do not start at 1.
        imap::append(
            &mut s,
            "Archive",
            &[],
            b"Message-ID: <old.1@example.com>\r\nSubject: Already filed\r\n\r\nx\r\n",
        )
        .await
        .unwrap();
        let before: Vec<(u32, String)> = imap::rows(&mut s, "INBOX", 1, 50, &counter())
            .await
            .unwrap()
            .rows
            .iter()
            .map(|row| (row.uid, header_text(row)))
            .collect();
        assert_eq!(before.len(), 3);

        // 2 is named twice and 99 is not there: neither is an error.
        let moved = imap::move_many(&mut s, "INBOX", &[3, 1, 3, 99], "Archive")
            .await
            .unwrap();

        assert_eq!(moved.iter().map(|m| m.uid).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(
            uids(
                &imap::rows(&mut s, "INBOX", 1, 50, &counter())
                    .await
                    .unwrap()
            ),
            vec![2]
        );
        assert_eq!(
            imap::rows(&mut s, "Archive", 1, 50, &counter())
                .await
                .unwrap()
                .total,
            3
        );
        for one in &moved {
            let place = one.located.as_ref().expect("found by its Message-ID");
            assert!(place.uid_validity.is_some());
            let there = imap::row(&mut s, "Archive", place.uid)
                .await
                .unwrap()
                .unwrap();
            let was = &before.iter().find(|(uid, _)| *uid == one.uid).unwrap().1;
            let subject = |text: &str| {
                text.lines()
                    .find(|line| line.starts_with("Subject:"))
                    .map(str::to_string)
            };
            // Each old UID is paired with its own message, not a neighbour's.
            assert_eq!(subject(&header_text(&there)), subject(was));
        }
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn changes_flags_on_several_messages_at_once() {
    run(async {
        let mut s = fresh().await;
        imap::store_many(&mut s, "INBOX", &[1, 3], &strings(&["\\Flagged"]), &[])
            .await
            .unwrap();
        let mut flagged = find(&mut s, "INBOX", |q| q.flagged = Some(true)).await;
        flagged.sort_unstable();
        assert_eq!(flagged, vec![1, 3]);

        imap::store_many(
            &mut s,
            "INBOX",
            &[1, 2, 3],
            &strings(&["\\Seen"]),
            &strings(&["\\Flagged"]),
        )
        .await
        .unwrap();
        assert!(find(&mut s, "INBOX", |q| q.flagged = Some(true))
            .await
            .is_empty());
        assert!(find(&mut s, "INBOX", |q| q.unseen = Some(true))
            .await
            .is_empty());
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn deletes_several_messages_at_once_and_leaves_the_rest() {
    run(async {
        let mut s = fresh().await;
        imap::delete_many(&mut s, "INBOX", &[1, 3, 99])
            .await
            .unwrap();
        assert_eq!(
            uids(
                &imap::rows(&mut s, "INBOX", 1, 50, &counter())
                    .await
                    .unwrap()
            ),
            vec![2]
        );
        // Nothing to do is not an error.
        imap::delete_many(&mut s, "INBOX", &[]).await.unwrap();
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn deletes_one_message_and_leaves_the_rest() {
    run(async {
        let mut s = fresh().await;
        imap::delete_message(&mut s, "INBOX", 2).await.unwrap();
        assert_eq!(
            uids(
                &imap::rows(&mut s, "INBOX", 1, 50, &counter())
                    .await
                    .unwrap()
            ),
            vec![3, 1]
        );
        // Deleting what is already gone is not an error.
        imap::delete_message(&mut s, "INBOX", 2).await.unwrap();
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn saves_a_draft_and_reads_back_exactly_what_was_saved() {
    run(async {
        let mut s = fresh().await;
        let draft = b"From: testuser@example.org\r\nTo: bob@example.com\r\nSubject: Re: Lunch on Thursday?\r\nMessage-ID: <draft.42@example.org>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nTm9vbiB3b3JrcyBmb3IgbWUu\r\n";

        let saved = imap::append(&mut s, "Drafts", &strings(&["\\Draft", "\\Seen"]), draft)
            .await
            .unwrap()
            .expect("the saved draft was found by its Message-ID");

        let row = imap::row(&mut s, "Drafts", saved.uid)
            .await
            .unwrap()
            .unwrap();
        assert!(row.flags.iter().any(|f| f == "\\Draft"));
        assert!(row.flags.iter().any(|f| f == "\\Seen"));
        let stored = imap::raw(&mut s, "Drafts", saved.uid)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(stored, draft.to_vec());

        // Saving the next version, then removing this one, as the app does.
        let next = imap::append(
            &mut s,
            "Drafts",
            &strings(&["\\Draft", "\\Seen"]),
            b"Subject: Re: Lunch on Thursday?\r\nMessage-ID: <draft.43@example.org>\r\n\r\nNoon works.\r\n",
        )
        .await
        .unwrap()
        .unwrap();
        imap::delete_message(&mut s, "Drafts", saved.uid)
            .await
            .unwrap();
        assert_eq!(
            uids(
                &imap::rows(&mut s, "Drafts", 1, 50, &counter())
                    .await
                    .unwrap()
            ),
            vec![next.uid]
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn creates_renames_and_deletes_folders() {
    run(async {
        let mut s = fresh().await;
        let paths =
            |folders: Vec<imap::Folder>| folders.into_iter().map(|f| f.path).collect::<Vec<_>>();

        imap::create_folder(&mut s, "Projekte").await.unwrap();
        imap::create_folder(&mut s, "Projekte/Größe & Maße")
            .await
            .unwrap();
        let listed = paths(imap::folders(&mut s).await.unwrap());
        assert!(
            listed.contains(&"Projekte/Größe & Maße".to_string()),
            "{listed:?}"
        );

        // The folders inside a renamed folder move with it.
        imap::rename_folder(&mut s, "Projekte", "Projects")
            .await
            .unwrap();
        let listed = paths(imap::folders(&mut s).await.unwrap());
        assert!(
            listed.contains(&"Projects/Größe & Maße".to_string()),
            "{listed:?}"
        );
        assert!(
            !listed.iter().any(|p| p.starts_with("Projekte")),
            "{listed:?}"
        );

        imap::delete_folder(&mut s, "Projects/Größe & Maße")
            .await
            .unwrap();
        imap::delete_folder(&mut s, "Projects").await.unwrap();
        let listed = paths(imap::folders(&mut s).await.unwrap());
        assert!(
            !listed.iter().any(|p| p.starts_with("Projects")),
            "{listed:?}"
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn reads_a_small_message_whole() {
    run(async {
        let mut s = fresh().await;
        let whole = imap::raw(&mut s, "INBOX", 1).await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&whole);
        assert!(text.starts_with("From: Bob Stone <bob@example.com>\r\n"));
        assert!(text.ends_with("\r\n\r\nNoon at the usual place?\r\n"));

        // Under the size limit, the reader gets the same bytes.
        assert_eq!(
            lean::message(&mut s, "INBOX", 1).await.unwrap().unwrap(),
            whole
        );
        // Reading does not mark a message read.
        imap::raw(&mut s, "INBOX", 2).await.unwrap().unwrap();
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(true)).await,
            vec![3, 2]
        );
        assert!(imap::raw(&mut s, "INBOX", 99).await.unwrap().is_none());
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn reads_a_large_message_without_its_attachment_then_fetches_it() {
    run(async {
        let mut s = fresh().await;
        let whole = imap::raw(&mut s, "INBOX", 2).await.unwrap().unwrap();
        assert!(whole.len() > 2_000_000);

        let lean_copy = lean::message(&mut s, "INBOX", 2).await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&lean_copy).into_owned();

        assert!(lean_copy.len() < 4_000, "{} bytes", lean_copy.len());
        // The headers, the structure and both bodies are all there.
        assert!(text.starts_with("From: Zoe Muller <zoe@example.net>\r\n"));
        assert!(text.contains("Content-Type: multipart/mixed; boundary=\"outer\""));
        assert!(text.contains("\r\n\r\nThe ledger is attached.\r\n--inner\r\n"));
        assert!(text.contains("<p>The ledger is <b>attached</b>.</p>"));
        assert!(text.contains("Content-Disposition: attachment; filename=\"ledger.pdf\""));
        assert!(text.trim_end().ends_with("--outer--"));
        // Where the PDF was, a marker in the part's own encoding.
        let stand_in = text
            .split("filename=\"ledger.pdf\"\r\n\r\n")
            .nth(1)
            .and_then(|rest| rest.lines().next())
            .expect("the attachment's part has a body");
        let marker = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(stand_in)
                .unwrap(),
        )
        .unwrap();
        let words: Vec<&str> = marker.split(' ').collect();
        assert_eq!(words[0], lean::MARKER);
        assert_eq!(words[1], "2");
        assert!(words[2].parse::<u32>().unwrap() > 2_000_000);
        assert_eq!(words[3], "base64");

        // Opening the attachment fetches that part alone.
        let part = lean::part(&mut s, "INBOX", 2, words[1])
            .await
            .unwrap()
            .unwrap();
        let encoded: Vec<u8> = part
            .into_iter()
            .filter(|b| !b.is_ascii_whitespace())
            .collect();
        let file = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .unwrap();
        assert_eq!(file.len(), 2 * 1024 * 1024);
        assert!(file.starts_with(b"forwardemail-forwardemail-"));

        // A part the message does not have. Some servers answer with nothing
        // at all and some with an empty part; neither is a file.
        let missing = lean::part(&mut s, "INBOX", 2, "7").await.unwrap();
        assert!(missing.is_none_or(|bytes| bytes.is_empty()));
        assert_eq!(
            find(&mut s, "INBOX", |q| q.unseen = Some(true)).await,
            vec![3, 2]
        );
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn hears_about_new_mail_while_parked_on_the_inbox() {
    run(async {
        let mut session = fresh().await;
        imap::examine(&mut session, "INBOX").await.unwrap();

        // As watch.rs does it.
        let mut idle = session.idle();
        idle.init().await.expect("the server accepted IDLE");
        let arrives = tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            control(
                "POST",
                "/v1/mailboxes/INBOX/messages",
                r#"{"raw":"Subject: Just arrived\r\nMessage-ID: <new.1@example.com>\r\n\r\nHello.\r\n","flags":[]}"#,
            )
            .await;
        });
        let response = {
            let (wait, _keep_waiting) = idle.wait_with_timeout(Duration::from_secs(15));
            wait.await.unwrap()
        };
        arrives.await.unwrap();
        assert!(matches!(response, IdleResponse::NewData(_)), "{response:?}");

        // The same connection is usable again once the wait is over.
        let mut session = idle.done().await.expect("the server accepted DONE");
        let page = imap::rows(&mut session, "INBOX", 1, 1, &counter())
            .await
            .unwrap();
        assert_eq!(page.total, 4);
        assert!(header_text(&page.rows[0]).contains("Subject: Just arrived"));
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn sends_a_message_that_arrives_as_it_was_written() {
    run(async {
        let mut session = fresh().await;
        let message = b"From: testuser@example.org\r\nTo: bob@example.com\r\nSubject: Sent through the engine\r\nMessage-ID: <sent.9@example.org>\r\n\r\nFirst line.\r\n.A line that starts with a dot.\r\n..\r\nLast line.\r\n";

        let tcp = TcpStream::connect(("127.0.0.1", port("MAIL_TEST_SMTP_PORT")))
            .await
            .expect("the test SMTP server is not listening");
        let mut conn = smtp::Conn::new(tcp);
        smtp::greeting(&mut conn).await.unwrap();
        let caps = smtp::ehlo(&mut conn).await.unwrap();
        smtp::deliver(
            &mut conn,
            &caps,
            "testuser@example.org",
            &strings(&["bob@example.com", "carol@example.com"]),
            message,
        )
        .await
        .expect("the server took the message");

        // The test server files what it receives in INBOX.
        let found = find(&mut session, "INBOX", |q| {
            q.message_id = Some("<sent.9@example.org>".into())
        })
        .await;
        assert_eq!(found.len(), 1, "{found:?}");
        let arrived = imap::raw(&mut session, "INBOX", found[0])
            .await
            .unwrap()
            .unwrap();
        let text = String::from_utf8_lossy(&arrived);
        assert!(
            text.ends_with(
                "\r\n\r\nFirst line.\r\n.A line that starts with a dot.\r\n..\r\nLast line.\r\n"
            ),
            "{text}"
        );
    });
}

/// A GET without following where it leads. Returns the status line and the
/// Location header.
async fn get(url: &str) -> (String, Option<String>) {
    let rest = url.strip_prefix("http://").expect("a local http address");
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let mut stream = TcpStream::connect(authority).await.expect("connect");
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let answer = String::from_utf8_lossy(&answer).into_owned();
    let location = answer
        .lines()
        .find_map(|line| {
            line.strip_prefix("Location: ")
                .or(line.strip_prefix("location: "))
        })
        .map(str::to_string);
    (
        answer.lines().next().unwrap_or_default().to_string(),
        location,
    )
}

/// What the user's browser does: open the sign-in page, then go where the
/// provider sends it, which is back to this app.
fn browser(url: String) -> tokio::task::JoinHandle<String> {
    tokio::spawn(async move {
        let (status, back) = get(&url).await;
        let back = back.unwrap_or_else(|| panic!("the sign-in page did not redirect: {status}"));
        get(&back).await.0
    })
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn signs_in_through_a_providers_page_and_uses_the_token_for_mail() {
    run(async {
        control("POST", "/v1/reset", "{}").await;
        // This client is approved without a person clicking Allow.
        let provider = oauth::test_provider(
            port("MAIL_TEST_OAUTH_PORT"),
            "imapkit-approve",
            "alice@example.com",
        );

        let pending = oauth::begin(provider.clone()).await.unwrap();
        let visit = browser(pending.url.clone());
        let tokens = oauth::finish(pending, Duration::from_secs(15))
            .await
            .unwrap();
        assert!(visit.await.unwrap().contains(" 200"));

        assert_eq!(tokens.email.as_deref(), Some("alice@example.com"));
        let refresh_token = tokens
            .refresh_token
            .clone()
            .expect("a way to stay signed in");
        assert!(tokens.expires_in > 0);

        // The token opens the mailbox.
        let mut session = connect_as(
            "alice@example.com",
            &tokens.access_token,
            imap::Auth::Xoauth2,
        )
        .await
        .expect("the server took the token");
        assert_eq!(
            imap::rows(&mut session, "INBOX", 1, 50, &counter())
                .await
                .unwrap()
                .total,
            3
        );

        // One that is not a token is a refused sign-in, not a server fault.
        let refused = connect_as("alice@example.com", "not-a-token", imap::Auth::Xoauth2)
            .await
            .err()
            .expect("refused");
        assert_eq!(refused.kind, "auth");
        // A token is not accepted as a password either.
        assert!(connect_as(
            "alice@example.com",
            &tokens.access_token,
            imap::Auth::Password
        )
        .await
        .is_err());

        // Staying signed in: a new token from the saved one.
        let renewed = oauth::refresh(&provider, &refresh_token).await.unwrap();
        assert_ne!(renewed.access_token, tokens.access_token);
        connect_as(
            "alice@example.com",
            &renewed.access_token,
            imap::Auth::Xoauth2,
        )
        .await
        .expect("the server took the renewed token");

        // And the same token signs in to send.
        let tcp = TcpStream::connect(("127.0.0.1", port("MAIL_TEST_SMTP_PORT")))
            .await
            .unwrap();
        // As the engine does on a STARTTLS port: upgrade, ask again what the
        // server offers, and only then sign in.
        let mut plain = smtp::Conn::new(tcp);
        smtp::greeting(&mut plain).await.unwrap();
        smtp::ehlo(&mut plain).await.unwrap();
        assert_eq!(plain.command("STARTTLS").await.unwrap().code, 220);
        let mut conn = smtp::Conn::new(secure(plain.into_inner().unwrap()).await);
        let caps = smtp::ehlo(&mut conn).await.unwrap();
        smtp::authenticate(
            &mut conn,
            &caps,
            "alice@example.com",
            &renewed.access_token,
            imap::Auth::Xoauth2,
        )
        .await
        .expect("the SMTP server took the token");
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn a_sign_in_the_user_declines_is_reported_as_declined() {
    run(async {
        // This client is always refused, as if the user pressed Deny.
        let provider = oauth::test_provider(
            port("MAIL_TEST_OAUTH_PORT"),
            "imapkit-deny",
            "alice@example.com",
        );
        let pending = oauth::begin(provider).await.unwrap();
        let visit = browser(pending.url.clone());

        let declined = oauth::finish(pending, Duration::from_secs(15))
            .await
            .unwrap_err();

        assert_eq!(declined.kind, "denied");
        visit.await.unwrap();
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn a_saved_sign_in_that_was_revoked_asks_the_user_to_sign_in_again() {
    run(async {
        let provider = oauth::test_provider(
            port("MAIL_TEST_OAUTH_PORT"),
            "imapkit-approve",
            "alice@example.com",
        );
        let revoked = oauth::refresh(&provider, "a-refresh-token-that-does-not-exist")
            .await
            .unwrap_err();
        assert_eq!(revoked.kind, "auth");
    });
}

#[test]
#[ignore = "needs the test mail server: pnpm test:mail-engine"]
fn a_sign_in_nobody_finishes_times_out_and_frees_the_port() {
    run(async {
        let provider = oauth::test_provider(
            port("MAIL_TEST_OAUTH_PORT"),
            "imapkit-approve",
            "alice@example.com",
        );
        let pending = oauth::begin(provider).await.unwrap();
        // Requests that are not the answer do not end the wait.
        let back = pending
            .url
            .split("redirect_uri=")
            .nth(1)
            .and_then(|rest| rest.split('&').next())
            .unwrap()
            .replace("%3A", ":")
            .replace("%2F", "/");
        let stray =
            tokio::spawn(async move { get(&format!("{back}?code=guess&state=wrong")).await.0 });

        let timed_out = oauth::finish(pending, Duration::from_millis(600))
            .await
            .unwrap_err();

        assert_eq!(timed_out.kind, "timeout");
        assert!(stray.await.unwrap().contains(" 404"));
    });
}
