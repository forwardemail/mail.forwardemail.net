/**
 * Iframe Srcdoc Builder
 *
 * Builds the HTML document for sandboxed email rendering.
 * Includes CSS for light/dark modes and JS for height measurement/link interception.
 */

/**
 * Build the srcdoc HTML for the email iframe
 *
 * @param emailHtml - Sanitized email HTML content
 * @param isDarkMode - Whether the app is in dark mode
 * @returns Complete HTML document string for srcdoc
 */
export function buildIframeSrcdoc(emailHtml: string, isDarkMode: boolean = false): string {
  const bodyClass = isDarkMode ? 'fe-iframe-dark' : 'fe-iframe-light';
  const scriptContent = getEmbeddedScript();
  // The iframe is sandboxed (sandbox="allow-scripts") so 'unsafe-inline' here
  // only applies within the isolated srcdoc context — not the parent page.
  // Using a hash is fragile because the browser hashes the full text node
  // between <script>…</script> including template-literal whitespace.

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http:; font-src data: https:; script-src 'unsafe-inline';">
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
  <script>
    ${scriptContent}
  </script>
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
    }

    a:hover {
      color: #2563eb;
    }

    pre, code {
      overflow-x: auto;
      white-space: pre-wrap;
      word-wrap: break-word;
    }

    table {
      max-width: 100%;
      border-collapse: collapse;
    }

    blockquote {
      margin: 0.5em 0;
      padding-left: 1em;
      border-left: 3px solid #d1d5db;
      color: #6b7280;
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

function getEmbeddedScript(): string {
  return `
    (function() {
      'use strict';

      // Send ready message FIRST - ensures parent knows iframe is alive even if other code fails
      try {
        parent.postMessage({ type: 'ready', payload: {} }, '*');
      } catch (e) {
        // Ignore - parent might not be accessible
      }

      // Configuration
      var STYLE_PROPS_TO_STRIP = ['color', 'background-color', 'background'];
      var HEIGHT_REPORT_DELAYS = [0, 50, 100, 200, 500, 1000];

      /**
       * Strip inline color/background styles from an element
       * This prevents invisible text caused by white-on-white or dark-on-dark
       */
      function stripElementStyles(el) {
        if (!el || !el.style) return;
        STYLE_PROPS_TO_STRIP.forEach(function(prop) {
          if (el.style.getPropertyValue(prop)) {
            el.style.removeProperty(prop);
          }
        });
      }

      /**
       * Strip inline styles from all elements in the document
       */
      function stripAllInlineStyles() {
        var elements = document.querySelectorAll('*');
        elements.forEach(stripElementStyles);
      }

      /**
       * Set up a MutationObserver to strip styles from dynamically added content
       */
      function observeForNewContent() {
        if (typeof MutationObserver === 'undefined') return;

        var observer = new MutationObserver(function(mutations) {
          mutations.forEach(function(mutation) {
            // Handle added nodes
            mutation.addedNodes.forEach(function(node) {
              if (node.nodeType === 1) { // Element node
                stripElementStyles(node);
                // Also strip from children
                if (node.querySelectorAll) {
                  node.querySelectorAll('*').forEach(stripElementStyles);
                }
              }
            });
            // Handle attribute changes (style attribute modified)
            if (mutation.type === 'attributes' && mutation.attributeName === 'style') {
              stripElementStyles(mutation.target);
            }
          });
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['style']
        });
      }

      /**
       * Run style stripping with multiple timing strategies
       */
      function ensureStylesStripped() {
        // Run immediately
        stripAllInlineStyles();

        // Run after next animation frame
        if (typeof requestAnimationFrame !== 'undefined') {
          requestAnimationFrame(function() {
            stripAllInlineStyles();
            // And one more after that
            requestAnimationFrame(stripAllInlineStyles);
          });
        }

        // Run after a short delay as fallback
        setTimeout(stripAllInlineStyles, 10);
      }

      // Initialize style stripping
      ensureStylesStripped();

      // Handle different document ready states
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
          ensureStylesStripped();
          observeForNewContent();
        });
      } else {
        // DOM already loaded
        setTimeout(function() {
          ensureStylesStripped();
          observeForNewContent();
        }, 0);
      }

      // Also run on window load (after images, etc.)
      window.addEventListener('load', ensureStylesStripped);

      /**
       * Height measurement and reporting
       */
      function reportHeight() {
        var content = document.querySelector('.fe-email-content');
        var contentHeight = content ? content.getBoundingClientRect().height : 0;

        var height = Math.max(
          contentHeight,
          document.body.scrollHeight,
          document.body.offsetHeight,
          document.documentElement.scrollHeight,
          document.documentElement.offsetHeight
        );

        // Ensure minimum height and round up
        height = Math.max(Math.ceil(height), 50);

        parent.postMessage({ type: 'height', payload: { height: height } }, '*');
      }

      // Report height at multiple intervals to catch all rendering phases
      HEIGHT_REPORT_DELAYS.forEach(function(delay) {
        setTimeout(reportHeight, delay);
      });

      // Also report height when DOM is fully ready
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', reportHeight);
      }
      window.addEventListener('load', reportHeight);

      // Use ResizeObserver for efficient ongoing height updates
      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function() {
          // Debounce rapid resize events
          clearTimeout(ro._timeout);
          ro._timeout = setTimeout(reportHeight, 16);
        });
        ro.observe(document.body);

        var content = document.querySelector('.fe-email-content');
        if (content) {
          ro.observe(content);
        }
      } else {
        // Fallback polling for older browsers
        setInterval(reportHeight, 500);
      }

      // Report height after images load
      document.querySelectorAll('img').forEach(function(img) {
        if (!img.complete) {
          img.addEventListener('load', reportHeight);
          img.addEventListener('error', reportHeight);
        }
      });

      /**
       * Link click interception
       */
      document.addEventListener('click', function(e) {
        var link = e.target.closest('a');
        if (link && link.href) {
          e.preventDefault();
          e.stopPropagation();
          var url = link.href;
          var isMailto = url.toLowerCase().startsWith('mailto:');
          parent.postMessage({
            type: 'link',
            payload: { url: url, isMailto: isMailto }
          }, '*');
        }
      }, true);

      /**
       * Form submission blocking
       */
      document.addEventListener('submit', function(e) {
        e.preventDefault();
        e.stopPropagation();
        var form = e.target;
        var formData = {};
        try {
          var data = new FormData(form);
          data.forEach(function(value, key) {
            formData[key] = value;
          });
        } catch (err) {
          // Ignore FormData errors
        }
        parent.postMessage({
          type: 'form',
          payload: {
            action: form.action || '',
            method: form.method || 'get',
            data: formData
          }
        }, '*');
      }, true);

      /**
       * Quote toggle handling
       */
      document.addEventListener('click', function(e) {
        var toggle = e.target.closest('.fe-quote-toggle');
        if (!toggle) return;

        e.preventDefault();
        e.stopPropagation();

        var wrapper = toggle.closest('.fe-quote-wrapper');
        if (!wrapper) return;

        var isCollapsed = wrapper.classList.contains('fe-quote-collapsed');
        wrapper.classList.toggle('fe-quote-collapsed');

        var label = toggle.querySelector('.fe-quote-label');
        if (label) {
          label.textContent = isCollapsed ? 'Hide quoted text' : 'Show quoted text';
        }

        // Report new height after toggle animation
        setTimeout(reportHeight, 50);
        setTimeout(reportHeight, 350);
      }, true);

      // Note: 'ready' message is sent at the START of this script to ensure
      // parent is notified even if subsequent initialization fails
    })();
  `;
}
