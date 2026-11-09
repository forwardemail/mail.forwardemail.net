/**
 * Links in an email shown as plain text (src/utils/iframe-srcdoc.ts).
 */
import { describe, expect, it } from 'vitest';
import { buildIframeSrcdoc } from '../../src/utils/iframe-srcdoc.ts';

const body = (text) =>
  buildIframeSrcdoc(text, false, true).match(
    /<pre class="fe-email-plaintext">([\s\S]*?)<\/pre>/,
  )[1];

describe('plain-text links', () => {
  it('ends a link written in angle brackets before the closing bracket', () => {
    expect(body('visit forwardemail.net <https://forwardemail.net>')).toBe(
      'visit forwardemail.net &lt;<a href="https://forwardemail.net" target="_blank" rel="noopener noreferrer">https://forwardemail.net</a>&gt;',
    );
    expect(body('<mailto:support@forwardemail.net>')).toContain(
      'href="mailto:support@forwardemail.net"',
    );
  });

  it('keeps a query string whole', () => {
    expect(body('https://example.com/a?x=1&y=2 next')).toContain(
      'href="https://example.com/a?x=1&amp;y=2"',
    );
  });
});
