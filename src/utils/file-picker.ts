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

  const { open } = await import('@tauri-apps/plugin-dialog');
  const { readFile } = await import('@tauri-apps/plugin-fs');

  const filters = buildFilters(accept);

  const selected = await open({ multiple, filters });
  if (!selected) return null;

  const paths = Array.isArray(selected) ? selected : [selected];

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
