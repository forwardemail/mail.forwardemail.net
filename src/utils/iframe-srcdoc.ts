/**
 * Iframe srcdoc builder.
 *
 * Builds the HTML document for sandboxed email rendering. The runtime script
 * lives at /email-iframe.js (served from the parent origin) rather than
 * inline — Tauri's dev runtime injects a nonce into the webview CSP, and
 * inherited CSPs on srcdoc iframes ignore `'unsafe-inline'` once any nonce
 * is present. An external `'self'` script is immune to that interaction.
 */

const SCRIPT_URL = '/email-iframe.js';

function parentOrigin(): string {
  return typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : "'self'";
}

export function buildIframeSrcdoc(emailHtml: string, isDarkMode: boolean = false): string {
  const bodyClass = isDarkMode ? 'fe-iframe-dark' : 'fe-iframe-light';
  const origin = parentOrigin();
  const scriptSrc = `${origin}${SCRIPT_URL}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data: https:; script-src ${origin};">
  <style>
    ${getResetStyles()}
    ${getAppearanceStyles()}
    ${getQuoteToggleStyles()}
  </style>
</head>
<body class="${bodyClass}">
  <div class="fe-email-content">
    ${emailHtml}
  </div>
  <script src="${scriptSrc}"></script>
</body>
</html>`;
}

function getResetStyles(): string {
  return `
    *, *::before, *::after {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 14px;
      line-height: 1.6;
      word-wrap: break-word;
      overflow-wrap: break-word;
      overflow-x: hidden;
    }

    body {
      padding: 0;
      overflow-x: hidden;
      overflow-y: auto;
    }

    .fe-email-content {
      padding: 0;
      min-height: 1px;
      max-width: 100%;
      word-wrap: break-word;
      overflow-wrap: break-word;
      /* Ensure content is measured correctly */
      display: flow-root;
    }

    /* Email content styling */
    img {
      max-width: 100%;
      height: auto;
    }

    a {
      color: #3b82f6;
      text-decoration: underline;
      word-break: break-word;
      overflow-wrap: anywhere;
    }

    a:hover {
      color: #2563eb;
    }

    pre, code {
      max-width: 100%;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }

    table {
      max-width: 100% !important;
      border-collapse: collapse;
    }

    td, th {
      max-width: 100%;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    blockquote {
      margin: 0.5em 0;
      padding-left: 1em;
      border-left: 3px solid #d1d5db;
      color: #6b7280;
      max-width: 100%;
      word-wrap: break-word;
      overflow-wrap: break-word;
    }

    /* Remove .fe-message-canvas wrapper styling since we handle it in the iframe */
    .fe-message-canvas {
      all: unset;
      display: block;
    }
  `;
}

function getAppearanceStyles(): string {
  return `
    /*
     * Color Forcing Strategy:
     * We use !important on ALL elements to ensure visibility regardless of
     * inline styles in the email HTML. The embedded script also strips inline
     * color/background styles, but CSS !important provides a fallback.
     */

    /* Light mode - neutral light background */
    body.fe-iframe-light {
      background: #ffffff !important;
      color: #1f2937 !important;
    }

    /* Force light mode colors on all elements */
    body.fe-iframe-light * {
      color: #1f2937 !important;
      background-color: transparent !important;
    }

    /* Preserve quote toggle button styling */
    body.fe-iframe-light .fe-quote-toggle,
    body.fe-iframe-light .fe-quote-dots,
    body.fe-iframe-light .fe-quote-label {
      color: #6b7280 !important;
      background: #f3f4f6 !important;
    }

    body.fe-iframe-light a,
    body.fe-iframe-light a * {
      color: #3b82f6 !important;
    }

    body.fe-iframe-light blockquote,
    body.fe-iframe-light blockquote * {
      color: #6b7280 !important;
    }

    /* Dark mode - dark background with light text */
    body.fe-iframe-dark {
      background: #0f172a !important;
      color: #e2e8f0 !important;
    }

    /* Force dark mode colors on ALL elements */
    body.fe-iframe-dark * {
      color: #e2e8f0 !important;
      background-color: transparent !important;
      border-color: #334155 !important;
    }

    /* Preserve quote toggle button styling */
    body.fe-iframe-dark .fe-quote-toggle,
    body.fe-iframe-dark .fe-quote-dots,
    body.fe-iframe-dark .fe-quote-label {
      color: #94a3b8 !important;
      background: #1e293b !important;
    }

    /* Slightly dimmer text for secondary content */
    body.fe-iframe-dark .moz-signature,
    body.fe-iframe-dark .gmail_signature,
    body.fe-iframe-dark [data-smartmail="gmail_signature"],
    body.fe-iframe-dark footer,
    body.fe-iframe-dark small,
    body.fe-iframe-dark .text-muted,
    body.fe-iframe-dark code {
      color: #94a3b8 !important;
    }

    body.fe-iframe-dark a,
    body.fe-iframe-dark a * {
      color: #60a5fa !important;
    }

    body.fe-iframe-dark blockquote,
    body.fe-iframe-dark blockquote * {
      color: #94a3b8 !important;
      border-left-color: #475569 !important;
    }

    body.fe-iframe-dark table,
    body.fe-iframe-dark th,
    body.fe-iframe-dark td,
    body.fe-iframe-dark tr {
      border-color: #334155 !important;
      background-color: transparent !important;
    }

    body.fe-iframe-dark hr {
      border-color: #334155 !important;
    }

    /* Ensure images are visible (don't invert them) */
    body.fe-iframe-dark img {
      background-color: transparent !important;
    }
  `;
}

function getQuoteToggleStyles(): string {
  return `
    /* Quote collapse styles */
    .fe-quote-wrapper {
      margin: 8px 0;
    }

    .fe-quote-toggle {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      margin: 4px 0;
      background: #f3f4f6 !important;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      color: #6b7280 !important;
      font-family: inherit;
    }

    .fe-quote-toggle:hover {
      background: #e5e7eb !important;
      color: #374151 !important;
    }

    body.fe-iframe-dark .fe-quote-toggle {
      background: #1e293b !important;
      border-color: #334155;
      color: #94a3b8 !important;
    }

    body.fe-iframe-dark .fe-quote-toggle:hover {
      background: #334155 !important;
      color: #cbd5e1 !important;
    }

    .fe-quote-dots {
      font-weight: bold;
      letter-spacing: 1px;
    }

    .fe-quote-content {
      transition: max-height 0.3s ease, opacity 0.3s ease;
    }

    .fe-quote-wrapper.fe-quote-collapsed .fe-quote-content {
      display: none;
    }

    .fe-quote-label {
      font-size: 11px;
    }
  `;
}
