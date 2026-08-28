/**
 * The updater-manifest diagnostic on desktop.
 *
 * The probe must go through the updater plugin (Rust-side HTTP), never a
 * webview fetch: github.com is not in the frozen CSP's connect-src, so a
 * webview fetch is blocked before it touches the network - the probe itself
 * became the CSP violation it was reporting. These tests pin the plugin
 * route and that a null result (manifest fetched, app current) counts as
 * reachable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isTauriDesktop: true,
}));

const check = vi.fn();
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));

const { checkUpdaterManifest } = await import('../../src/utils/diagnostics');

beforeEach(() => {
  check.mockReset();
});

describe('checkUpdaterManifest (desktop)', () => {
  it('passes with the latest version when the plugin returns an update', async () => {
    check.mockResolvedValue({ version: '9.9.9', available: true });

    const result = await checkUpdaterManifest();
    expect(result.status).toBe('pass');
    expect(result.message).toContain('9.9.9');
  });

  it('passes when the plugin returns null - manifest fetched, app current', async () => {
    check.mockResolvedValue(null);

    const result = await checkUpdaterManifest();
    expect(result.status).toBe('pass');
    expect(result.message).toMatch(/up to date/i);
  });

  it('fails with the underlying error when the Rust-side fetch rejects', async () => {
    check.mockRejectedValue(new Error('error sending request'));

    const result = await checkUpdaterManifest();
    expect(result.status).toBe('fail');
    expect(result.message).toContain('error sending request');
  });

  it('never issues a webview fetch, which the frozen CSP would block', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    check.mockResolvedValue(null);

    await checkUpdaterManifest();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
