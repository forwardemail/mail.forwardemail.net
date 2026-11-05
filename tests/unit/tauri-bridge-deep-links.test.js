import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A stand-in for lib.rs: every link is queued in PendingDeepLinks, then
// emitted to the listeners the page has registered (none during a reload).
const native = vi.hoisted(() => ({ queue: [], listeners: [] }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd) => (cmd === 'get_pending_deep_links' ? native.queue.splice(0) : null)),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (event, handler) => {
    const entry = { event, handler };
    native.listeners.push(entry);
    return () => native.listeners.splice(native.listeners.indexOf(entry), 1);
  }),
  emit: vi.fn(),
}));

function osOpens(url) {
  native.queue.push(url);
  for (const { event, handler } of native.listeners) {
    if (event === 'deep-link-received') handler({ payload: { urls: [url] } });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// Loads the page: a reload drops the old listeners but not the native queue.
async function loadPage() {
  native.listeners = [];
  vi.resetModules();
  const { initTauriBridge } = await import('../../src/utils/tauri-bridge.js');
  await initTauriBridge();
}

describe('tauri-bridge deep links', () => {
  let opened;
  const record = (event) => opened.push(event.detail.url);

  beforeEach(() => {
    opened = [];
    native.queue = [];
    native.listeners = [];
    window.__TAURI_INTERNALS__ = {};
    window.addEventListener('app:deep-link', record);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    window.removeEventListener('app:deep-link', record);
    delete window.__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('does not replay a handled mailto link after a reload', async () => {
    await loadPage();
    osOpens('mailto:alice@example.com');
    await settle();
    expect(opened).toEqual(['mailto:alice@example.com']);

    await loadPage();
    await settle();
    expect(opened).toEqual(['mailto:alice@example.com']);
  });

  it('opens a link from before the listener once, alongside a live one', async () => {
    // Cold start: the OS hands over the link before the page listens.
    osOpens('mailto:bob@example.com');
    await loadPage();
    osOpens('mailto:carol@example.com');
    await settle();
    expect(opened).toEqual(['mailto:bob@example.com', 'mailto:carol@example.com']);

    await loadPage();
    await settle();
    expect(opened).toEqual(['mailto:bob@example.com', 'mailto:carol@example.com']);
  });
});
