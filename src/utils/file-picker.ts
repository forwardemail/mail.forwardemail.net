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

import { isTauriDesktop } from './platform.js';

// macOS 26 (Tahoe) crashes the bundled tauri-plugin-dialog file picker:
// rfd 0.16's NSOpenPanel binding is non-nullable, but +openPanel started
// returning nil on Tahoe and the objc2 retain assertion panics → SIGABRT.
// Detect macOS and route through our custom Rust command instead, which
// uses msg_send! with a nullable return type and an alloc/init fallback.
const isMacOS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || '');

export const isMacOSPlatform = isMacOS;

/**
 * Whether this Mac is Apple Silicon (aarch64). The WKWebView UA is frozen at
 * "10_15_7", so the real arch comes from plugin-os.
 *
 * This is the axis that matters for the file picker: the bundled plugin dialog's
 * rfd path SIGABRTs on the NSOpenPanel nil-return ONLY on Apple Silicon. On
 * Intel (x86_64) the plugin is unaffected and is the path that actually works
 * (it's what worked before our custom command existed) — and our custom command
 * `pick_files_macos` instead returns nil there (seen on Intel Sonoma 14.7.3 AND
 * Intel Tahoe) and its `app.activate()` blanks the compose window. So: use the
 * plugin on Intel, and reserve the custom command for Apple Silicon, where it
 * trades the SIGABRT for a graceful nil. On detection failure, assume Apple
 * Silicon — the safer default (never risk the rfd SIGABRT).
 */
async function isAppleSilicon(): Promise<boolean> {
  try {
    const { arch } = await import('@tauri-apps/plugin-os');
    return arch() === 'aarch64';
  } catch {
    return true;
  }
}

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
  if (isMacOS && (await isAppleSilicon())) {
    // Apple Silicon only: the plugin's rfd path SIGABRTs on the NSOpenPanel
    // nil-return, so go through our nullable custom command. It may itself
    // return nil (no panel constructible) — surface a typed error the caller
    // handles instead of letting the raw native string become an unhandled
    // rejection.
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
    // Intel macOS + every other desktop platform: the bundled plugin dialog is
    // the working, crash-free path. On Intel this is what worked before the
    // custom command was introduced — the custom command returns nil there and
    // its app.activate() blanks the compose window, so we deliberately don't
    // call it on Intel.
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
