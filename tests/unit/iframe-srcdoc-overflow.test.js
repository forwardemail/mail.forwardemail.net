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
