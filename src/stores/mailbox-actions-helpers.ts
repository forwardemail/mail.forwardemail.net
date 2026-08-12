// Pure seams extracted from mailboxActions.ts so they can be unit-tested without
// loading the store graph (mailboxActions imports Remote/db/Local/stores at
// module load). This first slice is the "View Original / Download .eml" cluster:
// header extraction + the standalone HTML viewer page. They have no
// Remote/db/Local/store dependencies — only the DARK_SURFACE token map.
//
// Security-relevant bits pinned by tests/unit/mailbox-actions-helpers.test.ts:
// the `</`-sequence escape that stops embedded message data from breaking out of
// the <script> tag, and the subject `<`/`>` escaping in the page <h1>.
import { DARK_SURFACE } from '../utils/dark-surface';

/**
 * Sanitize a subject into a safe download filename. Keeps alphanumerics plus
 * `-_.`; everything else collapses to `_`.
 *
 * NB the character class is `[^a-z0-9_.-]`, NOT the original `[^a-z0-9\\-_.]`:
 * in the latter the `\\-_` is parsed as the RANGE `\`–`_`, which (a) excluded
 * the literal hyphen the author meant to keep and (b) let `\`, `]`, `^` through
 * — backslash in particular is unwanted in a download filename. Fixed during the
 * extraction; pinned by tests/unit/mailbox-actions-helpers.test.ts.
 */
export const getSafeFilename = (subject = '', suffix = 'eml'): string => {
  const base = subject?.trim() || 'message';
  return `${base.replace(/[^a-z0-9_.-]+/gi, '_') || 'message'}.${suffix}`;
};

/** The header block of a raw RFC822 message — everything before the blank line. */
export const extractHeaders = (raw = ''): string => {
  if (!raw) return '';
  const normalized = raw.replace(/\r\n/g, '\n');
  const dividerIndex = normalized.indexOf('\n\n');
  return dividerIndex === -1 ? normalized.trim() : normalized.slice(0, dividerIndex).trim();
};

/** Cheap heuristic for whether a payload is already HTML (vs. raw source). */
export const looksLikeHtml = (raw = ''): boolean =>
  /<html[\s>]/i.test(raw) || /<body[\s>]/i.test(raw);

/**
 * Coerce the various header shapes the API/cache return (string, string[],
 * header object) into a single header text block, falling back to parsing the
 * header block out of the raw source.
 */
export const normalizeHeaders = (rawHeaders: unknown, fallbackRaw = ''): string => {
  if (typeof rawHeaders === 'string') return rawHeaders.trim();
  if (Array.isArray(rawHeaders)) return rawHeaders.join('\n').trim();
  if (rawHeaders && typeof rawHeaders === 'object') {
    return Object.entries(rawHeaders as Record<string, unknown>)
      .map(([key, value]) =>
        Array.isArray(value) ? `${key}: ${value.join(', ')}` : `${key}: ${String(value)}`,
      )
      .join('\n')
      .trim();
  }
  const extracted = extractHeaders(fallbackRaw);
  if (extracted && /^[\w-]+\s*:/m.test(extracted)) return extracted;
  return '';
};

export interface OriginalViewerOptions {
  raw?: string;
  headers?: string;
  subject?: string;
  decrypted?: string;
  isLightMode?: boolean;
}

/**
 * Build the standalone "Original message" viewer HTML page (headers + raw
 * source + optional decrypted body, with copy/download buttons). Returned as a
 * self-contained document loaded into a blob/iframe.
 */
