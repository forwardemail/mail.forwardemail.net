/**
 * Draft output cleanup tests.
 *
 * Claude occasionally prepends "Here is a draft:" and wraps the body in
 * horizontal rules despite the system prompt asking it not to. These tests
 * lock in the strip patterns so the preamble never reaches the user's
 * actual email when they hit "Open as draft".
 */

import { describe, expect, it } from 'vitest';
import { cleanDraftOutput, buildReplyPrefill } from '../../../src/ai/context/thread-context';

describe('cleanDraftOutput', () => {
  it('returns empty for empty input', () => {
    expect(cleanDraftOutput('')).toBe('');
    expect(cleanDraftOutput('   ')).toBe('');
  });

  it('leaves a clean draft untouched', () => {
    const draft = 'Thanks for reaching out.\n\nCould you share the domain?';
    expect(cleanDraftOutput(draft)).toBe(draft);
  });

  it('strips "Here is a draft reply body: --- ..." preamble on one line', () => {
    const input = 'Here is a draft reply body: --- Thank you for reaching out about the issue.';
    expect(cleanDraftOutput(input)).toBe('Thank you for reaching out about the issue.');
  });

  it('strips a multi-line "Here is a draft:" + HR separator', () => {
    const input = 'Here is a draft:\n\n---\n\nThank you for reaching out.';
    expect(cleanDraftOutput(input)).toBe('Thank you for reaching out.');
  });

  it("strips Here's variant with curly apostrophe", () => {
    const input = 'Here’s a draft reply: Hello Alice,\n\nThanks for the ping.';
    expect(cleanDraftOutput(input)).toBe('Hello Alice,\n\nThanks for the ping.');
  });

  it('strips trailing horizontal rule', () => {
    const input = 'Thanks for the note.\n\n---';
    expect(cleanDraftOutput(input)).toBe('Thanks for the note.');
  });

  it('does not eat emphasis markers on real content', () => {
    const input = '__Important__: please confirm.';
    expect(cleanDraftOutput(input)).toBe('__Important__: please confirm.');
  });

  it('preserves a legitimate single-dash bullet list', () => {
    const input = 'Please confirm:\n\n- domain\n- error code\n- timezone';
    expect(cleanDraftOutput(input)).toBe(input);
  });
});

describe('buildReplyPrefill', () => {
  const msg = {
    subject: 'Lemlist delivery issue',
    from: 'alice@acme.com',
  };

  it('cleans the draft and renders HTML for TipTap', () => {
    const raw = 'Here is a draft reply body:\n\n---\n\n**Thanks** for the report.';
    const prefill = buildReplyPrefill(msg, raw);
    expect(prefill.body).toBe('**Thanks** for the report.');
    expect(prefill.html).toContain('<strong>Thanks</strong>');
  });

  it('prefixes subject with Re: when missing', () => {
    const prefill = buildReplyPrefill(msg, 'ok');
    expect(prefill.subject).toBe('Re: Lemlist delivery issue');
  });

  it('does not double-prefix Re:', () => {
    const prefill = buildReplyPrefill({ ...msg, subject: 'Re: already replied' }, 'ok');
    expect(prefill.subject).toBe('Re: already replied');
  });
});
