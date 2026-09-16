import { describe, it, expect } from 'vitest';
import {
  describeLinkTarget,
  hostFromLinkText,
  truncateMiddle,
  LINK_PREVIEW_MAX_LENGTH,
} from '../../src/utils/link-preview';

describe('hostFromLinkText', () => {
  it('reads a host out of URL-like and domain-like link text', () => {
    expect(hostFromLinkText('https://www.paypal.com/login')).toBe('www.paypal.com');
    expect(hostFromLinkText('paypal.com')).toBe('paypal.com');
    expect(hostFromLinkText('<https://example.org/x>')).toBe('example.org');
    expect(hostFromLinkText('192.168.0.1/admin')).toBe('192.168.0.1');
  });

  it('ignores prose, bare words, and non-http schemes', () => {
    expect(hostFromLinkText('Click here')).toBeNull();
    expect(hostFromLinkText('login')).toBeNull();
    expect(hostFromLinkText('mailto:a@b.co')).toBeNull();
    expect(hostFromLinkText('support@forwardemail.net')).toBeNull();
    expect(hostFromLinkText('tel:+15555550100')).toBeNull();
    expect(hostFromLinkText('')).toBeNull();
    expect(hostFromLinkText(null)).toBeNull();
  });
});

describe('describeLinkTarget', () => {
  it('splits an http link into prefix, host, and suffix', () => {
    const p = describeLinkTarget('https://forwardemail.net/docs/faq?x=1#top', 'FAQ');
    expect(p.kind).toBe('http');
    expect(p.prefix).toBe('https://');
    expect(p.host).toBe('forwardemail.net');
    expect(p.suffix).toBe('/docs/faq?x=1#top');
    expect(p.display).toBe('https://forwardemail.net/docs/faq?x=1#top');
    expect(p.isIdn).toBe(false);
    expect(p.mismatch).toBeNull();
  });

  it('strips embedded credentials so a fake host cannot lead the URL', () => {
    const p = describeLinkTarget('https://paypal.com:secret@evil.example/login', 'Sign in');
    expect(p.host).toBe('evil.example');
    expect(p.display).toBe('https://evil.example/login');
    expect(p.display).not.toContain('paypal.com');
  });

  it('flags link text that names a different host than the href', () => {
    const p = describeLinkTarget('https://evil.example/pp', 'https://www.paypal.com/account');
    expect(p.mismatch).toEqual({ textHost: 'www.paypal.com' });
  });

  it('does not flag www and case differences, or prose text', () => {
    expect(describeLinkTarget('https://www.Example.org/a', 'example.org').mismatch).toBeNull();
    expect(describeLinkTarget('https://evil.example/a', 'Reset your password').mismatch).toBeNull();
  });

  it('keeps punycode hosts as-is and marks them', () => {
    const p = describeLinkTarget('https://xn--pypal-4ve.com/x', 'paypal.com');
    expect(p.host).toBe('xn--pypal-4ve.com');
    expect(p.isIdn).toBe(true);
    expect(p.mismatch).toEqual({ textHost: 'paypal.com' });
  });

  it('passes mailto and tel through as plain display strings', () => {
    expect(describeLinkTarget('mailto:support@forwardemail.net')).toMatchObject({
      kind: 'mailto',
      display: 'mailto:support@forwardemail.net',
    });
    expect(describeLinkTarget('tel:+15555550100')).toMatchObject({ kind: 'tel' });
  });

  it('rejects unsupported and malformed hrefs', () => {
    expect(describeLinkTarget('javascript:alert(1)').kind).toBe('unsupported');
    expect(describeLinkTarget('data:text/html,hi').kind).toBe('unsupported');
    expect(describeLinkTarget('not a url').kind).toBe('unsupported');
    expect(describeLinkTarget('').kind).toBe('unsupported');
  });

  it('truncates long URLs in the middle and keeps the host intact', () => {
    const long = `https://tracking.example.com/${'a'.repeat(300)}/final-page.html`;
    const p = describeLinkTarget(long);
    expect(p.display.length).toBe(LINK_PREVIEW_MAX_LENGTH);
    expect(p.display).toContain('…');
    expect(p.display.startsWith('https://tracking.example.com/')).toBe(true);
    expect(p.display.endsWith('final-page.html')).toBe(true);
    expect(`${p.prefix}${p.host}${p.suffix}`).toBe(p.display);
  });
});

describe('truncateMiddle', () => {
  it('leaves short values alone and bounds long ones to max', () => {
    expect(truncateMiddle('short', 10)).toBe('short');
    const t = truncateMiddle('0123456789abcdefghij', 11);
    expect(t.length).toBe(11);
    expect(t).toBe('012345…ghij');
  });
});
