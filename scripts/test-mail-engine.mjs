#!/usr/bin/env node
/**
 * Runs the Rust mail engine's tests against a real IMAP and SMTP server.
 *
 * The server is ImapKit: in memory, strict about the RFCs, and reset to the
 * mailboxes below before each test. This starts it on free local ports,
 * hands the ports to `cargo test` and stops it afterwards. The tests are in
 * src-tauri/src/mail/live.rs and are skipped by a plain `cargo test`.
 *
 *   pnpm test:mail-engine            every live test
 *   pnpm test:mail-engine search     only the tests whose name has "search"
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import imapkit from 'imapkit';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Bytes, not a string: a message with 8-bit text is stored as given, and a
// string would not be stored as the UTF-8 its headers declare.
const message = (headers, body) =>
  Buffer.from(
    `${Object.entries(headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n')}\r\n\r\n${body}`,
    'utf8',
  );

// 2 MB of repeating bytes, as a PDF attachment would arrive: base64, 76 a line.
const bigFile = Buffer.alloc(2 * 1024 * 1024, 'forwardemail-').toString('base64');
const wrapped = bigFile.match(/.{1,76}/g).join('\r\n');

const report = message(
  {
    From: 'Zoe Muller <zoe@example.net>',
    To: 'testuser@example.org',
    Subject: 'Quarterly report with the full ledger',
    Date: 'Mon, 02 Nov 2026 08:00:00 +0000',
    'Message-ID': '<report.1@example.net>',
    'MIME-Version': '1.0',
    'Content-Type': 'multipart/mixed; boundary="outer"',
  },
  [
    '--outer',
    'Content-Type: multipart/alternative; boundary="inner"',
    '',
    '--inner',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The ledger is attached.',
    '--inner',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>The ledger is <b>attached</b>.</p>',
    '--inner--',
    '--outer',
    'Content-Type: application/pdf; name="ledger.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="ledger.pdf"',
    '',
    wrapped,
    '--outer--',
    '',
  ].join('\r\n'),
);

const storage = {
  INBOX: {
    messages: [
      {
        raw: message(
          {
            From: 'Bob Stone <bob@example.com>',
            To: 'testuser@example.org',
            Subject: 'Lunch on Thursday?',
            Date: 'Sun, 01 Nov 2026 12:00:00 +0000',
            'Message-ID': '<lunch.1@example.com>',
          },
          'Noon at the usual place?\r\n',
        ),
        flags: ['\\Seen'],
        internaldate: '01-Nov-2026 12:00:05 +0000',
      },
      { raw: report, flags: [], internaldate: '02-Nov-2026 08:00:09 +0000' },
      {
        raw: message(
          {
            From: '=?UTF-8?B?UmVuw6llIETDvHJy?= <renee@example.fr>',
            To: 'testuser@example.org',
            Subject: '=?UTF-8?B?UsOpdW5pb24gZHUgY29taXTDqQ==?=',
            Date: 'Tue, 03 Nov 2026 09:30:00 +0100',
            'Message-ID': '<reunion.7@example.fr>',
            'MIME-Version': '1.0',
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Transfer-Encoding': '8bit',
          },
          'La réunion du comité est reportée à jeudi.\r\n',
        ),
        flags: ['\\Flagged', 'work'],
        internaldate: '03-Nov-2026 08:30:02 +0000',
      },
    ],
  },
  '': {
    separator: '/',
    folders: {
      Drafts: { 'special-use': '\\Drafts' },
      Sent: { 'special-use': '\\Sent' },
      Trash: { 'special-use': '\\Trash' },
      Archive: { 'special-use': '\\Archive' },
      Clients: { folders: { Acme: {} } },
      // "Entwürfe", as a server stores a name that is not plain ASCII
      'Entw&APw-rfe': {},
    },
  },
};

const server = imapkit({
  plugins: [
    'IDLE',
    'MOVE',
    'UIDPLUS',
    'SPECIAL-USE',
    'STARTTLS',
    'SASL-IR',
    'XOAUTH2',
    'CONDSTORE',
    'QUOTA',
  ],
  // 100 MB, in the server's units of 1024 bytes.
  quota: { root: 'User quota', STORAGE: 102400 },
  storage,
  // Everyone shares the mailboxes above. Alice signs in through the test
  // sign-in page (OAuth), which names its users by address.
  users: {
    testuser: { password: 'testpass' },
    'alice@example.com': { password: 'not used', displayName: 'Alice' },
  },
  oauth: { port: 0, host: '127.0.0.1' },
  tls: { port: 0, host: '127.0.0.1' },
  smtp: { port: 0, host: '127.0.0.1' },
  rest: { port: 0, host: '127.0.0.1' },
});
await server.start(0, '127.0.0.1');

const smtp = server.smtpServer?.server ?? server.smtpServer;
const env = {
  ...process.env,
  MAIL_TEST_IMAP_TLS_PORT: String(server.tlsServer.address().port),
  MAIL_TEST_SMTP_PORT: String(smtp.address().port),
  MAIL_TEST_CONTROL_PORT: String(server.restServer.address().port),
  MAIL_TEST_OAUTH_PORT: String(server.oauthServer.address().port),
};

const filter = process.argv[2] ? `mail::live::${process.argv[2]}` : 'mail::live';
const cargo = spawn(
  'cargo',
  // One at a time: the tests share the server and reset it as they start.
  ['test', '--lib', filter, '--', '--ignored', '--test-threads=1'],
  { cwd: path.join(root, 'src-tauri'), env, stdio: 'inherit' },
);

cargo.on('exit', async (code, signal) => {
  await server.stop().catch(() => {});
  process.exit(signal ? 1 : (code ?? 1));
});
