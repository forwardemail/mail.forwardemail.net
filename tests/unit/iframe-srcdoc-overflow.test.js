/**
 * Tests for iframe-srcdoc CSS overflow behavior.
 *
 * Emails with wide tables or pre-formatted content can overflow the
 * reader panel.  The fix changes overflow-x from 'hidden' to 'auto'
 * so a horizontal scrollbar appears instead of clipping content.
 *
 * These tests verify the generated srcdoc HTML contains the correct
 * overflow-x: auto declarations.
 */

import { describe, it, expect } from 'vitest';
import { buildIframeSrcdoc } from '../../src/utils/iframe-srcdoc.ts';

describe('iframe-srcdoc overflow CSS', () => {
  it('uses overflow-x: auto on html,body instead of hidden', () => {
    const html = buildIframeSrcdoc('<p>Hello</p>', false);
    // Should NOT contain overflow-x: hidden
    expect(html).not.toMatch(/overflow-x:\s*hidden/);
    // Should contain overflow-x: auto
    expect(html).toMatch(/overflow-x:\s*auto/);
  });

  it('preserves overflow-y: auto on body', () => {
    const html = buildIframeSrcdoc('<p>Hello</p>', false);
    expect(html).toMatch(/overflow-y:\s*auto/);
  });

  it('preserves overflow-wrap: break-word on html,body', () => {
    const html = buildIframeSrcdoc('<p>Hello</p>', false);
    expect(html).toMatch(/overflow-wrap:\s*break-word/);
  });
});

describe('iframe-srcdoc shrink-to-fit host', () => {
  // public/email-iframe.js scales .fe-email-content and pins the resulting
  // painted height on .fe-email-viewport. Both selectors are a contract
  // between the two files; the runtime silently no-ops if either is missing.
  it('wraps the email content in the viewport host the runtime scales against', () => {
    const html = buildIframeSrcdoc('<p>Hello</p>', false);
    expect(html).toMatch(/<div class="fe-email-viewport">\s*<div class="fe-email-content">/);
  });

  it('clips the host vertically so the unscaled layout box cannot inflate the document', () => {
    const html = buildIframeSrcdoc('<p>Hello</p>', false);
    const host = /\.fe-email-viewport \{([^}]*)\}/.exec(html);
    expect(host).not.toBeNull();
    expect(host[1]).toMatch(/overflow-y:\s*clip/);
    // Horizontal stays reachable for emails too wide to scale legibly.
    expect(host[1]).toMatch(/overflow-x:\s*visible/);
  });

  it('applies the same host in plain-text mode', () => {
    const html = buildIframeSrcdoc('hello', false, true);
    expect(html).toMatch(/<div class="fe-email-viewport">/);
    expect(html).toMatch(/fe-email-plaintext/);
  });
});
