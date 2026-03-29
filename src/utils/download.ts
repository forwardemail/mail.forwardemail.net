/**
 * Forward Email – Cross-platform Download Utility
 *
 * Handles file downloads on both web (blob URL + anchor click) and
 * Tauri desktop (native save dialog + writeFile plugin).
 */

import { isTauri } from './platform.js';

/**
 * Download content as a file.
 *
 * @param content - String or binary data to download
 * @param filename - Suggested filename
 * @param mime - MIME type (default: 'text/plain')
 * @returns true if the download was initiated
 */
export function downloadFile(
  content: string | ArrayBuffer | Uint8Array,
  filename: string,
  mime: string = 'text/plain',
): boolean {
  if (isTauri) {
    downloadFileTauri(content, filename).catch((err) =>
      console.warn('[downloadFile] Tauri save failed:', err),
    );
    return true;
  }

  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    return true;
  } catch (err) {
    console.error('[downloadFile] failed:', err);
    return false;
  }
}

async function downloadFileTauri(
  content: string | ArrayBuffer | Uint8Array,
  filename: string,
): Promise<void> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeFile } = await import('@tauri-apps/plugin-fs');

  const filePath = await save({ defaultPath: filename });
  if (!filePath) return;

  const data =
    typeof content === 'string' ? new TextEncoder().encode(content) : new Uint8Array(content);
  await writeFile(filePath, data);
}
