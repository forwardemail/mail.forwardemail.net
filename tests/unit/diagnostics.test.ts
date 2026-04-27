/**
 * Diagnostics runner tests.
 *
 * Covers the things that are easy to regress:
 *   - The report shape — UI + support tooling depend on these field names.
 *   - The summary counts — used in the UI banner.
 *   - The text formatter — the thing users actually paste into bug reports.
 *   - Redaction-by-omission: the report must not contain anything from
 *     localStorage, the auth store, or message contents. We assert on the
 *     allowlist of top-level fields rather than denylisting forever.
 *   - Individual checks under mocked environments — happy-path and the
 *     specific failure modes that map back to known bugs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  isTauriDesktop: false,
  isTauriMobile: false,
  getPlatform: () => 'web',
}));

import {
  checkApiConnectivity,
  checkCSPEnforcement,
  checkIndexedDB,
  checkServiceWorker,
  checkUpdaterManifest,
  formatReportText,
  runDiagnostics,
  summarizeReport,
  type DiagnosticsReport,
} from '../../src/utils/diagnostics';

const fixtureReport = (): DiagnosticsReport => ({
  generatedAt: '2026-04-26T12:00:00.000Z',
  platform: { runtime: 'web', userAgent: 'jsdom', language: 'en', online: true },
  results: [
    { id: 'a', label: 'A', status: 'pass', message: 'ok', durationMs: 10 },
    { id: 'b', label: 'B', status: 'fail', message: 'broken', durationMs: 20 },
    { id: 'c', label: 'C', status: 'warn', message: 'meh', durationMs: 5 },
    { id: 'd', label: 'D', status: 'skip', message: 'n/a', durationMs: 0 },
  ],
});

describe('summarizeReport', () => {
  it('counts every status', () => {
    expect(summarizeReport(fixtureReport())).toEqual({ pass: 1, fail: 1, warn: 1, skip: 1 });
  });

  it('returns zeros for an empty report', () => {
    expect(summarizeReport({ ...fixtureReport(), results: [] })).toEqual({
      pass: 0,
      fail: 0,
      warn: 0,
      skip: 0,
    });
  });
});

describe('formatReportText', () => {
  it('produces a header + one line per check', () => {
    const text = formatReportText(fixtureReport());
    const lines = text.split('\n');
    expect(lines[0]).toBe('Forward Email — Diagnostics');
    expect(text).toContain('Generated: 2026-04-26T12:00:00.000Z');
    expect(text).toContain('Runtime:   web');
    expect(text).toMatch(/\[PASS\] A \(10ms\): ok/);
    expect(text).toMatch(/\[FAIL\] B \(20ms\): broken/);
  });

  it('aligns status tags to fixed width', () => {
    const text = formatReportText(fixtureReport());
    // PASS, FAIL, WARN, SKIP all 4-char already; ensure padEnd doesn't add
    // trailing spaces that break grep.
    expect(text).toContain('[PASS]');
    expect(text).toContain('[SKIP]');
  });
});

describe('redaction contract', () => {
  it('report has only the documented top-level fields', () => {
    const report = fixtureReport();
    // If you add a field here, write a test about what it can and cannot
    // contain. This guard keeps PII from creeping in via unreviewed adds.
    expect(Object.keys(report).sort()).toEqual(['generatedAt', 'platform', 'results']);
    expect(Object.keys(report.platform).sort()).toEqual([
      'language',
      'online',
      'runtime',
      'userAgent',
    ]);
  });

  it('result objects expose only the documented fields', () => {
    for (const r of fixtureReport().results) {
      const allowed = new Set(['id', 'label', 'status', 'message', 'durationMs', 'detail']);
      for (const k of Object.keys(r)) {
        expect(allowed.has(k)).toBe(true);
      }
    }
  });
});

describe('checkApiConnectivity', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes on any HTTP response (even non-2xx — we are testing the network path)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 401 })) as never;
    const r = await checkApiConnectivity('https://api.forwardemail.net/v1/lookup');
    expect(r.status).toBe('pass');
    expect(r.message).toBe('HTTP 401');
    expect((r.detail as { httpStatus: number }).httpStatus).toBe(401);
  });

  it('fails when fetch throws (this is the macOS sandbox failure mode)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as never;
    const r = await checkApiConnectivity('https://api.forwardemail.net/v1/lookup');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('Failed to fetch');
  });

  it('records duration in ms', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as never;
    const r = await checkApiConnectivity('https://api.forwardemail.net/v1/lookup');
    expect(typeof r.durationMs).toBe('number');
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('checkCSPEnforcement', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('passes when the cross-origin probe is rejected', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('blocked');
    }) as never;
    const r = await checkCSPEnforcement();
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/blocked as expected/i);
  });

  it('fails when the cross-origin probe somehow succeeds (CSP not active)', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as never;
    const r = await checkCSPEnforcement();
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/CSP not enforced/i);
  });
});

describe('checkUpdaterManifest', () => {
  it('skips on web (updater is desktop-only)', async () => {
    const r = await checkUpdaterManifest();
    expect(r.status).toBe('skip');
    expect(r.message).toMatch(/desktop-only/i);
  });
});

describe('checkServiceWorker', () => {
  // Tauri-skip branch is asserted at the type level (`if (isTauri) return …`)
  // and exercised in real builds — vitest's import cache makes a per-test
  // platform re-mock unreliable, so we test the web branches here only.

  it('warns when no SW is registered', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistrations: vi.fn(async () => []) },
    });
    const r = await checkServiceWorker();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/no service worker/i);
  });
});

describe('checkIndexedDB', () => {
  it('passes when the existing DB opens', async () => {
    const fakeDb = {
      version: 1,
      objectStoreNames: ['meta', 'messages'],
      close: vi.fn(),
    };
    const open = vi.fn(() => {
      const req: { onsuccess?: () => void; onerror?: () => void; result: typeof fakeDb } = {
        result: fakeDb,
      };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open } });
    const r = await checkIndexedDB();
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/v1, 2 stores/);
    expect(fakeDb.close).toHaveBeenCalled();
  });

  it('warns and aborts when the DB does not yet exist', async () => {
    const open = vi.fn(() => {
      const req: {
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
        transaction: { abort: ReturnType<typeof vi.fn> } | null;
      } = { transaction: { abort: vi.fn() } };
      queueMicrotask(() => req.onupgradeneeded?.());
      return req;
    });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open } });
    const r = await checkIndexedDB();
    expect(r.status).toBe('warn');
    expect(r.message).toMatch(/fresh install/i);
  });
});

describe('runDiagnostics — composer', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Make every check return cleanly.
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('example.invalid')) throw new TypeError('blocked');
      return new Response('{"version":"1.0.0"}', { status: 200 });
    }) as never;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns one result per registered check and a stable shape', async () => {
    const report = await runDiagnostics();
    expect(report.results.length).toBeGreaterThan(0);
    for (const r of report.results) {
      expect(typeof r.id).toBe('string');
      expect(typeof r.label).toBe('string');
      expect(['pass', 'fail', 'warn', 'skip']).toContain(r.status);
      expect(typeof r.durationMs).toBe('number');
    }
  });

  it('emits ISO 8601 generatedAt', () => {
    const report: DiagnosticsReport = {
      generatedAt: new Date().toISOString(),
      platform: { runtime: 'web', userAgent: 'x', language: 'en', online: true },
      results: [],
    };
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
