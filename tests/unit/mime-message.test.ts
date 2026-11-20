// The MIME parser needs one set of typed-array classes. jsdom gives the
// test a second set next to Node's, and the parser then misreads its input.
// @vitest-environment node
/**
 * The message handed to an SMTP server is built here instead of by the
 * Forward Email API. It is read back with the mail parser the app uses for
 * incoming mail: what matters is what a receiving client makes of it.
 */
import { describe, expect, it } from 'vitest';
import PostalMime from 'postal-mime';
import { bareAddress, buildMimeMessage } from '../../src/utils/mime-message';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const parse = (bytes: Uint8Array) => PostalMime.parse(bytes);
const headerBlock = (bytes: Uint8Array) => text(bytes).split('\r\n\r\n')[0];
const isAscii = (value: string) => Array.from(value).every((c) => c.charCodeAt(0) < 128);

const base = {
  from: '"Ada Lovelace" <ada@example.com>',
  to: ['Charles Babbage <charles@example.org>'],
  subject: 'Notes on the engine',
  text: 'The engine weaves algebraic patterns.',
  html: '<p>The engine weaves <b>algebraic</b> patterns.</p>',
  messageId: '<n1@example.com>',
};

describe('buildMimeMessage', () => {
  it('builds a message a mail client reads back as it was written', async () => {
    const built = buildMimeMessage({
      ...base,
      cc: ['mary@example.net'],
      inReplyTo: '<q7@example.org>',
      references: '<q1@example.org> <q7@example.org>',
    });
    const parsed = await parse(built.raw);

    expect(parsed.from).toEqual({ name: 'Ada Lovelace', address: 'ada@example.com' });
    expect(parsed.to).toEqual([{ name: 'Charles Babbage', address: 'charles@example.org' }]);
    expect(parsed.cc).toEqual([{ name: '', address: 'mary@example.net' }]);
    expect(parsed.subject).toBe('Notes on the engine');
    expect(parsed.messageId).toBe('<n1@example.com>');
    expect(parsed.inReplyTo).toBe('<q7@example.org>');
    expect(parsed.references).toBe('<q1@example.org> <q7@example.org>');
    expect(parsed.text?.trim()).toBe('The engine weaves algebraic patterns.');
    expect(parsed.html?.trim()).toBe('<p>The engine weaves <b>algebraic</b> patterns.</p>');
    expect(Number.isFinite(new Date(parsed.date || '').getTime())).toBe(true);
  });

  it('gives the server the bare addresses of everyone, each once', () => {
    const built = buildMimeMessage({
      ...base,
      cc: ['mary@example.net', 'Charles <charles@example.org>'],
      bcc: ['Secret <quiet@example.net>'],
    });
    expect(built.from).toBe('ada@example.com');
    expect(built.recipients).toEqual([
      'charles@example.org',
      'mary@example.net',
      'quiet@example.net',
    ]);
  });

  it('keeps Bcc out of what is sent and names it in the Sent copy', async () => {
    const built = buildMimeMessage({ ...base, bcc: ['quiet@example.net'] });

    expect(text(built.raw)).not.toMatch(/quiet@example\.net/);
    expect(headerBlock(built.raw)).not.toMatch(/^Bcc:/im);

    const copy = await parse(built.sentCopy);
    expect(copy.bcc).toEqual([{ name: '', address: 'quiet@example.net' }]);
    // Otherwise the same message.
    expect(copy.messageId).toBe('<n1@example.com>');
    expect(copy.text).toBe((await parse(built.raw)).text);
  });

  it('survives a long subject in another script without an over-long line', async () => {
    const subject = 'Réunion du comité : 東京での会議の議事録と来週の予定について 🚀 '
      .repeat(4)
      .trim();
    const built = buildMimeMessage({ ...base, subject });

    for (const line of headerBlock(built.raw).split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    // No raw UTF-8 in the headers.
    expect(isAscii(headerBlock(built.raw))).toBe(true);
    expect((await parse(built.raw)).subject).toBe(subject);
  });

  it('wraps a long recipient list instead of writing one long line', async () => {
    const to = Array.from({ length: 30 }, (_, i) => `Person Number ${i} <person${i}@example.org>`);
    const built = buildMimeMessage({ ...base, to });

    for (const line of headerBlock(built.raw).split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    const parsed = await parse(built.raw);
    expect(parsed.to?.map((entry) => entry.address)).toEqual(
      to.map((_, i) => `person${i}@example.org`),
    );
  });

  it('does not split a display name that holds a comma into two people', async () => {
    const built = buildMimeMessage({ ...base, to: ['"Babbage, Charles" <charles@example.org>'] });
    expect((await parse(built.raw)).to).toEqual([
      { name: 'Babbage, Charles', address: 'charles@example.org' },
    ]);
    expect(built.recipients).toEqual(['charles@example.org']);
  });

  it('carries an attachment, with a name that is not plain ASCII', async () => {
    const content = Buffer.from('year,total\n1843,25\n').toString('base64');
    const built = buildMimeMessage({
      ...base,
      attachments: [{ filename: 'résumé 2026.csv', contentType: 'text/csv', content }],
    });
    expect(isAscii(headerBlock(built.raw))).toBe(true);
    expect(isAscii(text(built.raw))).toBe(true);

    const parsed = await parse(built.raw);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe('résumé 2026.csv');
    expect(parsed.attachments[0].mimeType).toBe('text/csv');
    expect(Buffer.from(parsed.attachments[0].content as ArrayBuffer).toString()).toBe(
      'year,total\n1843,25\n',
    );
    expect(parsed.text?.trim()).toBe(base.text);
  });

  // The 1x1 PNG the editor would hold after "Insert image".
  const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  // Gmail and Outlook do not draw a data: address, so a picture inserted in
  // the editor has to travel as a part the HTML points at.
  it('sends a picture inserted in the editor as a part of the body', async () => {
    const built = buildMimeMessage({
      ...base,
      html: `<p>Diagram:</p><img src="data:image/png;base64,${PNG}" alt="mill">`,
    });
    const parsed = await parse(built.raw);
    expect(parsed.html).not.toContain('data:');
    expect(parsed.attachments).toHaveLength(1);
    const [picture] = parsed.attachments;
    expect(picture).toMatchObject({ mimeType: 'image/png', related: true, disposition: 'inline' });
    expect(Buffer.from(picture.content as ArrayBuffer).toString('base64')).toBe(PNG);
    const cid = String(picture.contentId).replace(/[<>]/g, '');
    expect(cid).toMatch(/@example\.com$/);
    expect(parsed.html).toContain(`<img src="cid:${cid}" alt="mill">`);
    // The plain text alternative is still there for clients that want it.
    expect(parsed.text?.trim()).toBe(base.text);
  });

  it('keeps a picture with the body and a file with the attachments', async () => {
    const csv = Buffer.from('year,total\n1843,25\n').toString('base64');
    const built = buildMimeMessage({
      ...base,
      html: `<img src="data:image/png;base64,${PNG}">`,
      attachments: [{ filename: 'totals.csv', contentType: 'text/csv', content: csv }],
    });
    const source = text(built.raw);
    // mixed( related( alternative( text, html ), picture ), file )
    const order = [
      'multipart/mixed',
      'multipart/related',
      'multipart/alternative',
      'image/png',
      'text/csv',
    ];
    const positions = order.map((type) => source.indexOf(`Content-Type: ${type}`));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    const parsed = await parse(built.raw);
    const byType = Object.fromEntries(parsed.attachments.map((a) => [a.mimeType, a]));
    expect(byType['image/png'].related).toBe(true);
    expect(byType['text/csv'].related).toBeFalsy();
    expect(byType['text/csv'].disposition).toBe('attachment');
  });

  it('sends one part for a picture used twice', async () => {
    const img = `<img src="data:image/png;base64,${PNG}">`;
    const parsed = await parse(
      buildMimeMessage({ ...base, html: `${img}<p>and again</p>${img}` }).raw,
    );
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.html?.match(/cid:/g)).toHaveLength(2);
  });

  it('keeps a forwarded picture with the body when the HTML shows it', async () => {
    const built = buildMimeMessage({
      ...base,
      html: '<blockquote><img src="cid:logo@sender.example"></blockquote>',
      attachments: [
        {
          filename: 'logo.png',
          contentType: 'image/png',
          content: PNG,
          cid: 'logo@sender.example',
        },
        // Same start of the id, but nothing in the HTML shows this one.
        {
          filename: 'logo-2.png',
          contentType: 'image/png',
          content: PNG,
          cid: 'logo@sender.example.2',
        },
      ],
    });
    const parsed = await parse(built.raw);
    const byName = Object.fromEntries(parsed.attachments.map((a) => [a.filename, a]));
    expect(byName['logo.png'].related).toBe(true);
    expect(byName['logo-2.png'].related).toBeFalsy();
  });

  it('leaves the pictures of a draft in its HTML, so it opens as it was saved', async () => {
    const html = `<p>Half written</p><img src="data:image/png;base64,${PNG}">`;
    const built = buildMimeMessage({ ...base, to: [], html }, { draft: true });
    const parsed = await parse(built.raw);
    expect(parsed.html).toBe(html);
    expect(parsed.attachments).toEqual([]);
  });

  it('cannot be given an extra header through the subject or an address', () => {
    const built = buildMimeMessage({
      ...base,
      subject: 'Hello\r\nBcc: eve@example.net',
      to: ['charles@example.org\r\nX-Injected: yes'],
    });
    const headers = headerBlock(built.raw);
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(headers).not.toMatch(/^X-Injected:/m);
  });

  it('gives a message without an id one on the sender domain', async () => {
    const built = buildMimeMessage({ ...base, messageId: undefined });
    expect((await parse(built.raw)).messageId).toMatch(/^<[0-9a-f]{32}@example\.com>$/);
  });

  it('sends an already built message unchanged, apart from line endings', () => {
    const raw =
      'From: ada@example.com\nTo: charles@example.org\nSubject: x\n\n-----BEGIN PGP MESSAGE-----\n';
    const built = buildMimeMessage({ ...base, bcc: ['quiet@example.net'], raw });

    expect(text(built.raw)).toBe(raw.replace(/\n/g, '\r\n'));
    expect(built.sentCopy).toBe(built.raw);
    // The envelope still comes from the fields, Bcc included.
    expect(built.recipients).toEqual(['charles@example.org', 'quiet@example.net']);
  });

  it('refuses a message with nobody to send to or no sender', () => {
    expect(() => buildMimeMessage({ ...base, to: [] })).toThrow(/no recipients/);
    expect(() => buildMimeMessage({ ...base, from: '' })).toThrow(/From/);
  });
});

describe('bareAddress', () => {
  it('reads the address out of a name and brackets', () => {
    expect(bareAddress('"Lovelace, Ada" <ada@example.com>')).toBe('ada@example.com');
    expect(bareAddress(' ada@example.com ')).toBe('ada@example.com');
  });
});
