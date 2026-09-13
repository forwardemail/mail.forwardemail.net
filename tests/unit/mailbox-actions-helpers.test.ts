import { describe, it, expect } from 'vitest';
import {
  getSafeFilename,
  extractHeaders,
  looksLikeHtml,
  normalizeHeaders,
  buildOriginalViewerPage,
  pickOriginalContent,
  buildServerDraftPrefill,
} from '../../src/stores/mailbox-actions-helpers';
import { DARK_SURFACE } from '../../src/utils/dark-surface';

describe('getSafeFilename', () => {
  it('replaces unsafe characters with underscores and appends the suffix', () => {
    expect(getSafeFilename('Hello World!', 'eml')).toBe('Hello_World_.eml');
  });

  it('defaults to "message" for empty/whitespace subjects', () => {
    expect(getSafeFilename('', 'eml')).toBe('message.eml');
    expect(getSafeFilename('   ', 'eml')).toBe('message.eml');
    expect(getSafeFilename(undefined, 'txt')).toBe('message.txt');
  });

  it('keeps alphanumerics, dot, hyphen and underscore', () => {
    expect(getSafeFilename('re-2024_v1.2', 'eml')).toBe('re-2024_v1.2.eml');
  });

  it('strips path-unsafe characters including backslash, slash and brackets', () => {
    // The original regex bug let `\` `]` `^` through (and dropped `-`); guard it.
    expect(getSafeFilename('a\\b/c]d^e', 'eml')).toBe('a_b_c_d_e.eml');
  });
});

describe('extractHeaders', () => {
  it('returns everything before the first blank line', () => {
    expect(extractHeaders('From: a@b.com\nSubject: Hi\n\nbody text')).toBe(
      'From: a@b.com\nSubject: Hi',
    );
  });

  it('normalizes CRLF before splitting', () => {
    expect(extractHeaders('From: a@b.com\r\nSubject: Hi\r\n\r\nbody')).toBe(
      'From: a@b.com\nSubject: Hi',
    );
  });

  it('returns the whole trimmed string when there is no blank-line divider', () => {
    expect(extractHeaders('From: a@b.com\nSubject: Hi')).toBe('From: a@b.com\nSubject: Hi');
  });

  it('returns empty for empty input', () => {
    expect(extractHeaders('')).toBe('');
  });
});

describe('looksLikeHtml', () => {
  it('detects html/body tags', () => {
    expect(looksLikeHtml('<html><body>hi</body></html>')).toBe(true);
    expect(looksLikeHtml('prefix <body class="x">')).toBe(true);
  });

  it('is false for plain text or partial words', () => {
    expect(looksLikeHtml('just some text')).toBe(false);
    expect(looksLikeHtml('the htmlish word bodysuit')).toBe(false);
  });
});

describe('normalizeHeaders', () => {
  it('trims a string passthrough', () => {
    expect(normalizeHeaders('  From: a@b.com  ')).toBe('From: a@b.com');
  });

  it('joins an array with newlines', () => {
    expect(normalizeHeaders(['From: a@b.com', 'To: c@d.com'])).toBe('From: a@b.com\nTo: c@d.com');
  });

  it('renders an object, comma-joining array values', () => {
    expect(normalizeHeaders({ From: 'a@b.com', References: ['<1>', '<2>'] })).toBe(
      'From: a@b.com\nReferences: <1>, <2>',
    );
  });

  it('falls back to parsing the raw header block when given a header-like string', () => {
    expect(normalizeHeaders(null, 'From: a@b.com\nSubject: Hi\n\nbody')).toBe(
      'From: a@b.com\nSubject: Hi',
    );
  });

  it('returns empty when the fallback raw has no header-looking lines', () => {
    expect(normalizeHeaders(null, 'just a body with no headers')).toBe('');
  });
});

describe('pickOriginalContent', () => {
  it('prefers raw, then body, then textContent', () => {
    expect(pickOriginalContent({ raw: 'R', body: 'B', textContent: 'T' })).toBe('R');
    expect(pickOriginalContent({ body: 'B', textContent: 'T' })).toBe('B');
    expect(pickOriginalContent({ textContent: 'T' })).toBe('T');
  });

  it('returns empty for null/empty content', () => {
    expect(pickOriginalContent(null)).toBe('');
    expect(pickOriginalContent({})).toBe('');
  });
});

describe('buildOriginalViewerPage', () => {
  it('embeds the message data as JSON and derives the download filename', () => {
    const page = buildOriginalViewerPage({
      raw: 'RAW SOURCE',
      headers: 'H',
      subject: 'My Subject',
    });
    expect(page).toContain('"raw":"RAW SOURCE"');
    expect(page).toContain('"filename":"My_Subject.eml"');
  });

  it('HTML-escapes the subject in the <h1> (no markup injection)', () => {
    const page = buildOriginalViewerPage({ subject: '<img src=x onerror=alert(1)>' });
    expect(page).toContain('<h1>&lt;img src=x onerror=alert(1)&gt;</h1>');
    expect(page).not.toContain('<h1><img');
  });

  it('escapes </ sequences in embedded data so it cannot break out of <script>', () => {
    const page = buildOriginalViewerPage({ raw: '</script><script>alert(1)</script>' });
    // Only the page's own closing </script> tag remains literal; the data's are escaped.
    expect(page.split('</script>').length - 1).toBe(1);
    expect(page).toContain('<\\/script>');
  });

  it('includes dark-surface tokens only when not in light mode', () => {
    const dark = buildOriginalViewerPage({ isLightMode: false });
    const light = buildOriginalViewerPage({ isLightMode: true });
    expect(dark).toContain(`background: ${DARK_SURFACE.surface}`);
    expect(light).not.toContain(`background: ${DARK_SURFACE.surface}`);
  });

  it('embeds raw source into the page data', () => {
    const page = buildOriginalViewerPage({ raw: 'Subject: test\r\n\r\nHello body' });
    expect(page).toContain('Subject: test');
  });

  it('includes decrypted body block when decrypted text is provided', () => {
    const page = buildOriginalViewerPage({ raw: 'headers', decrypted: 'Hello decrypted' });
    expect(page).toContain('"decrypted":"Hello decrypted"');
    expect(page).toContain('decryptedBlock');
    expect(page).toContain('decryptedFrame');
    expect(page).toContain('decryptedPre');
  });

  it('hides decrypted block when no decrypted content is provided', () => {
    const page = buildOriginalViewerPage({ raw: 'headers' });
    expect(page).toContain('"decrypted":""');
    expect(page).toContain('style="display:none;"');
  });
});

