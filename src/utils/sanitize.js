import DOMPurify from 'dompurify';
import { Local } from './storage';

/**
 * Detect if an image is likely a tracking pixel
 * @param {string} attributes - Image tag attributes
 * @returns {boolean} True if likely a tracking pixel
 */
function isTrackingPixel(attributes) {
  // Extract width/height from HTML attributes
  const widthAttr = attributes.match(/\bwidth\s*=\s*["']?(\d+)["']?/i);
  const heightAttr = attributes.match(/\bheight\s*=\s*["']?(\d+)["']?/i);

  // Extract from inline styles
  const styleAttr = attributes.match(/\bstyle\s*=\s*["']([^"']+)["']/i);
  let styleWidth = null;
  let styleHeight = null;
  let isInvisible = false;

  if (styleAttr && styleAttr[1]) {
    const style = styleAttr[1].toLowerCase();

    // Check for invisible styles
    isInvisible =
      /opacity\s*:\s*0/.test(style) ||
      /display\s*:\s*none/.test(style) ||
      /visibility\s*:\s*hidden/.test(style);

    // Extract dimensions from style
    const widthMatch = style.match(/width\s*:\s*(\d+(?:\.\d+)?)(px)?/i);
    if (widthMatch) styleWidth = Math.round(parseFloat(widthMatch[1]));

    const heightMatch = style.match(/height\s*:\s*(\d+(?:\.\d+)?)(px)?/i);
    if (heightMatch) styleHeight = Math.round(parseFloat(heightMatch[1]));
  }

  const width = widthAttr ? parseInt(widthAttr[1], 10) : styleWidth;
  const height = heightAttr ? parseInt(heightAttr[1], 10) : styleHeight;

  // Detection criteria
  if (width === 1 && height === 1) return true; // Exact 1x1
  if (width !== null && height !== null && width < 10 && height < 10) return true; // Small
  if (isInvisible) return true; // Invisible
  if (
    (width === 1 && (height === null || height < 10)) ||
    (height === 1 && (width === null || width < 10))
  )
    return true; // One dimension is 1px

  return false;
}

/**
 * Marker left in place of a CSS url() we refused to load, so the same
 * declaration can be put back when the reader unblocks remote images.
 */
const CSS_BLOCKED_URL_MARKER = 'fe-blocked-url:';

/**
 * Sanitize the contents of an email <style> block.
 *
 * Email templates ship their own responsive stylesheet: the inline
 * `min-width: 720px` a builder writes for Outlook is meant to be overridden by
 * an `@media (max-width: 480px)` rule in <style>. Dropping the stylesheet
 * leaves only the desktop half, which is why desktop-width email used to
 * overflow on a phone. Keeping it lets the message reflow the way its sender
 * designed, at full text size.
 *
 * What has to come out first:
 *   - "</" — the only way a <style> body can break back out into markup once
 *     it is re-serialized. No valid CSS contains it.
 *   - Comments — they can hide the two items above from these checks.
 *   - @import — the iframe CSP refuses remote stylesheets anyway; dropping the
 *     rule avoids a failed request on every message.
 *   - expression() / behavior: — inert in the engines we ship, free to drop.
 *   - position: fixed — leaves the flow, so it contributes nothing to the
 *     height we measure and can leave an invisible layer over the message.
 *   - color / background-color / background — the reader forces its own theme
 *     colors, and email-iframe.js already strips these three from inline
 *     styles. A sheet rule with !important can out-specify the theme and leave
 *     white text on white, so the stylesheet plays by the same rule. Layout is
 *     what we keep it for; background-image and the rest survive.
 *
 * @param {string} css - Raw stylesheet text
 * @param {object} options
 * @param {boolean} options.blockRemoteUrls - Neutralize remote url() references
 * @returns {{ css: string, blockedCount: number }}
 */
export function sanitizeEmailCss(css, { blockRemoteUrls = false } = {}) {
  if (!css || typeof css !== 'string') return { css: '', blockedCount: 0 };

  let out = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<\//g, '')
    .replace(/@import\b[^;}]*;?/gi, '')
    .replace(/expression\s*\(/gi, '(')
    .replace(/behavior\s*:[^;}]*/gi, '')
    .replace(/position\s*:\s*fixed/gi, 'position: static')
    // Anchored to a declaration start so border-color and background-image,
    // which merely contain these names, are left alone.
    .replace(/(^|[;{])\s*(color|background-color|background)\s*:[^;}]*/gi, '$1');

  let blockedCount = 0;
  if (blockRemoteUrls) {
    // Comments are already gone, so the marker inserted here is the only one
    // in the sheet and cannot be forged by the email.
    out = out.replace(/url\(\s*(['"]?)(https?:\/\/[^'")\s]+)\1\s*\)/gi, (match, _quote, url) => {
      // A url() that could close the marker comment early would let the rest
      // of the declaration escape; leave those blocked outright.
      if (url.includes('*/') || url.includes('<')) return 'none';
      blockedCount++;
      return `/*${CSS_BLOCKED_URL_MARKER}${url}*/none`;
    });
  }

  return { css: out, blockedCount };
}

/**
 * Prepare email HTML so its <style> blocks survive sanitization.
 *
 * The HTML parser puts <style> in <head>, and DOMPurify returns only <body>,
 * so a stylesheet declared before any body content is lost to parsing before
 * the allow-list ever sees it. That is exactly where email templates put the
 * media queries that make them responsive.
 *
 * Handing the parsed <body> element back rather than a string is the point:
 * DOMPurify re-parses a string, which would hoist the stylesheet into <head>
 * a second time. It accepts a BODY node directly and skips the re-parse.
 *
 * @param {string} html - Raw HTML
 * @returns {string|HTMLElement} A body element when a stylesheet was moved,
 *   otherwise the input string unchanged
 */
function withHoistedStyles(html) {
  if (typeof DOMParser === 'undefined' || !/<style/i.test(html)) return html;

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headStyles = doc.head ? doc.head.querySelectorAll('style') : [];
    if (!headStyles.length || !doc.body) return html;

    // Prepend in reverse so the sheets keep their original relative order and
    // still precede the markup they target.
    for (let i = headStyles.length - 1; i >= 0; i--) {
      doc.body.insertBefore(headStyles[i], doc.body.firstChild);
    }
    return doc.body;
  } catch {
    // Malformed enough to break the parser — let DOMPurify handle it as-is.
    return html;
  }
}

/**
 * Dedicated DOMPurify instance.
 *
 * The <style> hook has to be registered exactly once, and it must not leak
 * into the app's other DOMPurify callers (Compose, Calendar) the way a hook on
 * the shared default export would.
 */
const emailPurify = DOMPurify();

// Handoff for the sanitize call in flight. DOMPurify runs synchronously, so a
// module-level slot is safe.
let activeCssContext = null;

emailPurify.addHook('afterSanitizeElements', (node) => {
  if (node.nodeName !== 'STYLE') return;
  const result = sanitizeEmailCss(node.textContent || '', {
    blockRemoteUrls: activeCssContext?.blockRemoteUrls === true,
  });
  if (activeCssContext) activeCssContext.blockedCount += result.blockedCount;
  node.textContent = result.css;
});

emailPurify.addHook('afterSanitizeAttributes', (node) => {
  // Links are intercepted by the iframe runtime and never navigate in place,
  // but keep the attributes correct for any consumer that renders this HTML
  // outside the iframe.
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Sanitize HTML email content with optional image blocking
 * @param {string} html - Raw HTML to sanitize
 * @param {object} options - Sanitization options
 * @param {boolean} options.blockRemoteImages - Block external images (default: reads from user preference)
 * @param {boolean} options.blockTrackingPixels - Block tracking pixels (default: reads from user preference)
 * @returns {object} { html: sanitized HTML, hasBlockedImages: boolean, trackingPixelCount: number, blockedRemoteImageCount: number }
 */
export function sanitizeHtml(html, { blockRemoteImages, blockTrackingPixels } = {}) {
  if (!html)
    return { html: '', hasBlockedImages: false, trackingPixelCount: 0, blockedRemoteImageCount: 0 };

  // Read user preference if not explicitly provided
  if (blockRemoteImages === undefined) {
    blockRemoteImages = Local.get('block_remote_images') === 'true';
  }

  // Read tracking pixel setting if not explicitly provided
  if (blockTrackingPixels === undefined) {
    blockTrackingPixels = Local.get('block_tracking_pixels') !== 'false'; // Default true
  }

  let hasBlockedImages = false;
  let trackingPixelCount = 0;
  let blockedRemoteImageCount = 0;

  try {
    // Pre-process HTML to block images BEFORE DOMPurify if needed
    let processedHtml = html;

    // Process images to detect and block tracking pixels or remote images
    if (blockRemoteImages || blockTrackingPixels) {
      processedHtml = processedHtml.replace(/<img([^>]*)>/gi, (match, attributes) => {
        // Extract src attribute (handles both single and double quotes, and no quotes)
        const srcMatch = attributes.match(/\ssrc\s*=\s*["']?([^"'\s>]+)["']?/i);
        if (!srcMatch) return match; // No src, keep as-is

        const src = srcMatch[1];

        // Keep data URIs as-is (inline images)
        if (src.startsWith('data:')) {
          return match;
        }

        // Validate URL scheme - block javascript:, vbscript:, etc.
        if (/^\s*(javascript|vbscript):/i.test(src)) {
          return ''; // Strip dangerous image tags entirely
        }

        // Classify image
        const isPixel = isTrackingPixel(attributes);
        let shouldBlock = false;

        if (isPixel && blockTrackingPixels) {
          shouldBlock = true;
          trackingPixelCount++;
        } else if (!isPixel && blockRemoteImages) {
          shouldBlock = true;
          blockedRemoteImageCount++;
        }

        if (shouldBlock) {
          hasBlockedImages = true;

          // Remove existing src attribute
          let newAttributes = attributes.replace(/\ssrc\s*=\s*["']?[^"'\s>]+["']?/gi, '');

          // Extract alt text if present
          const altMatch = attributes.match(/\salt\s*=\s*["']([^"']*)["']/i);
          const alt =
            altMatch?.[1] || (isPixel ? 'Tracking pixel blocked' : 'Image blocked for privacy');

          // HTML-encode src and alt to prevent attribute injection before DOMPurify
          const safeSrc = src
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
          const safeAlt = alt
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

          if (isPixel) {
            // Hide tracking pixels completely
            return `<img${newAttributes} data-original-src="${safeSrc}" data-tracking-pixel="true" alt="${safeAlt}" style="display: none;">`;
          } else {
            // Visible placeholder for regular images
            return `<img${newAttributes} data-original-src="${safeSrc}" alt="${safeAlt}" style="display: inline-block; min-width: 100px; min-height: 100px; background: #f3f4f6; border: 2px dashed #d1d5db; border-radius: 8px; padding: 8px; color: #6b7280; font-size: 12px; text-align: center;">`;
          }
        }

        return match;
      });
    }

    // <style> carries the email's own responsive rules, so it is allowed
    // through and its contents run past sanitizeEmailCss via the hook above.
    activeCssContext = { blockRemoteUrls: blockRemoteImages === true, blockedCount: 0 };
    let sanitized;
    try {
      sanitized = emailPurify.sanitize(withHoistedStyles(processedHtml), {
        USE_PROFILES: { html: true },
        ADD_TAGS: ['style'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
        ADD_ATTR: ['data-original-src', 'data-tracking-pixel'],
      });
      if (activeCssContext.blockedCount > 0) {
        hasBlockedImages = true;
        blockedRemoteImageCount += activeCssContext.blockedCount;
      }
    } finally {
      activeCssContext = null;
    }

    return { html: sanitized, hasBlockedImages, trackingPixelCount, blockedRemoteImageCount };
  } catch (error) {
    console.error('DOMPurify sanitize failed:', error);
    return { html: '', hasBlockedImages: false, trackingPixelCount: 0, blockedRemoteImageCount: 0 };
  }
}

/**
 * Restore blocked images in sanitized HTML
 * @param {string} html - Sanitized HTML with blocked images
 * @param {object} options - Restore options
 * @param {boolean} options.includeTrackingPixels - Whether to restore tracking pixels (default: false)
 * @returns {string} HTML with images restored
 */
// Allowlist of safe URL protocols for image sources
const SAFE_IMAGE_PROTOCOLS =
  /^(https?:\/\/|data:image\/(png|jpeg|jpg|gif|webp|bmp|x-icon|avif)[;,])/i;

/**
 * Validate that an image URL is safe to restore.
 * Blocks javascript:, vbscript:, data: (non-image), and other dangerous URIs.
 */
function isSafeImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  // Block empty, javascript:, vbscript:, and other dangerous schemes
  if (
    /^\s*(javascript|vbscript|data(?!:image\/(png|jpeg|jpg|gif|webp|bmp|x-icon|avif)[;,]))/i.test(
      trimmed,
    )
  )
    return false;
  // Must start with http(s) or data:image/
  return SAFE_IMAGE_PROTOCOLS.test(trimmed);
}

/**
 * Convert sanitized HTML to a plain-text string for "view as plain text" mode.
 *
 * Uses DOMParser rather than regex stripping so structure is preserved:
 * block elements become newlines, <br> becomes a single newline, and links
 * are kept with their href appended (so they remain useful/copyable in text
 * view). The result is intended to be wrapped in <pre> when rendered.
 *
 * @param {string} html - HTML to convert
 * @returns {string} Plain-text representation
 */
export function htmlToPlainText(html) {
  if (!html) return '';

  if (typeof DOMParser === 'undefined') {
    // Last-resort fallback for non-DOM environments
    return String(html)
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/?(p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Drop noise that has no readable text equivalent
    doc.querySelectorAll('script, style, head').forEach((el) => el.remove());

    // <br> becomes a newline
    doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));

    // Block-level elements get a trailing newline so their contents don't
    // merge into one line
    doc
      .querySelectorAll('p, div, li, h1, h2, h3, h4, h5, h6, tr, blockquote, pre, hr')
      .forEach((el) => el.append('\n'));

    // Show the href next to link text — these are otherwise lost in textContent
    doc.querySelectorAll('a[href]').forEach((a) => {
      const href = a.getAttribute('href') || '';
      const text = (a.textContent || '').trim();
      if (href && text && !text.includes(href)) {
        a.append(` <${href}>`);
      }
    });

    // Replace images with their alt text (or [image])
    doc.querySelectorAll('img').forEach((img) => {
      const alt = img.getAttribute('alt') || '';
      img.replaceWith(alt ? `[${alt}]` : '[image]');
    });

    const raw = doc.body?.textContent || '';
    return raw
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } catch (error) {
    console.error('htmlToPlainText failed:', error);
    return '';
  }
}

export function restoreBlockedImages(html, { includeTrackingPixels = false } = {}) {
  if (!html) return '';

  try {
    // Pattern excludes tracking pixels unless explicitly requested
    const pattern = includeTrackingPixels
      ? /<img([^>]*)data-original-src=["']([^"']+)["']([^>]*)>/gi
      : /<img([^>]*)data-original-src=["']([^"']+)["'](?![^>]*data-tracking-pixel="true")([^>]*)>/gi;

    const restoredHtml = html.replace(pattern, (match, before, originalSrc, after) => {
      // Validate URL before restoring - block javascript: and other dangerous URIs
      if (!isSafeImageUrl(originalSrc)) {
        return match; // Keep blocked if URL is unsafe
      }

      // HTML-encode the src to prevent attribute injection
      const safeSrc = originalSrc
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Remove placeholder styles and data attributes
      const cleanBefore = before
        .replace(/style=["'][^"']*["']\s*/gi, '')
        .replace(/data-tracking-pixel=["']true["']\s*/gi, '');
      const cleanAfter = after
        .replace(/style=["'][^"']*["']\s*/gi, '')
        .replace(/data-tracking-pixel=["']true["']\s*/gi, '');
      // Restore the original src with sanitized URL
      return `<img${cleanBefore}src="${safeSrc}"${cleanAfter}>`;
    });

    // Put back the CSS backgrounds sanitizeEmailCss neutralized, so unblocking
    // restores a <style> sheet's imagery too and not just <img> tags.
    const withCssUrls = restoredHtml.replace(
      new RegExp(`/\\*${CSS_BLOCKED_URL_MARKER}([^*]+)\\*/\\s*none`, 'g'),
      (match, originalUrl) => (isSafeImageUrl(originalUrl) ? `url("${originalUrl}")` : match),
    );

    return withCssUrls;
  } catch (error) {
    console.error('Failed to restore images:', error);
    return html;
  }
}
