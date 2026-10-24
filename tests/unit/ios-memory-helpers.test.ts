/**
 * Helpers that keep the iOS web content process under its memory limit, and
 * the launch that follows when it was not.
 */
import { describe, expect, it } from 'vitest';

import {
  MOBILE_CACHED_ATTACHMENT_MAX_BYTES,
  cachedBodyStatus,
  rawHeaderSection,
  slimBodyMeta,
  slimCachedAttachments,
  worklistFromHeaders,
} from '../../src/workers/sync-pure.ts';
import { isCrashLoop, withoutLinkedMessage } from '../../src/utils/boot-history.ts';
import {
  fixViewportHeightUnits,
  sanitizeEmailCss,
  sanitizeHtml,
} from '../../src/utils/sanitize.js';

describe('a phone keeps a lean copy of each body', () => {
  const raw = 'Subject: Hi\r\nReply-To: r@x.test\r\n\r\n' + 'A'.repeat(100_000);

  it('keeps the headers of the raw message, not the message', () => {
    expect(rawHeaderSection(raw)).toBe('Subject: Hi\r\nReply-To: r@x.test');
    expect(rawHeaderSection('Subject: a\n\nbody')).toBe('Subject: a');
    expect(rawHeaderSection('')).toBe('');
    expect(rawHeaderSection(null)).toBe('');
  });

  it('drops the raw message and the parsed copy of the body and attachments', () => {
    const meta = {
      id: 'm1',
      raw,
      headers: { subject: 'Hi' },
      nodemailer: {
        html: '<p>hi</p>',
        text: 'hi',
        textAsHtml: '<p>hi</p>',
        replyTo: { text: 'r@x.test' },
        attachments: [{ filename: 'a.jpg', size: 9, content: 'AAAA' }],
      },
    };
    expect(slimBodyMeta(meta)).toEqual({
      id: 'm1',
      headers: { subject: 'Hi' },
      rawOmitted: true,
      rawHeaders: 'Subject: Hi\r\nReply-To: r@x.test',
      nodemailer: {
        replyTo: { text: 'r@x.test' },
        attachments: [{ filename: 'a.jpg', size: 9 }],
      },
    });
    expect(slimBodyMeta(null)).toBeNull();
    expect(slimBodyMeta({ id: 'm2' })).toEqual({ id: 'm2' });
  });

  it('lists large attachments without their content and keeps small and inline ones', () => {
    const big = `data:image/jpeg;base64,${'A'.repeat(Math.ceil((MOBILE_CACHED_ATTACHMENT_MAX_BYTES * 4) / 3) + 100)}`;
    const small = 'data:application/pdf;base64,AAAA';
    const out = slimCachedAttachments([
      { name: 'photo.jpg', href: big, size: 0 },
      { name: 'doc.pdf', href: small, size: 3 },
      { name: 'logo.png', href: big, contentId: 'logo' },
      { name: 'remote', href: 'https://x.test/a' },
      { name: 'declared', href: small, size: MOBILE_CACHED_ATTACHMENT_MAX_BYTES + 1 },
    ]);
    expect(out[0]).toEqual({ name: 'photo.jpg', size: 0, needsDownload: true });
    expect(out[1].href).toBe(small);
    expect(out[2].href).toBe(big);
    expect(out[3].href).toBe('https://x.test/a');
    expect(out[4]).toMatchObject({ name: 'declared', needsDownload: true });
    expect(out[4].href).toBeUndefined();
  });
});

describe('which bodies the prefetch downloads', () => {
  const headers = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c', has_attachment: true },
    { id: 'd', has_attachment: true },
    { id: 'e' },
  ];

  it('decides the same from statuses as from the bodies', () => {
    const bodies = [
      { body: '<p>a</p>', attachments: [] },
      undefined,
      { body: '<p>c</p>', attachments: [] },
      { body: '<p>d</p>', attachments: [], attachmentsResolved: true },
      { body: '-----BEGIN PGP MESSAGE-----\nx' },
    ];
    const fromBodies = worklistFromHeaders(headers, bodies);
    const fromStatuses = worklistFromHeaders(headers, bodies.map(cachedBodyStatus));
    expect(fromBodies.map((h) => h.id)).toEqual(['b', 'c', 'e']);
    expect(fromStatuses).toEqual(fromBodies);
  });
});