// A draft that reached the Drafts folder from another client or the API has
// no local record, so everything compose needs comes off the list row and,
// when fetched, the server detail. The row is a display rendering: joined
// recipient strings, no body, no files.
describe('buildServerDraftPrefill', () => {
  const row = {
    id: 'msg-1',
    folder: 'Drafts',
    subject: 'Quarterly numbers',
    to: '"Ada Lovelace" <ada@example.com>, bob@example.com',
    cc: 'carol@example.com',
    bcc: '"Dee, Dana" <dana@example.com>',
    reply_to: 'replies@example.com',
    in_reply_to: '<orig@example.com>',
    references: '<root@example.com> <orig@example.com>',
  };

  it('splits the joined recipient strings into one entry per address', () => {
    const prefill = buildServerDraftPrefill({ msg: row, apiId: 'srv-1' });

    expect(prefill.to).toEqual(['Ada Lovelace <ada@example.com>', 'bob@example.com']);
    expect(prefill.cc).toEqual(['carol@example.com']);
    // The comma inside the quoted display name is not a separator, and the
    // quotes stay because the chip text is parsed again as an address on send.
    expect(prefill.bcc).toEqual(['"Dee, Dana" <dana@example.com>']);
  });

  it('carries reply-to and the threading headers from the row', () => {
    const prefill = buildServerDraftPrefill({ msg: row, apiId: 'srv-1' });

    expect(prefill.replyTo).toBe('replies@example.com');
    expect(prefill.inReplyTo).toBe('<orig@example.com>');
    expect(prefill.references).toBe('<root@example.com> <orig@example.com>');
  });

  it('binds compose to the server message and the row for cleanup', () => {
    const prefill = buildServerDraftPrefill({ msg: row, apiId: 'srv-1' });

    expect(prefill.serverDraftId).toBe('srv-1');
    expect(prefill.sourceMessageId).toBe('msg-1');
    expect(prefill.subject).toBe('Quarterly numbers');
  });

  // Lightweight list rows come without address fields at all, so the detail
  // fetch is the only source. Its parsed headers are the mailparser shape.
  it('falls back to the detail for recipients and headers the row lacks', () => {
    const bare = { id: 'msg-2', folder: 'Drafts', subject: 'Re: thread' };
    const detail = {
      nodemailer: {
        to: { value: [{ name: 'Ada', address: 'ada@example.com' }] },
        cc: { value: [{ address: 'carol@example.com' }] },
        inReplyTo: '<orig@example.com>',
        references: ['<root@example.com>', '<orig@example.com>'],
        headers: { 'reply-to': 'replies@example.com' },
      },
    };

    const prefill = buildServerDraftPrefill({ msg: bare, apiId: 'srv-2', detail });

    expect(prefill.to).toEqual(['Ada <ada@example.com>']);
    expect(prefill.cc).toEqual(['carol@example.com']);
    expect(prefill.bcc).toEqual([]);
    expect(prefill.replyTo).toBe('replies@example.com');
    expect(prefill.inReplyTo).toBe('<orig@example.com>');
    expect(prefill.references).toBe('<root@example.com> <orig@example.com>');
  });

  it('prefers the detail recipients over the row rendering when both exist', () => {
    const detail = { nodemailer: { to: { value: [{ address: 'only@example.com' }] } } };

    const prefill = buildServerDraftPrefill({ msg: row, apiId: 'srv-1', detail });

    expect(prefill.to).toEqual(['only@example.com']);
  });

  it('hands over html when there is one and attachments untouched', () => {
    const attachments = [{ name: 'a.txt', contentType: 'text/plain', content: 'aGk=', size: 2 }];

    const prefill = buildServerDraftPrefill({
      msg: row,
      apiId: 'srv-1',
      html: '<p>Hello</p>',
      text: 'Hello',
      attachments,
    });

    expect(prefill.html).toBe('<p>Hello</p>');
    expect(prefill.text).toBeUndefined();
    expect(prefill.attachments).toBe(attachments);
  });

  // Compose ignores a text prefill unless it is already in plain-text mode,
  // which a fresh open never is; a text-only draft has to arrive as HTML.
  it('converts a text-only body to escaped paragraphs', () => {
    const prefill = buildServerDraftPrefill({ msg: row, apiId: 'srv-1', text: 'a < b\nline 2' });

    expect(prefill.html).toBe('<p>a &lt; b</p><p>line 2</p>');
  });

  it('omits the optional keys rather than passing empty strings', () => {
    const prefill = buildServerDraftPrefill({ msg: { id: 'x', subject: '' }, apiId: 'x' });

    expect(prefill).toEqual({
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      attachments: [],
      sourceMessageId: 'x',
      serverDraftId: 'x',
    });
  });
});
