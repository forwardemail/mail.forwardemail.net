/**
 * Quote handling for a third-party reply seen in the wild (2026-08-26).
 *
 * A user replied to a Forward Email thread from an unidentified client that
 * emits an spm-* "Replying to X on DATE" header plus a From/To/Date/Subject
 * block inside a cite blockquote, itself containing a Thunderbird-style
 * nested quote and a stray id="iframeContentContainer" leaked from that
 * client's own reader. The fixture below is the real structure.
 *
 * Two properties are load-bearing:
 *   1. The reader wraps the OUTER quote exactly once - no second toggle for
 *      the nested quote, the [class*="quoted"] title, or the From: lines.
 *   2. Replying to this message from our client strips every trace of our
 *      collapse UI. Anything left would be MAILED, putting our literal
 *      "... Hide quoted text" button into the recipient's copy - the exact
 *      misformat being investigated, but caused by us.
 */
import { describe, expect, it } from 'vitest';
import { processQuotedContent } from '../../src/utils/quote-collapse.js';
import { stripQuoteCollapseMarkup } from '../../src/stores/mailboxActions';

const THIRD_PARTY_REPLY = `<p>Thanks, that worked.</p>
<blockquote style="margin: 0px;" type="cite" class="spm-quote-block">
  <p class="spm-quoted-email--title">Replying to support@forwardemail.net on August 26, 2026, 12:40 PM</p>
  <div><div>From: support@forwardemail.net</div><div>To: wesley@example.com</div><div>Date: August 26, 2026, 12:40 PM</div><div>Subject: Re: Iphone Push</div></div>
  <div id="iframeContentContainer"><p>It will be supported in ~2 weeks.</p>
    <div class="moz-cite-prefix">On 8/26/26 3:38 PM, wesley wrote:<br></div>
    <blockquote type="cite">
      <div style="font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt;">Hey,</div>
      <div style="font-family: Arial, Helvetica, sans-serif; font-size: 10.5pt;">Is push working?</div>
    </blockquote></div>
</blockquote>`;

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('third-party spm reply structure', () => {
  it('wraps the outer quote exactly once, never the nested layers', () => {
    const processed = processQuotedContent(THIRD_PARTY_REPLY);

    expect(count(processed, 'fe-quote-wrapper')).toBe(1);
    expect(count(processed, 'fe-quote-toggle')).toBe(1);
    // The new reply text stays outside the collapsed region.
    expect(processed.indexOf('Thanks, that worked')).toBeLessThan(
      processed.indexOf('fe-quote-wrapper'),
    );
    // Nothing inside was lost.
    for (const marker of [
      'spm-quoted-email--title',
      'From: support@forwardemail.net',
      'moz-cite-prefix',
      'Is push working?',
    ]) {
      expect(processed).toContain(marker);
    }
  });

  it('is idempotent when the stored processed body is processed again', () => {
    const once = processQuotedContent(THIRD_PARTY_REPLY);
    const twice = processQuotedContent(once);

    expect(count(twice, 'fe-quote-wrapper')).toBe(1);
    expect(count(twice, 'fe-quote-toggle')).toBe(1);
  });

  it('strips every trace of the collapse UI when replying from our client', () => {
    const processed = processQuotedContent(THIRD_PARTY_REPLY);
    const stripped = stripQuoteCollapseMarkup(processed);

    for (const marker of [
      'fe-quote-wrapper',
      'fe-quote-toggle',
      'fe-quote-content',
      'Hide quoted text',
      'Show quoted text',
      '<button',
    ]) {
      expect(stripped).not.toContain(marker);
    }
    // The quoted thread itself survives intact for the outgoing reply.
    for (const marker of [
      'spm-quote-block',
      'moz-cite-prefix',
      'Is push working?',
      'Thanks, that worked',
    ]) {
      expect(stripped).toContain(marker);
    }
  });

  it('wraps a top-level Thunderbird reply in ONE collapsible, prefix included', () => {
    // moz-cite-prefix and its blockquote are SIBLINGS. Before the pass
    // reorder, the blockquote was wrapped first and the prefix separately,
    // stacking two toggle rows on every Thunderbird reply.
    const tb = `<p>New reply text.</p>
<div class="moz-cite-prefix">On 8/26/26 3:38 PM, wesley wrote:<br></div>
<blockquote type="cite"><p>Original text.</p></blockquote>`;
    const out = processQuotedContent(tb);

    expect(count(out, 'fe-quote-toggle')).toBe(1);
    // The attribution line collapses WITH the quote, not on its own.
    const content = out.slice(out.indexOf('fe-quote-content'));
    expect(content).toContain('wesley wrote');
    expect(content).toContain('Original text.');
    expect(out.indexOf('New reply text.')).toBeLessThan(out.indexOf('fe-quote-wrapper'));
  });

  it('wraps a Gmail reply in ONE collapsible with no nested wrapper', () => {
    // Gmail nests its blockquote INSIDE div.gmail_quote. Wrapping the inner
    // blockquote first and the container second nested a second toggle inside
    // the collapsed content.
    const gm = `<div dir="ltr">New reply.</div>
<div class="gmail_quote"><div class="gmail_attr">On Tue, Aug 26, 2026 wesley wrote:<br></div>
<blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex"><p>Original.</p></blockquote></div>`;
    const out = processQuotedContent(gm);

    expect(count(out, 'fe-quote-toggle')).toBe(1);
    expect(count(out, 'fe-quote-wrapper')).toBe(1);
  });

  it('handles the variant where the client emits the header OUTSIDE the blockquote', () => {
    // Same markup, but the title and header block precede the blockquote -
    // several clients emit this shape. The [class*="quoted"] matcher sees the
    // spm-quoted-email--title class, so this guards against a second toggle
    // appearing above the first.
    const variant = THIRD_PARTY_REPLY.replace(
      /<blockquote style="margin: 0px;"[^>]*>\s*<p class="spm-quoted-email--title">([^<]+)<\/p>/,
      '<p class="spm-quoted-email--title">$1</p><blockquote style="margin: 0px;" type="cite" class="spm-quote-block">',
    );
    expect(variant).not.toBe(THIRD_PARTY_REPLY);

    const processed = processQuotedContent(variant);
    const toggles = count(processed, 'fe-quote-toggle');
    expect(toggles, 'a second toggle row renders as visible junk above the quote').toBe(1);
  });
});
