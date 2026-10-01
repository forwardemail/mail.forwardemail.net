/**
 * What a browser does when a link is clicked, for the links the app leaves
 * to the browser: downloads and links to other sites.
 *
 * The webmail saves files (attachments, vCards, calendars, exported mail)
 * by clicking an `<a download>` whose href is a blob: or data: URL. Here the
 * file is written to the Downloads folder and a toast says where. A plain
 * link to another site opens in the system browser. Links within the app
 * are the app's router's business and are left alone.
 */
import { resolveObjectURL } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openInBrowser } from './open-url';
import type { AnyRecord } from './types';

/** ~/Downloads when it exists, else the home directory; FORWARDEMAIL_DOWNLOADS overrides. */
export function getDownloadsDir(): string {
  if (process.env.FORWARDEMAIL_DOWNLOADS) return process.env.FORWARDEMAIL_DOWNLOADS;
  const downloads = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(downloads) ? downloads : os.homedir();
}

/** A file name that stays inside the target directory on every system. */
export function safeFileName(name: unknown): string {
  const base = String(name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 200);
  return base || 'download';
}

/** Writes `data` to `dir/name`, adding " (1)", " (2)"… instead of overwriting. */
export function writeUnique(dir: string, name: string, data: Uint8Array): string {
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const file = path.join(dir, i === 0 ? name : `${stem} (${i})${ext}`);
    try {
      fs.writeFileSync(file, data, { flag: 'wx' });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || i > 999) throw error;
    }
  }
}

// The bytes behind a download link. A blob: URL is resolved right away,
// since the app revokes it as soon as click() returns.
function readLink(href: string): (() => Promise<Uint8Array>) | null {
  if (href.startsWith('blob:')) {
    const blob = resolveObjectURL(href);
    return blob ? async () => new Uint8Array(await blob.arrayBuffer()) : null;
  }
  if (/^(data|https?):/i.test(href)) {
    return async () => {
      const response = await fetch(href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    };
  }
  return null;
}

export function installLinks(win: AnyRecord, downloadsDir: () => string = getDownloadsDir) {
  const toast = (message: string, type: string) =>
    win.dispatchEvent(new win.CustomEvent('fe:mail-service-toast', { detail: { message, type } }));

  const save = async (read: () => Promise<Uint8Array>, name: string) => {
    try {
      const file = writeUnique(downloadsDir(), safeFileName(name), await read());
      toast(`Saved to ${file}`, 'success');
    } catch (error) {
      console.warn('[download] failed:', error);
      toast(`Could not save ${safeFileName(name)}: ${(error as Error).message}`, 'error');
    }
  };

  win.addEventListener('click', (event: AnyRecord) => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor || (typeof event.button === 'number' && event.button !== 0)) return;
    const href = String(anchor.getAttribute('href'));

    if (anchor.hasAttribute('download')) {
      if (event.defaultPrevented) return;
      const url = new URL(href, win.location.href).href;
      const read = readLink(url);
      if (!read) return;
      event.preventDefault();
      const name = anchor.getAttribute('download') || url.split(/[?#]/)[0].split('/').pop();
      void save(read, name);
      return;
    }

    let url: URL;
    try {
      url = new URL(href, win.location.href);
    } catch {
      return;
    }
    if (url.origin === win.location.origin || !/^https?:$/.test(url.protocol)) return;
    // Listeners the app adds to window run after this one; give them the
    // chance to handle the click first, as a browser's default action would.
    queueMicrotask(() => {
      if (!event.defaultPrevented) openInBrowser(url.href);
    });
  });
}
