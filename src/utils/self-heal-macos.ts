/**
 * Self-heal entry point for macOS users upgrading from broken 0.10.17 –
 * 0.10.21 bundles.
 *
 * The aps-environment entitlement in those releases caused macOS to reject
 * the signed bundle at exec time. Users who downloaded one of the broken
 * DMGs left a now-cached `Forward Email.app` in `~/Downloads/`, which
 * LaunchServices registered for the bundle identifier and continues
 * routing launches at even after the working build is installed into
 * `/Applications/`.
 *
 * On the first launch of each app version (gated by isTauriDesktop + macOS)
 * we tell LaunchServices to forget cached path bindings via
 * `lsregister -kill -r`. That's non-destructive and fixes the stale
 * launch-routing, but re-registers every app on disk and can take seconds,
 * so it is not repeated on every launch.
 *
 * NOTE: this used to also scan ~/Downloads, ~/Desktop and ~/Documents for
 * stray app copies and offer to Trash them. After the App Sandbox was
 * removed (file-picker fix), those directory reads stopped being silently
 * denied and instead tripped macOS TCC, prompting EVERY user — fresh
 * installs included — for Downloads/Desktop/Documents access on first
 * launch. The scan was dropped 2026-06-02; the flush below is all that
 * remains. See docs/desktop-postmortem-macos-sandbox-filepicker-2026-06-02.md
 * and docs/desktop-postmortem-macos-entitlements-2026-05-19.md.
 */

import { isTauriDesktop } from './platform.js';
import { Local } from './storage.js';

// The app version the flush last ran for.
const FLUSHED_VERSION_KEY = 'macos_self_heal_version';

function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac/i.test(navigator.platform || '');
}

export async function runMacOSSelfHeal(): Promise<void> {
  if (!isTauriDesktop || !isMacOS()) return;

  // Once per installed version: installing a working build is what leaves the
  // stale binding behind, and its first launch clears it. Marked before the
  // call so a second bootstrap (account switch, unlock) does not repeat it.
  const version = String(import.meta.env.VITE_PKG_VERSION || '');
  if (Local.get(FLUSHED_VERSION_KEY) === version) return;
  Local.set(FLUSHED_VERSION_KEY, version);

  let invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    return;
  }

  // Refresh LaunchServices unconditionally. Non-destructive, makes the OS
  // forget stale path bindings, and touches no TCC-protected folders.
  try {
    await invoke('self_heal_flush_launch_services');
  } catch (err) {
    console.warn('[self-heal] lsregister flush failed:', err);
  }
}
