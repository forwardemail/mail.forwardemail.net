/**
 * Appended to sanitized HTML when the user blocks remote images. The reader
 * iframe (iframe-srcdoc.ts) sees it and tightens its CSP to `img-src data:`,
 * which also stops the remote loads the <img> rewrite in sanitize.js cannot
 * see: srcset, inline style url(), the legacy background attribute, video
 * posters. restoreBlockedImages removes it when the user chooses to load
 * images.
 */
export const REMOTE_IMAGES_BLOCKED_MARKER = '<!--fe-remote-images-blocked-->';
