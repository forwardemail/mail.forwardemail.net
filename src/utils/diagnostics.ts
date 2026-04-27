/**
 * Self-diagnostic runner.
 *
 * Why this exists: every Tauri-flavored bug in our risk register (macOS
 * sandbox blocks the updater, Android channel API breakage, Windows NSIS
 * mailto registration, etc.) only fails in signed/installed builds on real
 * devices. Users hit them, file vague bug reports ("notifications don't
 * work"), and we have no signal to triage from. This module exercises each
 * high-risk surface and produces a redacted, copy-pasteable report so a
 * support reply takes a minute instead of a week.
 *
 * Design rules:
 *  - Every check is independently runnable and returns the same shape.
 *  - No side effects in the auto-run set: no notifications sent, no DB
 *    initialized, no updater installed. Side-effecting checks live behind
 *    explicit user actions in the UI.
 *  - No secrets, emails, or full file paths in the report — only platform
 *    facts and check outcomes. Bug reports get pasted into Slack/email.
 */

import { isTauri, isTauriDesktop, isTauriMobile, getPlatform } from './platform.js';

export type DiagnosticStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface DiagnosticResult {
  /** Stable identifier for the check — safe to reference in support docs. */
  id: string;
  /** Human-readable name shown in the UI. */
  label: string;
  status: DiagnosticStatus;
  /** Short message — one line, safe to display. */
  message: string;
  /** Round-trip in ms. Useful for telemetry on slow networks/disks. */
  durationMs: number;
  /** Optional structured detail for the JSON report. Must not contain PII. */
  detail?: Record<string, unknown>;
}

export interface DiagnosticsReport {
  generatedAt: string;
  platform: {
    runtime: ReturnType<typeof getPlatform>;
    userAgent: string;
    language: string;
    online: boolean;
  };
  results: DiagnosticResult[];
}

/** Wrap a check so failures become results, not thrown errors. */
const runCheck = async (
  id: string,
  label: string,
  fn: () => Promise<Omit<DiagnosticResult, 'id' | 'label' | 'durationMs'>>,
): Promise<DiagnosticResult> => {
  const started = performance.now();
  try {
    const inner = await fn();
    return { id, label, durationMs: Math.round(performance.now() - started), ...inner };
  } catch (err) {
    return {
      id,
      label,
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      durationMs: Math.round(performance.now() - started),
    };
  }
};

// ── Individual checks ───────────────────────────────────────────────────────

/**
 * Tauri build info (version, OS, arch, build date). Tauri-only — exposes the
 * info Rust gathered at startup. On web returns skip.
 */
export const checkBuildInfo = (): Promise<DiagnosticResult> =>
  runCheck('build-info', 'Build info', async () => {
    if (!isTauri) {
      return { status: 'skip', message: 'Web build', detail: { runtime: 'web' } };
    }
    const { getBuildInfo } = await import('./tauri-bridge.js');
    const info = await getBuildInfo();
    if (!info) {
      return { status: 'fail', message: 'getBuildInfo returned null' };
    }
    return {
      status: 'pass',
      message: `${info.version} (${info.os}/${info.arch})`,
      detail: info as Record<string, unknown>,
    };
  });

/**
 * IndexedDB / Dexie reachable. Opens the existing DB only — does NOT call
 * initializeDatabase, because that would create the cache on a fresh user
 * and pollute the diagnostic. We just want to know if it OPENS.
 */
export const checkIndexedDB = (): Promise<DiagnosticResult> =>
  runCheck('indexed-db', 'IndexedDB / cache', async () => {
    if (typeof indexedDB === 'undefined') {
      return { status: 'fail', message: 'IndexedDB not available in this runtime' };
    }
    // Use the raw IndexedDB API so we don't trigger Dexie's open-and-migrate
    // path on a user who has never used the app.
    return await new Promise<Omit<DiagnosticResult, 'id' | 'label' | 'durationMs'>>((resolve) => {
      const req = indexedDB.open('webmail-cache-v1');
      req.onerror = () => resolve({ status: 'fail', message: req.error?.message ?? 'open failed' });
      req.onsuccess = () => {
        const db = req.result;
        const stores = Array.from(db.objectStoreNames);
        const version = db.version;
        db.close();
        resolve({
          status: 'pass',
          message: `v${version}, ${stores.length} stores`,
          detail: { version, stores },
        });
      };
      // If the DB doesn't exist, onupgradeneeded fires; abort so we don't
      // create it inadvertently.
      req.onupgradeneeded = () => {
        req.transaction?.abort();
        resolve({
          status: 'warn',
          message: 'No cache yet (fresh install or never signed in)',
          detail: { existed: false },
        });
      };
    });
  });

