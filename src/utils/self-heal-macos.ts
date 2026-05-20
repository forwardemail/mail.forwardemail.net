/**
 * Self-heal entry point for macOS users upgrading from broken 0.10.17 –
 * 0.10.21 bundles.
 *
 * The aps-environment entitlement in those releases caused macOS to reject
 * the signed bundle at exec time. Users who downloaded one of the broken
 * DMGs left a now-cached `Forward Email.app` in `~/Downloads/`, which
 * LaunchServices registered for the bundle identifier and continues
 * routing launches at even after the working 0.10.22 build is installed
 * into `/Applications/`.
 *
 * On first launch of a working build (gated by isTauriDesktop + macOS UA
 * + a localStorage dismissal flag) we:
 *   1. Tell LaunchServices to forget cached path bindings.
 *   2. Look for stale `Forward Email.app` bundles in user-writable
 *      directories.
 *   3. If any are found, show a native confirm dialog naming each path.
 *   4. On accept, move them to the Trash via Finder (recoverable).
 *
 * All work is best-effort — failures log a warning and bail. See
 * docs/desktop-postmortem-macos-entitlements-2026-05-19.md for context.
 */

import { isTauriDesktop } from './platform.js';

const DISMISSED_KEY = 'fe:self-heal-dismissed-paths';

function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac/i.test(navigator.platform || '');
}

function readDismissed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function writeDismissed(paths: Iterable<string>): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...paths]));
  } catch {
    // localStorage unavailable in some embedded contexts — non-fatal.
  }
}

export async function runMacOSSelfHeal(): Promise<void> {
  if (!isTauriDesktop || !isMacOS()) return;

  let invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    return;
  }

  // Step 1: refresh LaunchServices unconditionally. Non-destructive,
  // takes <1s, makes the OS forget stale path bindings.
  try {
    await invoke('self_heal_flush_launch_services');
  } catch (err) {
    console.warn('[self-heal] lsregister flush failed:', err);
  }

  // Step 2: scan for stale bundles.
  let stale: string[] = [];
  try {
    stale = await invoke<string[]>('self_heal_detect_stale_bundles');
  } catch (err) {
    console.warn('[self-heal] detection failed:', err);
    return;
  }
  if (!Array.isArray(stale) || stale.length === 0) return;

  // Step 3: filter out paths the user has previously declined for.
  const dismissed = readDismissed();
  const toPrompt = stale.filter((p) => !dismissed.has(p));
  if (toPrompt.length === 0) return;

  // Step 4: native confirm. window.confirm in WKWebView renders as an
  // NSAlert — no Tauri capability needed and it surfaces above the app
  // window without us building a Svelte modal just for this.
  const list = toPrompt.map((p) => `• ${p}`).join('\n');
  const proceed = window.confirm(
    `Forward Email was upgraded.\n\n` +
      `We found ${toPrompt.length} older cop${toPrompt.length === 1 ? 'y' : 'ies'} ` +
      `of the app on disk that may prevent macOS from launching the new version:\n\n` +
      `${list}\n\n` +
      `Move ${toPrompt.length === 1 ? 'it' : 'them'} to Trash? You can restore from Trash if needed.`,
  );

  if (!proceed) {
    // Remember the user's "no" so we don't keep nagging on every launch.
    writeDismissed([...dismissed, ...toPrompt]);
    return;
  }

  try {
    const moved = await invoke<number>('self_heal_cleanup_stale_bundles', {
      paths: toPrompt,
    });
    console.log(`[self-heal] moved ${moved} stale bundle(s) to Trash`);
  } catch (err) {
    console.warn('[self-heal] cleanup failed:', err);
  }
}
