import { describe, it, expect } from 'vitest';
import { parseMailto, mailtoToPrefill, shareToPrefill } from '../../src/utils/mailto.js';
import { buildPgpMimeMessage, buildInnerMime, encodeAddressList } from '../../src/utils/pgp-mime';
import {
  sanitizeHtml,
  sanitizeEmailCss,
  sanitizeQuotedHtml,
  fixViewportHeightUnits,
} from '../../src/utils/sanitize.js';
import { applyInlineAttachments, extractTextContent } from '../../src/utils/mime-utils.js';
import {
  expandRecurringMaster,
  expandRecurringEvents,
  MAX_INSTANCES_PER_SERIES,
} from '../../src/utils/recurrence';
import { redact } from '../../src/utils/redaction';
import {
  sanitizeDownloadFilename,
  cachedBodyForDisplay,
} from '../../src/stores/mail-service-helpers';
import { buildIframeSrcdoc } from '../../src/utils/iframe-srcdoc';

const ARMORED = '-----BEGIN PGP MESSAGE-----\nxx\n-----END PGP MESSAGE-----';

// header lines of a built message (up to the first blank line)
const headerLines = (raw: string) => raw.split('\r\n\r\n')[0].split('\r\n');

const timed = <T>(fn: () => T): [T, number] => {
  const start = performance.now();
  const result = fn();
  return [result, performance.now() - start];
};

describe('mailto and PGP/MIME header injection', () => {
  it('drops an in-reply-to that carries CR/LF from a mailto link', () => {
    const link =
      'mailto:friend@example.com?subject=Hi%0D%0ABcc%3A%20x%40evil.example&in-reply-to=%3Cabc%40x%3E%0D%0ABcc%3A%20attacker%40evil.example%0D%0AX-Injected%3A%201';
    const prefill = mailtoToPrefill(parseMailto(link));
    expect(prefill.inReplyTo || '').toBe('');
    expect(prefill.subject).not.toMatch(/[\r\n]/);

    const raw = buildPgpMimeMessage(ARMORED, {
      from: 'victim@example.com',
      to: prefill.to,
      subject: prefill.subject,
      inReplyTo: prefill.inReplyTo,
    });
    const headers = headerLines(raw);
    expect(headers.some((line) => /^Bcc:/i.test(line))).toBe(false);
    expect(headers.some((line) => /^X-Injected:/i.test(line))).toBe(false);
  });

  it('keeps a well-formed in-reply-to from a mailto link', () => {
    const prefill = mailtoToPrefill(
      parseMailto('mailto:friend@example.com?in-reply-to=%3Cabc%40example.com%3E'),
    );
    expect(prefill.inReplyTo).toBe('<abc@example.com>');
  });

  it('never lets a header value or an address add header lines', () => {
    const raw = buildPgpMimeMessage(ARMORED, {
      from: 'victim@example.com',
      to: ['"Friend\r\nBcc: a@evil.example" <friend@example.com>', 'b@example.com\r\nX-A: 1'],
      cc: ['c@example.com'],
      subject: 'Hello\r\nBcc: s@evil.example',
      messageId: '<id@example.com>\r\nX-B: 1',
      inReplyTo: '<r@example.com>\nX-C: 1',
      references: '<r@example.com>\rX-D: 1',
    });
    const headers = headerLines(raw);
    for (const name of ['Bcc', 'X-A', 'X-B', 'X-C', 'X-D'])
      expect(headers.some((line) => line.startsWith(`${name}:`))).toBe(false);
    expect(headers.find((line) => line.startsWith('Message-ID:'))).toBe(
      'Message-ID: <id@example.com> X-B: 1',
    );
    expect(encodeAddressList(['a@example.com\r\nX: y'])).not.toMatch(/[\r\n]/);
  });

  it('keeps attachment names and types from adding headers to the inner part', () => {
    const inner = buildInnerMime({
      text: 'hi',
      attachments: [
        {
          filename: 'a.pdf"\r\nContent-Type: text/html',
          contentType: 'application/pdf\r\nX-E: 1',
          content: 'AAAA',
          cid: 'x\r\nX-F: 1',
        },
      ],
    } as never);
    expect(inner).not.toMatch(/\r\n(?:X-E|X-F|Content-Type: text\/html)/);
    expect(inner).toContain('name="a.pdf Content-Type: text/html"');
  });

  it('escapes text shared from another app instead of reading it as HTML', () => {
    const prefill = shareToPrefill({
      subject: 'Look\r\nBcc: x@evil.example',
      text: '<img src=x onerror=alert(1)> & <b>hi</b>',
    });
    expect(prefill.subject).not.toMatch(/[\r\n]/);
    expect(prefill.body).not.toContain('<img');
    expect(prefill.body).toContain('&lt;img');
    expect(prefill.text).toBe('<img src=x onerror=alert(1)> & <b>hi</b>');
  });
});