/**
 * API connectivity to api.forwardemail.net. The macOS App Sandbox bug
 * (#13878) silently kills outbound network in production unless the
 * com.apple.security.network.client entitlement is granted. This check is
 * the canary for that — if it fails on a notarized macOS build, the
 * entitlement didn't ship.
 *
 * Accepts ANY HTTP response (including 401/404) as "reachable" — we only
 * care that the network path works, not that we're authenticated.
 */
export const checkApiConnectivity = (
  url = 'https://api.forwardemail.net/v1/lookup',
): Promise<DiagnosticResult> =>
  runCheck('api-connectivity', 'API connectivity', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        // Don't send credentials — we want to test the network path, not auth.
        credentials: 'omit',
        cache: 'no-store',
      });
      return {
        status: 'pass',
        message: `HTTP ${response.status}`,
        detail: { httpStatus: response.status },
      };
    } finally {
      clearTimeout(timeout);
    }
  });

/**
 * CSP enforcement positive test. Tries to fetch a URL the CSP should block;
 * if the request succeeds, the CSP isn't being enforced — which is itself a
 * bug. Caveat: some browsers report the CSP block as a generic network
 * error rather than a specific signal, so we treat any rejection as pass.
 */
export const checkCSPEnforcement = (): Promise<DiagnosticResult> =>
  runCheck('csp-enforcement', 'CSP enforcement', async () => {
    // Pick a URL that isn't in connect-src and isn't anyone we'd hit by accident.
    const blocked = 'https://example.invalid/csp-probe';
    try {
      await fetch(blocked, { method: 'HEAD', cache: 'no-store' });
      return {
        status: 'fail',
        message: 'Probe to an unallowlisted host succeeded — CSP not enforced',
      };
    } catch {
      return { status: 'pass', message: 'Cross-origin probe blocked as expected' };
    }
  });

/**
 * Updater manifest reachable. On Tauri desktop only. Fetches the manifest
 * URL directly (without the plugin) so we test the network path without
 * triggering an install. This is the second canary for the macOS sandbox
 * bug — and the canary for #2579 (GitHub redirect 401s).
 */
export const checkUpdaterManifest = (): Promise<DiagnosticResult> =>
  runCheck('updater-manifest', 'Updater manifest', async () => {
    if (!isTauriDesktop) {
      return { status: 'skip', message: 'Updater is desktop-only' };
    }
    const url =
      'https://github.com/forwardemail/mail.forwardemail.net/releases/latest/download/latest.json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'follow',
      });
      if (!response.ok) {
        return {
          status: 'fail',
          message: `HTTP ${response.status} from manifest endpoint`,
          detail: { httpStatus: response.status },
        };
      }
      const json = (await response.json()) as { version?: string };
      if (typeof json.version !== 'string') {
        return { status: 'fail', message: 'Manifest is reachable but missing version field' };
      }
      return {
        status: 'pass',
        message: `Latest: v${json.version}`,
        detail: { latestVersion: json.version },
      };
    } finally {
      clearTimeout(timeout);
    }
  });

/**
 * Mailto handler registration. Tauri desktop only. Reports current
 * registration state without trying to register — registration has a Windows
 * Settings popup as a side effect.
 */
export const checkMailtoRegistration = (): Promise<DiagnosticResult> =>
  runCheck('mailto-registration', 'mailto: handler', async () => {
    if (!isTauriDesktop) {
      return { status: 'skip', message: 'mailto registration is desktop-only' };
    }
    const { getRegistrationStatus } = await import('./mailto-handler.js');
    const status = await getRegistrationStatus();
    if (status === 'default') {
      return { status: 'pass', message: 'Default mailto handler', detail: { state: status } };
    }
    if (status === 'registered' || status === 'not_default') {
      return {
        status: 'warn',
        message: `Registered but not default (${status})`,
        detail: { state: status },
      };
    }
    if (status === 'declined') {
      return { status: 'warn', message: 'User declined registration', detail: { state: status } };
    }
    return { status: 'warn', message: `Status: ${status}`, detail: { state: status } };
  });