export const buildOriginalViewerPage = ({
  raw = '',
  headers = '',
  subject = '',
  decrypted = '',
  isLightMode = true,
}: OriginalViewerOptions = {}): string => {
  const filename = getSafeFilename(subject, 'eml');
  // Neutral dark surfaces mirroring tokens.css (.dark) — see dark-surface.ts.
  // Elevation preserved: page (surface) < header (panel) < buttons (overlay),
  // with the raw <pre> inset to the deepest base.
  const darkModeStyles = !isLightMode
    ? `
    body { background: ${DARK_SURFACE.surface}; color: ${DARK_SURFACE.text}; }
    header { background: ${DARK_SURFACE.panel}; border-bottom: 1px solid rgba(255,255,255,0.05); }
    button { background: ${DARK_SURFACE.overlay}; color: ${DARK_SURFACE.text}; border: 1px solid rgba(255,255,255,0.08); }
    button:hover { background: ${DARK_SURFACE.borderStrong}; }
    .label { color: ${DARK_SURFACE.textMuted}; }
    pre { background: ${DARK_SURFACE.base}; border: 1px solid rgba(255,255,255,0.05); }
    .toast { background: ${DARK_SURFACE.overlay}; border: 1px solid rgba(255,255,255,0.1); color: ${DARK_SURFACE.text}; }
  `
    : '';

  // Create script content as a separate blob to avoid CSP inline script issues
  const scriptContent = `
    const DATA = ${JSON.stringify({ raw, headers, decrypted, filename })};

    const headersEl = document.getElementById('headers');
    const rawEl = document.getElementById('raw');
    const decBlock = document.getElementById('decryptedBlock');
    const decFrame = document.getElementById('decryptedFrame');
    const decPre = document.getElementById('decryptedPre');
    // Extract headers from raw source if not provided separately
    const rawText = DATA.raw || '';
    let displayHeaders = DATA.headers || '';
    if (!displayHeaders && rawText) {
      const divider = rawText.indexOf('\\n\\n');
      if (divider > 0) displayHeaders = rawText.slice(0, divider).trim();
    }
    headersEl.textContent = displayHeaders || 'No headers available';
    rawEl.textContent = rawText || 'No original content available';

    // Show decrypted body if available (rendered HTML in sandboxed iframe, or plain text in pre)
    if (DATA.decrypted) {
      decBlock.style.display = 'block';
      const isHtml = /<[a-z][\\s\\S]*>/i.test(DATA.decrypted);
      if (isHtml) {
        decFrame.style.display = 'block';
        decFrame.srcdoc = DATA.decrypted;
        decFrame.onload = () => {
          try {
            const h = decFrame.contentDocument.documentElement.scrollHeight;
            decFrame.style.height = Math.min(h + 20, 600) + 'px';
          } catch(e) {}
        };
      } else {
        decPre.style.display = 'block';
        decPre.textContent = DATA.decrypted;
      }
    }

    const showToast = (message) => {
      const toast = document.createElement('div');
      toast.className = 'toast';
      toast.textContent = message;
      document.body.appendChild(toast);
      setTimeout(() => {
        toast.remove();
      }, 2000);
    };

    const copyText = async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (err) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(textarea);
        return ok;
      }
    };

    document.getElementById('copyHeaders').onclick = async () => {
      const success = await copyText(displayHeaders || '');
      showToast(success ? 'Headers copied to clipboard' : 'Failed to copy headers');
    };
    document.getElementById('copyRaw').onclick = async () => {
      const success = await copyText(DATA.raw || '');
      showToast(success ? 'Raw message copied to clipboard' : 'Failed to copy message');
    };
    document.getElementById('download').onclick = () => {
      const blob = new Blob([DATA.raw], { type: 'message/rfc822' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = DATA.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
  `;

  // Escape </ sequences so embedded data can't break out of the script tag
  const safeScriptContent = scriptContent.replace(/<\//g, '<\\/');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Original message</title>
  <style>
    /* Base styles (light mode) */
    body { font-family: system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #ffffff; color: #1f2937; }
    header { padding: 14px 16px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; display:flex; gap:10px; flex-wrap: wrap; align-items: center; }
    h1 { font-size: 16px; margin: 0; font-weight: 600; flex: 1; }
    button { background: #ffffff; color: #1f2937; border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button:hover { background: #f3f4f6; }
    .section { padding: 14px 16px; }
    .label { font-size: 12px; color: #6b7280; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.04em; }
    pre { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; overflow: auto; max-height: 45vh; white-space: pre-wrap; word-break: break-word; }
    .grid { display: grid; gap: 12px; }
    .toast { background: #ffffff; border: 1px solid #e5e7eb; color: #1f2937; }


    /* Dark mode override */
    ${darkModeStyles}

    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      border-radius: 8px;
      padding: 12px 16px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 1000;
      animation: slideIn 0.2s ease-out;
      font-size: 14px;
    }
    @keyframes slideIn {
      from { transform: translateY(100%); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${subject ? subject.replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Original message'}</h1>
    <button id="download">Download .eml</button>
    <button id="copyRaw">Copy raw message</button>
  </header>
  <div class="section grid">
    <div>
      <div class="label">Headers</div>
      <button id="copyHeaders" style="margin-bottom:8px;">Copy headers</button>
      <pre id="headers"></pre>
    </div>
    <div>
      <div class="label">Raw source</div>
      <pre id="raw"></pre>
    </div>
    <div id="decryptedBlock" style="display:none;">
      <div class="label">Decrypted body</div>
      <iframe id="decryptedFrame" sandbox="allow-same-origin" style="display:none; width:100%; border:1px solid #e5e7eb; border-radius:8px; min-height:100px;"></iframe>
      <pre id="decryptedPre" style="display:none;"></pre>
    </div>
  </div>
  <script>${safeScriptContent}</script>
</body>
</html>`;
};

/** Prefer decrypted body if present; otherwise fall back to raw/original. */
export const pickOriginalContent = (
  content: { raw?: string; body?: string; textContent?: string } | null | undefined,
): string => {
  if (!content) return '';
  return content.raw || content.body || content.textContent || '';
};