describe('sanitizer runs in linear time on hostile email', () => {
  // (each took tens of seconds before, on inputs a few hundred KB long)
  it('unterminated @font-face rules', () => {
    const [result, ms] = timed(() =>
      sanitizeEmailCss('@font-face{'.repeat(20000), { blockRemoteUrls: true }),
    );
    expect(typeof result.css).toBe('string');
    expect(ms).toBeLessThan(2000);
  });

  it('unterminated url( and comments in a style sheet', () => {
    // ("/*a": a bare "/*/*" would hold a "*/" and close at once)
    for (const css of [
      'p{list-style:url(' + ' '.repeat(60000),
      '/*a'.repeat(60000),
      'url("'.repeat(20000),
    ]) {
      const [, ms] = timed(() => sanitizeEmailCss(css, { blockRemoteUrls: true }));
      expect(ms).toBeLessThan(1000);
    }
  });

  it('a body of unterminated <img tags', () => {
    const html = '<p>x</p>' + '<img'.repeat(80000);
    const [result, ms] = timed(() =>
      sanitizeHtml(html, { blockRemoteImages: true, blockTrackingPixels: true }),
    );
    expect(result.html).toContain('x');
    expect(ms).toBeLessThan(5000);
  });

  it('a quoted style with many unterminated url(data:', () => {
    const html = `<div style="background:${'url(data:'.repeat(40000)}">x</div>`;
    const [, ms] = timed(() => sanitizeQuotedHtml(html));
    expect(ms).toBeLessThan(3000);
  });

  it('inline attachments and text extraction', () => {
    const atts = [{ contentId: '<a>', content: 'AA', contentType: 'image/png' }];
    for (const html of [
      'src=' + ' '.repeat(100000),
      'url(cid:' + 'url(cid:'.repeat(20000),
      '<img'.repeat(80000),
    ]) {
      const [, ms] = timed(() => applyInlineAttachments(html, atts));
      expect(ms).toBeLessThan(2000);
      const [, textMs] = timed(() => extractTextContent(html));
      expect(textMs).toBeLessThan(2000);
    }
  });

  it('viewport-height units in a sheet or style attribute full of unclosed url( and quotes', () => {
    for (const css of ['url('.repeat(80000), '\\"'.repeat(80000), "a:1vh;\\'".repeat(40000)]) {
      const [, ms] = timed(() => sanitizeEmailCss(css));
      expect(ms).toBeLessThan(2000);
    }

    const html = `<div style="height:1vh;${'url('.repeat(40000)}">x</div>`;
    const [result, ms] = timed(() => sanitizeHtml(html));
    expect(result.html).toContain('x');
    expect(ms).toBeLessThan(5000);
  });

  it('still fixes viewport-height units as before', () => {
    expect(fixViewportHeightUnits('div{height:100vh;min-height:50dvh;max-height:10vmax}')).toBe(
      'div{height:800px;min-height:400px;max-height:80px}',
    );
    expect(
      fixViewportHeightUnits('a{background:url(x-100vh.png);content:"5vh";width:10vw;b:a5vh}'),
    ).toBe('a{background:url(x-100vh.png);content:"5vh";width:10vw;b:a5vh}');
    expect(fixViewportHeightUnits('-.5vh, 1.5svh')).toBe('-4px, 12px');
  });

  it('still rewrites ordinary images and fonts as before', () => {
    const { html } = sanitizeHtml(
      '<p>hi</p><img src="https://t.example/p.gif" width="1" height="1">',
      {
        blockTrackingPixels: true,
      },
    );
    expect(html).not.toMatch(/\ssrc="https:\/\/t\.example/);
    expect(html).toContain('data-tracking-pixel');
    const { css } = sanitizeEmailCss(
      "@font-face{font-family:x;src:url(https://f.example/x.woff)} p{margin:0} @font-face{src:url('data:font/woff;base64,AA')}",
    );
    expect(css).not.toContain('f.example');
    expect(css).toContain('data:font/woff');
    expect(css).toContain('p{margin:0}');
  });
});

describe('recurring events from an invite are bounded', () => {
  const ics = (rule: string, dtstart = '20261001T000000Z') =>
    [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VEVENT',
      'UID:rule@example.com',
      'DTSTAMP:20261001T000000Z',
      `DTSTART:${dtstart}`,
      'DTEND:20261001T000001Z',
      `RRULE:${rule}`,
      'SUMMARY:Team sync',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
  const start = new Date('2026-10-01T00:00:00Z');
  const end = new Date(start.getTime() + 455 * 86400e3);

  it('does not expand FREQ=SECONDLY over the calendar window', () => {
    const [instances, ms] = timed(() => expandRecurringMaster(ics('FREQ=SECONDLY'), start, end));
    expect(instances.length).toBeLessThanOrEqual(MAX_INSTANCES_PER_SERIES);
    expect(ms).toBeLessThan(2000);
  });

  it('caps the instances of a dense rule within the window', () => {
    const weeks = new Date(start.getTime() + 14 * 86400e3);
    const [instances, ms] = timed(() => expandRecurringMaster(ics('FREQ=MINUTELY'), start, weeks));
    expect(instances.length).toBe(MAX_INSTANCES_PER_SERIES);
    expect(ms).toBeLessThan(5000);
  });

  it('shows a series it does not expand as one event', () => {
    const events = [{ id: 'a', ical: ics('FREQ=SECONDLY') }];
    const out = expandRecurringEvents(events as never, start, end);
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(MAX_INSTANCES_PER_SERIES);
  });

  it('does not walk a rule that never produces a date to the year 9999', () => {
    for (const rule of [
      'FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30',
      'FREQ=WEEKLY;BYMONTH=4;BYMONTHDAY=31',
    ]) {
      const [instances, ms] = timed(() => expandRecurringMaster(ics(rule), start, end));
      expect(instances).toHaveLength(0);
      expect(ms).toBeLessThan(1000);
    }
  });

  it('still expands a short series that started long ago', () => {
    const instances = expandRecurringMaster(
      ics('FREQ=MINUTELY;COUNT=5', '20240101T000000Z'),
      new Date('2024-01-01T00:00:00Z'),
      new Date('2024-01-02T00:00:00Z'),
    );
    expect(instances).toHaveLength(5);
  });

  it('expands an hourly series over the whole window', () => {
    expect(expandRecurringMaster(ics('FREQ=HOURLY'), start, end)).toHaveLength(455 * 24 + 1);
  });

  it('still expands an ordinary daily series', () => {
    const month = new Date(start.getTime() + 30 * 86400e3);
    // (both ends of the window are included)
    expect(expandRecurringMaster(ics('FREQ=DAILY'), start, month)).toHaveLength(31);
  });
});

describe('other hardening', () => {
  it('redacts email addresses in linear time', () => {
    const [out, ms] = timed(() => redact('a@' + 'a.'.repeat(40000) + ' x@example.com'));
    expect(out).not.toContain('x@example.com');
    expect(ms).toBeLessThan(1000);
    expect(redact('mail john.doe+tag@example.co.uk now')).toMatch(/^mail <email:[0-9a-f]+> now$/);
  });

  it('strips bidi controls from a download filename', () => {
    expect(sanitizeDownloadFilename('invoice_‮fdp.exe')).toBe('invoice_fdp.exe');
    expect(sanitizeDownloadFilename('a⁦b⁩‏.txt')).toBe('ab.txt');
    expect(sanitizeDownloadFilename('report.pdf')).toBe('report.pdf');
  });

  it('sanitizes a cached body a background writer stored raw', () => {
    let calls = 0;
    const sanitize = (html: string) => {
      calls++;
      return {
        html: html.replace('<script>x()</script>', ''),
        hasBlockedImages: true,
        trackingPixelCount: 1,
        blockedRemoteImageCount: 0,
      };
    };
    const raw = cachedBodyForDisplay({ body: '<p>a</p><script>x()</script>' }, sanitize);
    expect(raw.html).toBe('<p>a</p>');
    expect(raw.hasBlockedImages).toBe(true);
    expect(calls).toBe(1);

    const stored = cachedBodyForDisplay(
      { body: '<p>b</p>', trackingPixelCount: 0, blockedRemoteImageCount: 2 },
      sanitize,
    );
    expect(stored).toEqual({
      html: '<p>b</p>',
      hasBlockedImages: true,
      trackingPixelCount: 0,
      blockedRemoteImageCount: 2,
    });
    expect(calls).toBe(1);
  });

  it('lets the email document load only its own script', () => {
    const srcdoc = buildIframeSrcdoc('<p>hi</p>');
    const csp = srcdoc.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] || '';
    const scriptSrc = csp.match(/script-src ([^;]+);/)?.[1].trim() || '';
    expect(scriptSrc === "'self'" || scriptSrc.endsWith('/email-iframe.js')).toBe(true);
    expect(srcdoc).toContain('email-iframe.js');
  });
});

describe('error log', () => {
  it('leaves credentials of a logged object out of the log', async () => {
    const { formatConsoleArg } = await import('../../src/utils/error-logger');
    const { redact } = await import('../../src/utils/redaction');
    const text = redact(
      formatConsoleArg({
        password: 'hunter2',
        token: 'tok_abcdef123456',
        alias_auth: 'user@example.com:Sup3rSecret',
        api_key: 'k_123',
        clientSecret: 'client-secret-value',
        keyCode: 13,
        status: 401,
      }),
    );
    for (const secret of [
      'hunter2',
      'tok_abcdef123456',
      'Sup3rSecret',
      'k_123',
      'client-secret-value',
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('"status":401');
    expect(text).toContain('"keyCode":13');
  });
});