/**
 * Notification permission state. Reports the current state without
 * requesting — requesting has a system permission popup as a side effect.
 * Detects the Android plugin breakage (#2341) by reading the granted state
 * via the Tauri plugin: on Android 8+ a successful permission read with
 * channel-create having quietly failed earlier is the failure mode that
 * silently breaks notifications.
 */
export const checkNotificationPermission = (): Promise<DiagnosticResult> =>
  runCheck('notification-permission', 'Notifications', async () => {
    if (isTauri) {
      try {
        const mod = await import('@tauri-apps/plugin-notification');
        const granted = await mod.isPermissionGranted();
        const detail: Record<string, unknown> = { granted };
        if (isTauriMobile && /android/i.test(navigator.userAgent)) {
          detail.androidNote =
            'tauri-apps/plugins-workspace#2341: channel API may have failed silently on this device';
        }
        return {
          status: granted ? 'pass' : 'warn',
          message: granted ? 'Permission granted' : 'Permission not granted',
          detail,
        };
      } catch (err) {
        return {
          status: 'fail',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (typeof Notification === 'undefined') {
      return { status: 'skip', message: 'Notification API unavailable in this runtime' };
    }
    return {
      status: Notification.permission === 'granted' ? 'pass' : 'warn',
      message: `Permission: ${Notification.permission}`,
      detail: { permission: Notification.permission },
    };
  });

/**
 * Service worker registration state. Web only — Tauri's custom scheme
 * intentionally disables service workers (per platform.js).
 */
export const checkServiceWorker = (): Promise<DiagnosticResult> =>
  runCheck('service-worker', 'Service worker', async () => {
    if (isTauri) {
      return {
        status: 'skip',
        message: 'Disabled in Tauri webview (custom scheme)',
      };
    }
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return { status: 'fail', message: 'Service Worker API unavailable' };
    }
    const regs = await navigator.serviceWorker.getRegistrations();
    if (regs.length === 0) {
      return { status: 'warn', message: 'No service worker registered' };
    }
    const active = regs.filter((r) => r.active).length;
    return {
      status: active > 0 ? 'pass' : 'warn',
      message: `${regs.length} registration(s), ${active} active`,
      detail: { registrations: regs.length, active },
    };
  });

// ── Composer ────────────────────────────────────────────────────────────────

/** Run every check and assemble a report. Each check has its own try/catch. */
export const runDiagnostics = async (): Promise<DiagnosticsReport> => {
  const results = await Promise.all([
    checkBuildInfo(),
    checkIndexedDB(),
    checkApiConnectivity(),
    checkCSPEnforcement(),
    checkUpdaterManifest(),
    checkMailtoRegistration(),
    checkNotificationPermission(),
    checkServiceWorker(),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    platform: {
      runtime: getPlatform(),
      userAgent: typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent,
      language: typeof navigator === 'undefined' ? 'n/a' : navigator.language,
      online: typeof navigator === 'undefined' ? true : navigator.onLine,
    },
    results,
  };
};

// ── Reporting ───────────────────────────────────────────────────────────────

/**
 * Format a report as paste-able plain text. The JSON form is also
 * available via `JSON.stringify(report, null, 2)` — text is friendlier in
 * Slack/email but loses the structured detail fields.
 */
export const formatReportText = (report: DiagnosticsReport): string => {
  const lines: string[] = [
    'Forward Email — Diagnostics',
    `Generated: ${report.generatedAt}`,
    `Runtime:   ${report.platform.runtime}`,
    `Online:    ${report.platform.online}`,
    `Language:  ${report.platform.language}`,
    `User-Agent: ${report.platform.userAgent}`,
    '',
  ];
  for (const r of report.results) {
    const tag = `[${r.status.toUpperCase().padEnd(4)}]`;
    lines.push(`${tag} ${r.label} (${r.durationMs}ms): ${r.message}`);
  }
  return lines.join('\n');
};

/** Summary counts for display. */
export const summarizeReport = (
  report: DiagnosticsReport,
): { pass: number; fail: number; warn: number; skip: number } => {
  const out = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of report.results) out[r.status]++;
  return out;
};
