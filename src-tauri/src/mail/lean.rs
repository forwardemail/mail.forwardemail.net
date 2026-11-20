//! Reading a large message without its attachments.
//!
//! A small message is fetched whole. For a large one the server is asked for
//! its structure first, then for the header, the text and the small inline
//! parts only. They are put back together as a message with the same
//! structure, in which each part left behind holds a short marker instead of
//! its content. The webview's mail parser reads that like any message, lists
//! the attachments from their own headers, and fetches one with `part` when
//! it is opened.
//!
//! Encrypted and signed messages are always fetched whole: the ciphertext is
//! the message, and a signature only checks out over the exact bytes.

use std::collections::HashMap;
use std::time::Duration;

use async_imap::imap_proto::{BodyStructure, ContentEncoding, MessageSection, SectionPath};
use base64::Engine;
use futures_util::TryStreamExt;

use super::error::MailError;
use super::imap::{self, Session};

/// A message up to this size is fetched whole in one request.
const WHOLE_UP_TO: u32 = 1024 * 1024;
/// An inline part (an image shown in the body) up to this size comes along.
const INLINE_UP_TO: u32 = 512 * 1024;
/// Any part this small comes along: leaving it out would save nothing.
const TINY: u32 = 16 * 1024;
/// More parts than this and the message is fetched whole instead.
const MAX_PARTS: usize = 60;
const FETCH_TIMEOUT: Duration = Duration::from_secs(120);

/// What stands in for a part that was not downloaded, followed by its
/// section, its size on the server and its transfer encoding.
pub const MARKER: &str = "fe-part-not-downloaded";

#[derive(Debug, Clone, PartialEq)]
struct Leaf {
    /// "text", "image", "application" and so on, lowercase.
    ty: String,
    attachment: bool,
    has_id: bool,
    octets: u32,
    /// "base64", "quoted-printable", "7bit", "8bit" or "binary".
    encoding: String,
}

#[derive(Debug, Clone, PartialEq)]
enum Node {
    Multi { subtype: String, parts: Vec<Node> },
    Leaf(Leaf),
}

fn encoding_name(encoding: &ContentEncoding<'_>) -> String {
    match encoding {
        ContentEncoding::SevenBit => "7bit".into(),
        ContentEncoding::EightBit => "8bit".into(),
        ContentEncoding::Binary => "binary".into(),
        ContentEncoding::Base64 => "base64".into(),
        ContentEncoding::QuotedPrintable => "quoted-printable".into(),
        ContentEncoding::Other(other) => other.to_ascii_lowercase(),
    }
}

fn node_from(structure: &BodyStructure<'_>) -> Node {
    let leaf = |common: &async_imap::imap_proto::BodyContentCommon<'_>,
                other: &async_imap::imap_proto::BodyContentSinglePart<'_>| {
        Node::Leaf(Leaf {
            ty: common.ty.ty.to_ascii_lowercase(),
            attachment: common
                .disposition
                .as_ref()
                .is_some_and(|d| d.ty.eq_ignore_ascii_case("attachment")),
            has_id: other.id.as_deref().is_some_and(|id| !id.is_empty()),
            octets: other.octets,
            encoding: encoding_name(&other.transfer_encoding),
        })
    };
    match structure {
        BodyStructure::Multipart { common, bodies, .. } => Node::Multi {
            subtype: common.ty.subtype.to_ascii_lowercase(),
            parts: bodies.iter().map(node_from).collect(),
        },
        BodyStructure::Basic { common, other, .. }
        | BodyStructure::Text { common, other, .. }
        // An attached message is one part here, taken or left as a whole.
        | BodyStructure::Message { common, other, .. } => leaf(common, other),
    }
}

/// Whether a part comes along with the message.
fn keep(leaf: &Leaf) -> bool {
    if leaf.octets <= TINY {
        return true;
    }
    if leaf.attachment {
        return false;
    }
    // The text is what the reader shows, whatever its size.
    leaf.ty == "text" || (leaf.has_id && leaf.octets <= INLINE_UP_TO)
}

