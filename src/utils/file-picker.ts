/**
 * Forward Email – Cross-platform File Picker
 *
 * On Tauri desktop, <input type="file"> triggers WebKit's runOpenPanel
 * which crashes the app (Tauri's WKWebView delegate panics → abort).
 * This utility uses Tauri's native dialog.open() API instead, returning
 * standard File objects so existing handlers work without changes.
 *
 * On web, returns null to let the caller fall through to normal
 * <input type="file"> behavior.
 */

import { isTauriDesktop, nativePlatform } from './platform.js';

// The bundled tauri-plugin-dialog file picker uses rfd 0.16, whose
// NSOpenPanel/NSSavePanel bindings are NON-nullable: rfd calls
// `+[NSOpenPanel openPanel]` and asserts the result is non-nil, so the
// instant macOS hands back nil, objc2's retain assertion panics → SIGABRT
// (the whole app aborts, taking any open compose draft with it).
//
// `+openPanel` returning nil is NOT tied to one arch or OS version. We have
// confirmed the identical rfd → NSOpenPanel → none_fail SIGABRT on both
// Apple Silicon Tahoe AND Intel Sonoma 14.7.3 (0.11.6 crash report). The
// 2026-06-02 fix (removing the app-sandbox entitlement) eliminated the most
// common nil cause but not all of them — that Intel Sonoma report had the
// sandbox already gone, and its kernel triage showed the OS failing a VM
// allocation under memory pressure while constructing the panel. The OS can
// return nil for reasons we don't control, and the non-nullable plugin path
// SIGABRTs every single time it does.
//
// So on macOS we NEVER use the plugin's open/save panel. We route through our
// own `pick_files_macos` / `save_file_macos` commands (file_picker_macos.rs,
// download.ts), which build the panel with a nullable `msg_send!` and degrade
// to a graceful error instead of aborting when the OS returns nil. Non-macOS
// desktop keeps the plugin — rfd's nil-panic is macOS-specific.
//
// Only real macOS qualifies. The old navigator.platform test also matched
// "iPhone"/"iPad" (and iPadOS reports "MacIntel"), which sent every iOS
// attachment download to the macOS-only `save_file_macos` command. That
// command is not registered on iOS, so saving an attachment always failed
// there. Inside Tauri the OS plugin's platform is authoritative.
const isMacOS = nativePlatform
  ? nativePlatform === 'macos'
  : typeof navigator !== 'undefined' &&
    /Mac/i.test(navigator.platform || '') &&
    !(typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1);

export const isMacOSPlatform = isMacOS;

/**
 * Pick files using Tauri's native dialog on desktop.
 * Returns File[] on success, null if cancelled or not on Tauri desktop.
 */
export async function pickFiles({
  accept,
  multiple = false,
}: {
  accept?: string;
  multiple?: boolean;
} = {}): Promise<File[] | null> {
  if (!isTauriDesktop) return null;

  const { readFile } = await import('@tauri-apps/plugin-fs');

  let paths: string[];
  if (isMacOS) {
    // All macOS: go through our nullable custom command so a nil panel from the
    // OS becomes a graceful, typed error instead of the plugin's rfd SIGABRT.
    // This mirrors the save path in download.ts. The custom command does not
    // apply native type filters (`accept`); callers validate selected files.
    const { invoke } = await import('@tauri-apps/api/core');
    try {
      const result = await invoke<string[]>('pick_files_macos', { multiple });
      if (!result || result.length === 0) return null;
      paths = result;
    } catch (err) {
      const e = new Error('The macOS file picker is unavailable on this system.');
      (e as Error & { code?: string }).code = 'FILE_PICKER_UNAVAILABLE';
      (e as Error & { cause?: unknown }).cause = err;
      throw e;
    }
  } else {
    // Non-macOS desktop (Windows/Linux): the bundled plugin dialog is the
    // working, crash-free path — rfd's NSOpenPanel nil-panic is macOS-specific.
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ multiple, filters: buildFilters(accept) });
    if (!selected) return null;
    paths = Array.isArray(selected) ? selected : [selected];
  }

  const files = await Promise.all(
    paths.map(async (filePath) => {
      const bytes = await readFile(filePath);
      const name = filePath.replace(/^.*[\\/]/, '');
      return new File([bytes], name, { type: mimeFromName(name) });
    }),
  );

  return files;
}

function buildFilters(accept?: string) {
  if (!accept) return [];
  const extensions: string[] = [];
  for (const part of accept.split(',')) {
    const t = part.trim();
    if (t.startsWith('.')) {
      extensions.push(t.slice(1));
    } else if (t === 'image/*') {
      extensions.push('png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico');
    } else if (t === 'text/vcard') {
      extensions.push('vcf');
    } else if (t === 'text/calendar') {
      extensions.push('ics');
    }
  }
  return extensions.length ? [{ name: 'Files', extensions }] : [];
}

function mimeFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    vcf: 'text/vcard',
    ics: 'text/calendar',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    pdf: 'application/pdf',
    txt: 'text/plain',
  };
  return (ext && map[ext]) || 'application/octet-stream';
}
