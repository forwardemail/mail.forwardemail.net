import { beforeEach, describe, expect, it } from 'vitest';
import { linkToOpen, stripTrackingParams } from '../../src/utils/tracking-params';
import { Local } from '../../src/utils/storage.js';

describe('stripTrackingParams', () => {
  it('removes attribution parameters and keeps everything else', () => {
    const { url, removed } = stripTrackingParams(
      'https://shop.example/item?id=42&utm_source=news&utm_medium=email&fbclid=abc&ref=home#reviews',
    );
    expect(url).toBe('https://shop.example/item?id=42&ref=home#reviews');
    expect(removed.sort()).toEqual(['fbclid', 'utm_medium', 'utm_source']);
  });

  it('matches parameter names without regard to case', () => {
    expect(stripTrackingParams('https://x.example/?UTM_Campaign=a&GCLID=b&q=1').url).toBe(
      'https://x.example/?q=1',
    );
  });

  it('leaves a link with nothing to remove exactly as written', () => {
    const href = 'https://x.example/a?b=c%20d&e';
    expect(stripTrackingParams(href)).toEqual({ url: href, removed: [] });
  });

  it('leaves non-web links and junk alone', () => {
    expect(stripTrackingParams('mailto:a@x.example?utm_source=x').url).toBe(
      'mailto:a@x.example?utm_source=x',
    );
    expect(stripTrackingParams('not a url').url).toBe('not a url');
  });
});

describe('linkToOpen', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens links as written unless the user turned stripping on', () => {
    const href = 'https://x.example/?utm_source=a&id=1';
    expect(linkToOpen(href)).toBe(href);
    Local.set('strip_link_tracking', 'true');
    expect(linkToOpen(href)).toBe('https://x.example/?id=1');
  });
});