fn child(path: &str, index: usize) -> String {
    if path.is_empty() {
        (index + 1).to_string()
    } else {
        format!("{path}.{}", index + 1)
    }
}

/// Every part under a multipart, with its section number.
fn sections<'a>(node: &'a Node, path: &str, out: &mut Vec<(String, &'a Node)>) {
    if let Node::Multi { parts, .. } = node {
        for (index, part) in parts.iter().enumerate() {
            let section = child(path, index);
            out.push((section.clone(), part));
            sections(part, &section, out);
        }
    }
}

/// The boundary a multipart's own header names.
fn boundary_of(header: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(header);
    let mut content_type = String::new();
    let mut inside = false;
    for line in text.lines() {
        if line.starts_with([' ', '\t']) {
            if inside {
                content_type.push_str(line);
            }
            continue;
        }
        inside = line
            .split_once(':')
            .is_some_and(|(name, _)| name.eq_ignore_ascii_case("content-type"));
        if inside {
            content_type = line.to_string();
        } else if !content_type.is_empty() {
            break;
        }
    }
    let lower = content_type.to_ascii_lowercase();
    let at = lower.find("boundary=")? + "boundary=".len();
    let rest = &content_type[at..];
    let value = match rest.strip_prefix('"') {
        Some(quoted) => quoted.split('"').next()?,
        None => rest.split([';', ' ', '\t']).next()?,
    };
    (!value.is_empty() && value.len() <= 200).then(|| value.to_string())
}

fn marker(section: &str, leaf: &Leaf) -> Vec<u8> {
    let text = format!("{MARKER} {section} {} {}", leaf.octets, leaf.encoding);
    // Written in the part's own encoding, so the parser decodes it to the text.
    if leaf.encoding == "base64" {
        base64::engine::general_purpose::STANDARD
            .encode(text)
            .into_bytes()
    } else {
        text.into_bytes()
    }
}

#[derive(Default)]
struct Pieces {
    header: Vec<u8>,
    /// The MIME header of each part, by section.
    mime: HashMap<String, Vec<u8>>,
    /// The content of each part that came along, by section.
    body: HashMap<String, Vec<u8>>,
}

fn push_header(out: &mut Vec<u8>, header: &[u8]) {
    out.extend_from_slice(header);
    // A header block ends with an empty line; servers send it, but the
    // message falls apart without it.
    if !header.ends_with(b"\r\n\r\n") && !header.ends_with(b"\n\n") {
        out.extend_from_slice(if header.ends_with(b"\n") {
            b"\r\n"
        } else {
            b"\r\n\r\n"
        });
    }
}

fn push_body(
    node: &Node,
    path: &str,
    own_header: &[u8],
    pieces: &Pieces,
    out: &mut Vec<u8>,
) -> Option<()> {
    match node {
        Node::Multi { parts, .. } => {
            let boundary = boundary_of(own_header)?;
            for (index, part) in parts.iter().enumerate() {
                let section = child(path, index);
                let header = pieces.mime.get(&section)?;
                out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
                push_header(out, header);
                push_body(part, &section, header, pieces, out)?;
                out.extend_from_slice(b"\r\n");
            }
            out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        }
        Node::Leaf(leaf) => {
            if keep(leaf) {
                out.extend_from_slice(pieces.body.get(path)?);
            } else {
                out.extend_from_slice(&marker(path, leaf));
            }
        }
    }
    Some(())
}

/// The message put back together, or None when a piece is missing.
fn assemble(root: &Node, pieces: &Pieces) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    push_header(&mut out, &pieces.header);
    push_body(root, "", &pieces.header, pieces, &mut out)?;
    Some(out)
}

