/**
 * Phones and tablets get the lighter search index and no body text in it by
 * default: on iOS the web content process (and every worker with it) is ended
 * when it crosses its memory limit, which the user sees as the app going
 * blank and reloading.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const load = async (userAgent: string, maxTouchPoints = 0) => {
  vi.resetModules();
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
  localStorage.clear();
  const { isMemoryConstrained } = await import('../../src/utils/memory-profile');
  const { resolveSearchBodyIndexing } = await import('../../src/utils/search-body-indexing.js');
  // The setting itself, which the mailbox load copies into the search store
  // (and saves): its default has to agree.
  const { SETTINGS_REGISTRY } = await import('../../src/stores/settingsRegistry');
  const setting = SETTINGS_REGISTRY.search_body_indexing;
  expect(setting.defaultValue).toBe(resolveSearchBodyIndexing());
  expect(setting.localParse?.(null)).toBe(resolveSearchBodyIndexing());
  return { isMemoryConstrained, bodyIndexing: resolveSearchBodyIndexing() };
};

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  localStorage.clear();
});

describe('memory profile', () => {
  it('treats an iPhone as constrained and leaves body search off by default', async () => {
    expect(await load(IPHONE, 5)).toEqual({ isMemoryConstrained: true, bodyIndexing: false });
  });

  it('treats an iPad presenting a desktop user agent as constrained', async () => {
    expect((await load(IPAD_DESKTOP_UA, 5)).isMemoryConstrained).toBe(true);
  });

  it('keeps desktop as before, with body search on', async () => {
    expect(await load(DESKTOP, 0)).toEqual({ isMemoryConstrained: false, bodyIndexing: true });
  });

  it('keeps the setting the user chose on a phone', async () => {
    vi.resetModules();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
    localStorage.clear();
    const { Local } = await import('../../src/utils/storage.js');
    const { resolveSearchBodyIndexing } = await import('../../src/utils/search-body-indexing.js');
    // The phone default has been applied once; the user then turned it on
    resolveSearchBodyIndexing();
    Local.set('search_body_indexing', 'true');
    expect(resolveSearchBodyIndexing()).toBe(true);
    expect(resolveSearchBodyIndexing()).toBe(true);
  });

  it('turns off, once, body search an earlier build left on on a phone', async () => {
    vi.resetModules();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(IPHONE);
    localStorage.clear();
    const { Local } = await import('../../src/utils/storage.js');
    // Every mailbox load wrote the setting back, and it was on by default
    Local.set('search_body_indexing', 'true');
    Local.set('include_body', 'true');
    const { resolveSearchBodyIndexing } = await import('../../src/utils/search-body-indexing.js');
    expect(resolveSearchBodyIndexing()).toBe(false);
    expect(Local.get('search_body_indexing')).toBe('false');
    // and the setting is the user's from then on
    Local.set('search_body_indexing', 'true');
    expect(resolveSearchBodyIndexing()).toBe(true);
  });

  it('leaves desktop body search as it was stored', async () => {
    vi.resetModules();
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(DESKTOP);
    localStorage.clear();
    const { Local } = await import('../../src/utils/storage.js');
    Local.set('search_body_indexing', 'false');
    const { resolveSearchBodyIndexing } = await import('../../src/utils/search-body-indexing.js');
    expect(resolveSearchBodyIndexing()).toBe(false);
  });
});