describe('a launch after the page kept dying', () => {
  const at = (minutes: number) => Date.UTC(2026, 9, 23, 22, 0) + minutes * 60_000;

  it('is told apart from one quick death or deaths far apart', () => {
    // the reported pattern: loads 10 to 17 seconds apart, each after a death
    const loop = [
      { at: at(-400), previousEndedOnScreen: null },
      { at: at(0), previousEndedOnScreen: true },
      { at: at(0.22), previousEndedOnScreen: true },
      { at: at(0.4), previousEndedOnScreen: true },
    ];
    expect(isCrashLoop(loop)).toBe(true);
    expect(isCrashLoop(loop.slice(0, 3))).toBe(false); // only one quick death so far
    expect(
      isCrashLoop([
        { at: at(0), previousEndedOnScreen: null },
        { at: at(30), previousEndedOnScreen: true },
        { at: at(60), previousEndedOnScreen: true },
      ]),
    ).toBe(false);
    expect(
      isCrashLoop([
        { at: at(0), previousEndedOnScreen: null },
        { at: at(0.2), previousEndedOnScreen: false },
        { at: at(0.4), previousEndedOnScreen: true },
      ]),
    ).toBe(false);
    expect(isCrashLoop([])).toBe(false);
  });

  it('lands on the folder instead of reopening the linked message', () => {
    expect(withoutLinkedMessage('#INBOX/64b7f0c2e4b0a1a2b3000001')).toBe('#INBOX');
    expect(withoutLinkedMessage('#INBOX/abc?unread=1')).toBe('#INBOX?unread=1');
    expect(withoutLinkedMessage('#Work%2FClients/abc')).toBe('#Work%2FClients');
    expect(withoutLinkedMessage('#INBOX')).toBe('#INBOX');
    expect(withoutLinkedMessage('#INBOX?q=a/b')).toBe('#INBOX?q=a/b');
    expect(withoutLinkedMessage('')).toBe('');
  });
});

describe('viewport-height lengths in email', () => {
  // The frame is sized to its content, so 100vh grew with it without end
  it('become fixed lengths', () => {
    expect(fixViewportHeightUnits('height: 100vh; min-height:50dvh')).toBe(
      'height: 800px; min-height:400px',
    );
    expect(fixViewportHeightUnits('margin:-12.5svh 0 calc(100lvh - 2px)')).toBe(
      'margin:-100px 0 calc(800px - 2px)',
    );
    expect(fixViewportHeightUnits('width: 50vmax; height: .5vh')).toBe('width: 400px; height: 4px');
    // widths, and numbers inside other tokens, are left alone
    expect(fixViewportHeightUnits('width: 100vw; background: url(img100vh.png)')).toBe(
      'width: 100vw; background: url(img100vh.png)',
    );
    // and so are url() references and strings
    for (const css of [
      'background: url(/img/100vh.jpg)',
      "background: url('https://x.test/hero/50vh.png')",
      'background-image: url(data:image/png;base64,AB+12vh+CD)',
      'content: "100vh"',
      "font-family: 'Font 10vh'",
    ]) {
      expect(fixViewportHeightUnits(css)).toBe(css);
    }
    expect(fixViewportHeightUnits('height: 10vh; content: "5vh"; min-height: 20dvb')).toBe(
      'height: 80px; content: "5vh"; min-height: 160px',
    );
  });

  it('are fixed in stylesheets and inline styles', () => {
    expect(sanitizeEmailCss('.hero { height: 100vh }').css).toBe('.hero { height: 800px }');
    const { html } = sanitizeHtml('<div style="min-height: 100vh">Hi</div>', {
      blockRemoteImages: false,
      blockTrackingPixels: false,
    });
    expect(html).toContain('min-height: 800px');
    expect(html).not.toContain('vh');
  });
});