/// The requests for a lean copy, or None when the message should be fetched
/// whole: nothing would be left behind, or it must not be taken apart.
fn plan(root: &Node) -> Option<Vec<(String, bool)>> {
    let Node::Multi { subtype, .. } = root else {
        return None;
    };
    if subtype == "encrypted" || subtype == "signed" {
        return None;
    }
    let mut all = Vec::new();
    sections(root, "", &mut all);
    if all.len() > MAX_PARTS {
        return None;
    }
    let mut left_behind = false;
    let wanted = all
        .into_iter()
        .map(|(section, node)| {
            let content = match node {
                Node::Leaf(leaf) => {
                    let kept = keep(leaf);
                    left_behind |= !kept;
                    kept
                }
                Node::Multi { .. } => false,
            };
            (section, content)
        })
        .collect();
    left_behind.then_some(wanted)
}

fn path_of(section: &str) -> Option<Vec<u32>> {
    let path: Option<Vec<u32>> = section
        .split('.')
        .map(|n| n.parse::<u32>().ok().filter(|n| *n > 0))
        .collect();
    path.filter(|p| !p.is_empty() && p.len() <= 20)
}

/// A message to read: whole when it is small, without its attachments when
/// it is large. None when the folder no longer has it.
pub async fn message(
    session: &mut Session,
    folder: &str,
    uid: u32,
) -> Result<Option<Vec<u8>>, MailError> {
    imap::select(session, folder).await?;
    let fetches: Vec<async_imap::types::Fetch> =
        imap::timed(FETCH_TIMEOUT, "reading the message", async {
            session
                .uid_fetch(uid.to_string(), "(UID RFC822.SIZE BODYSTRUCTURE)")
                .await?
                .try_collect()
                .await
        })
        .await?;
    let Some(fetch) = fetches.iter().find(|f| f.uid == Some(uid)) else {
        return Ok(None);
    };
    let root = fetch.bodystructure().map(node_from);
    let wanted = match (&root, fetch.size) {
        (Some(root), Some(size)) if size > WHOLE_UP_TO => plan(root),
        _ => None,
    };
    let (Some(root), Some(wanted)) = (root, wanted) else {
        return imap::raw(session, folder, uid).await;
    };
    drop(fetches);

    let mut items = vec!["UID".to_string(), "BODY.PEEK[HEADER]".to_string()];
    for (section, content) in &wanted {
        items.push(format!("BODY.PEEK[{section}.MIME]"));
        if *content {
            items.push(format!("BODY.PEEK[{section}]"));
        }
    }
    let query = format!("({})", items.join(" "));
    let fetches: Vec<async_imap::types::Fetch> =
        imap::timed(FETCH_TIMEOUT, "downloading the message", async {
            session
                .uid_fetch(uid.to_string(), &query)
                .await?
                .try_collect()
                .await
        })
        .await?;
    let Some(fetch) = fetches.iter().find(|f| f.uid == Some(uid)) else {
        return Ok(None);
    };
    let mut pieces = Pieces {
        header: fetch.header().map(<[u8]>::to_vec).unwrap_or_default(),
        ..Pieces::default()
    };
    for (section, content) in &wanted {
        let Some(path) = path_of(section) else {
            continue;
        };
        let mime = SectionPath::Part(path.clone(), Some(MessageSection::Mime));
        if let Some(bytes) = fetch.section(&mime) {
            pieces.mime.insert(section.clone(), bytes.to_vec());
        }
        if *content {
            if let Some(bytes) = fetch.section(&SectionPath::Part(path, None)) {
                pieces.body.insert(section.clone(), bytes.to_vec());
            }
        }
    }
    let assembled = (!pieces.header.is_empty())
        .then(|| assemble(&root, &pieces))
        .flatten();
    drop(fetches);
    match assembled {
        Some(message) => Ok(Some(message)),
        // The server left a piece out. Slower, but always right.
        None => imap::raw(session, folder, uid).await,
    }
}

