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
import { displayAddresses, extractAddressList } from '../utils/address';

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
    const DATA = ${JSON.stringify({ raw, headers, decrypted, filename })
      // Every "<" as a JS escape: message source containing "<!--<script>"
      // would otherwise switch the HTML parser into script-data escape states
      // and leave this <script> unterminated.
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')};

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
  <!-- The page's only script is the viewer below; the decrypted body renders
       in a script-less sandboxed frame that inherits this policy, so it cannot
       fetch remote images (tracking pixels) or submit forms either. -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; frame-src 'self' about: data: blob:; form-action 'none'; base-uri 'none'" />
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
    <h1>${subject ? subject.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : 'Original message'}</h1>
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

// ---------------------------------------------------------------------------
// Server drafts
// ---------------------------------------------------------------------------

type DraftRow = Record<string, unknown> & {
  id?: string;
  subject?: string;
  in_reply_to?: string | null;
  references?: string | null;
};

export interface ServerDraftPrefillInput {
  /** The Drafts folder list row, as normalized by the sync layer. */
  msg: DraftRow;
  /** Id to update and delete on the server, from getMessageApiId(msg). */
  apiId: string;
  /** Result of GET /v1/messages/:id when one was fetched, else null. */
  detail?: Record<string, unknown> | null;
  /** Sanitized HTML body, from the cache or from the detail fetch. */
  html?: string;
  /** Plain text body, when the message has no HTML part. */
  text?: string;
  /** Compose attachment objects (name, contentType, base64 content, size). */
  attachments?: unknown[];
}

// The row renders a name with quotes ("Ada Lovelace" <ada@x>) while the
// parsed object form comes out bare (Ada Lovelace <ada@x>), and compose chips
// show whichever they were given. Drop the quotes only when nothing in the
// name needs them; a comma or a bracket has to stay quoted because the chip
// text is parsed again as an address when the message is sent.
const unquoteSimpleName = (address: string): string => {
  const match = address.match(/^"([^"\\]*)"\s*(<[^>]*>)$/);
  if (!match) return address;
  const [, name, angle] = match;
  return /[,;:<>@()[\]]/.test(name) ? address : `${name} ${angle}`;
};

const textToHtml = (text: string): string =>
  text
    .split(/\r?\n/)
    .map(
      (line) => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`,
    )
    .join('');

const headerLookup = (headers: unknown, name: string): string => {
  if (!headers || typeof headers !== 'object') return '';
  const lower = name.toLowerCase();
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === lower);
  if (!key) return '';
  const value = record[key];
  if (Array.isArray(value)) return value.map(String).join(' ').trim();
  return value == null ? '' : String(value).trim();
};

/**
 * Read a threading header off whatever shape we have: the normalized row
 * (snake_case), the detail result's parsed nodemailer fields, or its raw
 * header map.
 */
const threadingHeader = (
  msg: DraftRow,
  detail: Record<string, unknown> | null | undefined,
  rowKey: 'in_reply_to' | 'references',
): string => {
  const camel = rowKey === 'in_reply_to' ? 'inReplyTo' : 'references';
  const headerName = rowKey === 'in_reply_to' ? 'in-reply-to' : 'references';
  const fromRow = msg[rowKey] ?? msg[camel];
  if (typeof fromRow === 'string' && fromRow.trim()) return fromRow.trim();
  if (Array.isArray(fromRow) && fromRow.length) return fromRow.map(String).join(' ').trim();
  const nm = (detail?.nodemailer as Record<string, unknown> | undefined) || undefined;
  const parsed = detail?.[camel] ?? detail?.[rowKey] ?? nm?.[camel];
  if (typeof parsed === 'string' && parsed.trim()) return parsed.trim();
  if (Array.isArray(parsed) && parsed.length) return parsed.map(String).join(' ').trim();
  return headerLookup(nm?.headers, headerName) || headerLookup(detail?.headers, headerName);
};

/**
 * Turn a Drafts folder message into a compose prefill.
 *
 * The row alone is not enough: its recipients are comma-joined display
 * strings, it never carries a body or attachments, and a draft written by
 * another client (or by the API) is only editable in place if compose knows
 * the server id. This is the one spot that maps all of that, so the shape
 * compose receives is the same whether the body came from the cache or from
 * a detail fetch. Pure so it can be tested without a store or a network.
 */
export const buildServerDraftPrefill = ({
  msg,
  apiId,
  detail = null,
  html = '',
  text = '',
  attachments = [],
}: ServerDraftPrefillInput): Record<string, unknown> => {
  // extractAddressList handles the row's string form and, when the row is
  // missing the field (lightweight list mode), the detail's parsed headers.
  // Prefer the detail when both exist: the row is a display rendering and
  // the detail keeps the original quoting.
  const addressField = (field: 'to' | 'cc' | 'bcc' | 'replyTo'): string[] => {
    const fromDetail = detail ? displayAddresses(extractAddressList(detail, field)) : [];
    const list = fromDetail.length ? fromDetail : displayAddresses(extractAddressList(msg, field));
    return list.map(unquoteSimpleName);
  };

  const replyTo = addressField('replyTo');
  const inReplyTo = threadingHeader(msg, detail, 'in_reply_to');
  const references = threadingHeader(msg, detail, 'references');

  const prefill: Record<string, unknown> = {
    to: addressField('to'),
    cc: addressField('cc'),
    bcc: addressField('bcc'),
    subject: typeof msg.subject === 'string' ? msg.subject : '',
    attachments: Array.isArray(attachments) ? attachments : [],
    sourceMessageId: msg.id,
    serverDraftId: apiId,
  };
  if (replyTo.length) prefill.replyTo = replyTo[0];
  if (inReplyTo) prefill.inReplyTo = inReplyTo;
  if (references) prefill.references = references;
  // Compose only reads a text prefill in plain-text mode, which a fresh open
  // never is, so a text-only draft is handed over as minimal HTML instead of
  // arriving empty.
  if (html) prefill.html = html;
  else if (text) prefill.html = textToHtml(text);
  return prefill;
};
