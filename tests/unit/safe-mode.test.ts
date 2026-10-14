import 'fake-indexeddb/auto';

vi.mock('../../src/utils/diagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/diagnostics')>();
  const result = (id: string, label: string, message: string) => async () => ({
    id,
    label,
    status: 'warn' as const,
    message,
    durationMs: 1,
  });
  return {
    ...actual,
    checkBuildInfo: result('build-info', 'Build info', '0.14.31 (macos/aarch64)'),
    checkIndexedDB: result('indexed-db', 'IndexedDB / cache', 'v20, 13 stores'),
    checkApiConnectivity: result('api-connectivity', 'API connectivity', 'HTTP 401'),
    checkRendererWatchdog: result(
      'renderer-watchdog',
      'Renderer watchdog',
      'Renderer reloaded 2 times this session, troubleshooting page opened 1 time',
    ),
  };
});

import { clearSiteData } from '../../src/utils/clear-manifest';
import {
  buildSafeModeReport,
  countAccounts,
  reasonText,
  storedTheme,
} from '../../src/utils/safe-mode';

const storageWith = (values: Record<string, string>) => ({
  getItem: (key: string) => values[key] ?? null,
});

describe('reasonText', () => {
  it('explains a watchdog redirect and keeps the default intro otherwise', () => {
    expect(reasonText('watchdog')).toMatch(/stopped working twice/);
    expect(reasonText('menu')).toBeNull();
    expect(reasonText(null)).toBeNull();
  });
});

describe('storedTheme', () => {
  it('reads the theme key index.html uses, and follows the system otherwise', () => {
    expect(storedTheme(storageWith({ webmail_theme: 'dark' }))).toBe('dark');
    expect(storedTheme(storageWith({ webmail_theme: 'light' }))).toBe('light');
    expect(storedTheme(storageWith({ webmail_theme: 'system' }))).toBeNull();
    expect(storedTheme(storageWith({}))).toBeNull();
    const blocked = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    };
    expect(storedTheme(blocked)).toBeNull();
  });
});

describe('countAccounts', () => {
  it('counts the stored list, and reports unknown when App Lock encrypted it', () => {
    const two = JSON.stringify([{ email: 'a@example.com' }, { email: 'b@example.com' }]);
    expect(countAccounts(storageWith({ webmail_accounts: two }))).toBe(2);
    expect(countAccounts(storageWith({}))).toBe(0);
    expect(countAccounts(storageWith({ webmail_accounts: 'enc:v1:abc' }))).toBeNull();
  });
});

describe('buildSafeModeReport', () => {
  it('puts the checks, how it opened, the account count and the log tail in one text', async () => {
    const readLogs = vi.fn(async () => '[watchdog] main webview stopped again\n');
    const text = await buildSafeModeReport({ reason: 'watchdog', accounts: 2, readLogs });

    expect(text).toContain('Forward Email Diagnostics');
    expect(text).toContain('[WARN] Renderer watchdog (1ms): Renderer reloaded 2 times');
    expect(text).toContain('Opened by: renderer watchdog');
    expect(text).toContain('Accounts:  2');
    expect(text.trimEnd().endsWith('[watchdog] main webview stopped again')).toBe(true);
    expect(readLogs).toHaveBeenCalledWith(32 * 1024);
  });

  it('still produces a report when the log cannot be read', async () => {
    const text = await buildSafeModeReport({
      reason: 'menu',
      accounts: null,
      readLogs: async () => {
        throw new Error('no log dir');
      },
    });
    expect(text).toContain('Opened by: Help menu');
    expect(text).toContain('Accounts:  unknown (list is encrypted)');
    expect(text).toContain('(could not read the log: Error: no log dir)');
  });
});

describe('clearSiteData', () => {
  it('has deleted the mail database by the time it resolves', async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('webmail-cache-v1-test', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('messages');
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    localStorage.setItem('webmail_accounts', '[]');

    await clearSiteData();

    const names = (await indexedDB.databases()).map((db) => db.name);
    expect(names).not.toContain('webmail-cache-v1-test');
    expect(localStorage.getItem('webmail_accounts')).toBeNull();
  });
});