/// One part of a message as the server holds it, still in its transfer
/// encoding. None when the message or the part is gone.
pub async fn part(
    session: &mut Session,
    folder: &str,
    uid: u32,
    section: &str,
) -> Result<Option<Vec<u8>>, MailError> {
    let path = path_of(section).ok_or_else(|| MailError::input("That part is not valid"))?;
    let section = path
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(".");
    imap::select(session, folder).await?;
    let fetches: Vec<async_imap::types::Fetch> =
        imap::timed(FETCH_TIMEOUT, "downloading the attachment", async {
            session
                .uid_fetch(uid.to_string(), format!("(UID BODY.PEEK[{section}])"))
                .await?
                .try_collect()
                .await
        })
        .await?;
    let wanted = SectionPath::Part(path, None);
    Ok(fetches
        .iter()
        .filter(|f| f.uid == Some(uid))
        .find_map(|f| f.section(&wanted).map(<[u8]>::to_vec)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(octets: u32) -> Node {
        Node::Leaf(Leaf {
            ty: "text".into(),
            attachment: false,
            has_id: false,
            octets,
            encoding: "quoted-printable".into(),
        })
    }

    fn file(octets: u32) -> Node {
        Node::Leaf(Leaf {
            ty: "application".into(),
            attachment: true,
            has_id: false,
            octets,
            encoding: "base64".into(),
        })
    }

    fn inline_image(octets: u32) -> Node {
        Node::Leaf(Leaf {
            ty: "image".into(),
            attachment: false,
            has_id: true,
            octets,
            encoding: "base64".into(),
        })
    }

    fn multi(subtype: &str, parts: Vec<Node>) -> Node {
        Node::Multi {
            subtype: subtype.into(),
            parts,
        }
    }

    /// multipart/mixed: (alternative: plain, html), a big PDF, a small logo
    fn newsletter() -> Node {
        multi(
            "mixed",
            vec![
                multi("alternative", vec![text(900), text(40_000)]),
                file(8_000_000),
                inline_image(30_000),
            ],
        )
    }

    #[test]
    fn asks_for_the_text_and_leaves_the_large_attachment() {
        assert_eq!(
            plan(&newsletter()).unwrap(),
            vec![
                ("1".to_string(), false),
                ("1.1".to_string(), true),
                ("1.2".to_string(), true),
                ("2".to_string(), false),
                ("3".to_string(), true),
            ]
        );
    }

    #[test]
    fn a_message_with_nothing_to_leave_behind_is_fetched_whole() {
        let all_text = multi("alternative", vec![text(2_000_000), text(3_000_000)]);
        assert_eq!(plan(&all_text), None);
        assert_eq!(plan(&text(5_000_000)), None);
    }

    #[test]
    fn encrypted_and_signed_messages_are_never_taken_apart() {
        for subtype in ["encrypted", "signed"] {
            let message = multi(subtype, vec![text(100), file(9_000_000)]);
            assert_eq!(plan(&message), None, "{subtype}");
        }
    }

    #[test]
    fn what_comes_along() {
        let leaf = |node: Node| match node {
            Node::Leaf(leaf) => leaf,
            Node::Multi { .. } => unreachable!(),
        };
        // The body text, however long.
        assert!(keep(&leaf(text(9_000_000))));
        // A small attachment costs nothing.
        assert!(keep(&leaf(file(10_000))));
        assert!(!keep(&leaf(file(200_000))));
        // A picture in the body, unless it is huge.
        assert!(keep(&leaf(inline_image(300_000))));
        assert!(!keep(&leaf(inline_image(4_000_000))));
    }

    #[test]
    fn puts_the_message_back_together_around_a_marker() {
        let mut pieces = Pieces {
            header:
                b"Subject: Report\r\nContent-Type: multipart/mixed;\r\n boundary=\"outer\"\r\n\r\n"
                    .to_vec(),
            ..Pieces::default()
        };
        pieces.mime.insert(
            "1".into(),
            b"Content-Type: multipart/alternative; boundary=inner\r\n\r\n".to_vec(),
        );
        pieces
            .mime
            .insert("1.1".into(), b"Content-Type: text/plain\r\n\r\n".to_vec());
        pieces
            .mime
            .insert("1.2".into(), b"Content-Type: text/html\r\n\r\n".to_vec());
        pieces.mime.insert(
            "2".into(),
            b"Content-Type: application/pdf; name=\"q3.pdf\"\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename=\"q3.pdf\"\r\n\r\n"
                .to_vec(),
        );
        pieces.mime.insert(
            "3".into(),
            b"Content-Type: image/png\r\nContent-ID: <logo>\r\n\r\n".to_vec(),
        );
        pieces.body.insert("1.1".into(), b"Hello".to_vec());
        pieces.body.insert("1.2".into(), b"<p>Hello</p>".to_vec());
        pieces.body.insert("3".into(), b"iVBORw0KGgo=".to_vec());

        let message = String::from_utf8(assemble(&newsletter(), &pieces).unwrap()).unwrap();
        let stand_in = base64::engine::general_purpose::STANDARD
            .encode("fe-part-not-downloaded 2 8000000 base64");
        assert_eq!(
            message,
            [
                "Subject: Report\r\n",
                "Content-Type: multipart/mixed;\r\n",
                " boundary=\"outer\"\r\n",
                "\r\n",
                "--outer\r\n",
                "Content-Type: multipart/alternative; boundary=inner\r\n",
                "\r\n",
                "--inner\r\n",
                "Content-Type: text/plain\r\n",
                "\r\n",
                "Hello\r\n",
                "--inner\r\n",
                "Content-Type: text/html\r\n",
                "\r\n",
                "<p>Hello</p>\r\n",
                "--inner--\r\n",
                "\r\n",
                "--outer\r\n",
                "Content-Type: application/pdf; name=\"q3.pdf\"\r\n",
                "Content-Transfer-Encoding: base64\r\n",
                "Content-Disposition: attachment; filename=\"q3.pdf\"\r\n",
                "\r\n",
                &stand_in,
                "\r\n",
                "--outer\r\n",
                "Content-Type: image/png\r\n",
                "Content-ID: <logo>\r\n",
                "\r\n",
                "iVBORw0KGgo=\r\n",
                "--outer--\r\n",
            ]
            .concat()
        );
    }

    #[test]
    fn a_missing_piece_means_no_lean_copy() {
        let pieces = Pieces {
            header: b"Content-Type: multipart/mixed; boundary=outer\r\n\r\n".to_vec(),
            ..Pieces::default()
        };
        assert_eq!(assemble(&newsletter(), &pieces), None);
        // No boundary to rebuild with.
        let pieces = Pieces {
            header: b"Subject: x\r\n\r\n".to_vec(),
            ..Pieces::default()
        };
        assert_eq!(assemble(&newsletter(), &pieces), None);
    }

    #[test]
    fn reads_a_boundary_however_it_is_written() {
        assert_eq!(
            boundary_of(b"Content-Type: multipart/mixed; boundary=abc123\r\n\r\n").as_deref(),
            Some("abc123")
        );
        assert_eq!(
            boundary_of(
                b"content-type: multipart/related;\r\n\tBOUNDARY=\"a b;c\"; type=\"text/html\"\r\n"
            )
            .as_deref(),
            Some("a b;c")
        );
        // A boundary named in some other header is not it.
        assert_eq!(
            boundary_of(b"X-Note: boundary=nope\r\nContent-Type: text/plain\r\n\r\n"),
            None
        );
    }

    #[test]
    fn a_part_number_is_only_ever_numbers() {
        assert_eq!(path_of("2"), Some(vec![2]));
        assert_eq!(path_of("1.2.3"), Some(vec![1, 2, 3]));
        for bad in ["", "0", "1.", "1..2", "1.x", "HEADER", "1] BODY[", "-1"] {
            assert_eq!(path_of(bad), None, "{bad}");
        }
    }
}
