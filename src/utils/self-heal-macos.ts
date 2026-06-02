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
 * On launch (gated by isTauriDesktop + macOS) we tell LaunchServices to
 * forget cached path bindings via `lsregister -kill -r`. That's
 * non-destructive, takes <1s, and fixes the stale launch-routing.
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

function isMacOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac/i.test(navigator.platform || '');
}

export async function runMacOSSelfHeal(): Promise<void> {
  if (!isTauriDesktop || !isMacOS()) return;

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
