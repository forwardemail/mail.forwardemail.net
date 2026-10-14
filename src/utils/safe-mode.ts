/**
 * Logic for the troubleshooting page (safe-mode.html, entry src/safe-mode.ts).
 * That page loads none of the app, so everything here must stay light: no
 * stores, no Dexie, no workers.
 */
import {
  checkApiConnectivity,
  checkBuildInfo,
  checkIndexedDB,
  checkRendererWatchdog,
  collectPlatform,
  formatReportText,
} from './diagnostics';

/** How much of the native log goes into the copied report. */
export const SAFE_MODE_LOG_BYTES = 32 * 1024;

/** The intro shown when the page opened itself, or null for the default one. */
export const reasonText = (reason: string | null): string | null => {
  if (reason !== 'watchdog') return null;
  return (
    'Forward Email stopped working twice, a few seconds after opening, so this page opened ' +
    'instead of starting it again. Your mail is stored on the server and is not affected.'
  );
};

/**
 * The theme the app last used, from the same key index.html reads before
 * boot. Null means follow the system, which the stylesheet already does.
 */
export const storedTheme = (storage: Pick<Storage, 'getItem'>): 'dark' | 'light' | null => {
  try {
    const value = storage.getItem('webmail_theme') || '';
    if (value.includes('dark')) return 'dark';
    if (value.includes('light')) return 'light';
  } catch {
    // Storage blocked: follow the system.
  }
  return null;
};

/**
 * Signed-in account count, read without the storage module (which opens the
 * database). Null when the list cannot be read, as when App Lock encrypts it.
 */
export const countAccounts = (storage: Pick<Storage, 'getItem'>): number | null => {
  try {
    const raw = storage.getItem('webmail_accounts');
    if (!raw) return 0;
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.length : null;
  } catch {
    return null;
  }
};

/**
 * The text "Copy diagnostics" puts on the clipboard: the checks that make
 * sense without the app running, the account count and the log tail.
 */
export const buildSafeModeReport = async ({
  reason,
  accounts,
  readLogs,
}: {
  reason: string | null;
  accounts: number | null;
  readLogs: (maxBytes: number) => Promise<string>;
}): Promise<string> => {
  const [results, log] = await Promise.all([
    Promise.all([
      checkBuildInfo(),
      checkIndexedDB(),
      checkApiConnectivity(),
      checkRendererWatchdog(),
    ]),
    readLogs(SAFE_MODE_LOG_BYTES).catch((err) => `(could not read the log: ${String(err)})`),
  ]);
  const report = formatReportText({
    generatedAt: new Date().toISOString(),
    platform: collectPlatform(),
    results,
  });
  return [
    report,
    `Opened by: ${reason === 'watchdog' ? 'renderer watchdog' : 'Help menu'}`,
    `Accounts:  ${accounts ?? 'unknown (list is encrypted)'}`,
    '',
    'Recent log:',
    log.trim() || '(empty)',
  ].join('\n');
};
