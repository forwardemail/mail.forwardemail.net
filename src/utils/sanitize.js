import DOMPurify from 'dompurify';
import { Local } from './storage';
import { REMOTE_IMAGES_BLOCKED_MARKER } from './remote-images-marker.ts';

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

export { REMOTE_IMAGES_BLOCKED_MARKER };

// Remote references the <img src> rewrite does not rewrite, checked on the
// sanitized output so the "load images" control is offered for them too.
const OTHER_REMOTE_IMAGE_REFS =
  /\s(?:srcset|background|poster)\s*=\s*["']?[^"'>]*https?:|url\(\s*['"]?https?:/i;

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

// One attribute of a tag, split the way the HTML parser splits it: a name
// (anything up to whitespace, "/", ">" or "=", quotes included; a leading "="
// is part of it), then an optional double-quoted, single-quoted or unquoted
// value. Walking the tag one attribute at a time means "style=" written
// inside another attribute's value is never taken for one.
const TAG_ATTRIBUTE =
  /\s*((?:=|[^\s/>=])[^\s/>=]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?|\s*\/|\s+/y;

/**
 * Remove attributes from the attribute text of a tag.
 * @param {string} attributes - Everything between "<img" and ">"
 * @param {string[]} names - Lowercase names to remove
 * @returns {{ attributes: string, removed: Record<string, string> }} The
 *   remaining text, and the raw value of each removed attribute
 */
function takeAttributes(attributes, names) {
  const removed = {};
  let kept = '';
  TAG_ATTRIBUTE.lastIndex = 0;
  while (TAG_ATTRIBUTE.lastIndex < attributes.length) {
    const start = TAG_ATTRIBUTE.lastIndex;
    const m = TAG_ATTRIBUTE.exec(attributes);
    if (!m || m[0] === '') {
      // Not reachable with the pattern above; if it ever is, keep the rest
      // but never an attribute that loads something
      kept += attributes.slice(start).replace(/\s(?:src|srcset)\s*=\s*["']?[^"'\s>]+["']?/gi, '');
      break;
    }
    const name = m[1]?.toLowerCase();
    if (name && names.includes(name)) {
      if (!(name in removed)) removed[name] = m[2] ?? m[3] ?? m[4] ?? '';
    } else {
      kept += m[0];
    }
  }
  return { attributes: kept, removed };
}

const BLOCKED_IMAGE_PLACEHOLDER_STYLE =
  'display: inline-block; min-width: 100px; min-height: 100px; background: #f3f4f6; border: 2px dashed #d1d5db; border-radius: 8px; padding: 8px; color: #6b7280; font-size: 12px; text-align: center;';

/**
 * Make raw attribute text from the email safe to place inside "…".
 * Entities the email already wrote (&amp; in a URL) are left as they are, so
 * the value is encoded once rather than twice.
 * @param {string} value - Attribute text as it appears in the source
 * @returns {string}
 */
function toAttributeValue(value) {
  return String(value)
    .replace(/&(?![a-z][a-z\d]*;|#\d+;|#x[\da-f]+;)/gi, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
        const { src } = takeAttributes(attributes, ['src']).removed;
        if (!src) return match; // No src, keep as-is

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

          // Take out src, and style so it can be kept for when images load.
          // A pixel also loses srcset: it would load once the user loads the
          // other images, even though the pixel itself stays blocked.
          const taken = takeAttributes(
            attributes,
            isPixel ? ['src', 'style', 'srcset'] : ['src', 'style'],
          );
          const newAttributes = taken.attributes ? ` ${taken.attributes.trim()}` : '';
          const originalStyle =
            'style' in taken.removed ? toAttributeValue(taken.removed.style) : '';

          // Extract alt text if present
          const altMatch = attributes.match(/\salt\s*=\s*["']([^"']*)["']/i);
          const alt =
            altMatch?.[1] || (isPixel ? 'Tracking pixel blocked' : 'Image blocked for privacy');

          // Values stay HTML-encoded exactly once to prevent attribute injection
          // before DOMPurify (the source is already encoded: &amp; stays &amp;)
          const safeSrc = toAttributeValue(src);
          const safeAlt = toAttributeValue(alt);
          const keptStyle = originalStyle ? ` data-original-style="${originalStyle}"` : '';

          if (isPixel) {
            // Hide tracking pixels completely
            return `<img${newAttributes} data-original-src="${safeSrc}"${keptStyle} data-tracking-pixel="true" alt="${safeAlt}" style="display: none;">`;
          }

          // An image with its own style keeps it (its layout is what holds the
          // space); one without gets the visible placeholder
          const style = originalStyle || BLOCKED_IMAGE_PLACEHOLDER_STYLE;
          return `<img${newAttributes} data-original-src="${safeSrc}"${keptStyle} alt="${safeAlt}" style="${style}">`;
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
        ADD_ATTR: ['data-original-src', 'data-original-style', 'data-tracking-pixel'],
      });
      if (activeCssContext.blockedCount > 0) {
        hasBlockedImages = true;
        blockedRemoteImageCount += activeCssContext.blockedCount;
      }
    } finally {
      activeCssContext = null;
    }

    if (blockRemoteImages === true && typeof sanitized === 'string' && sanitized) {
      if (OTHER_REMOTE_IMAGE_REFS.test(sanitized)) {
        hasBlockedImages = true;
        if (blockedRemoteImageCount === 0) blockedRemoteImageCount = 1;
      }
      sanitized += REMOTE_IMAGES_BLOCKED_MARKER;
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
    // Edit a parsed, inert copy rather than matching tags as text. A
    // <template> does not load images and, unlike a parsed document, keeps a
    // leading <style> where it is instead of moving it into <head>.
    const template = new DOMParser()
      .parseFromString('<!doctype html><title></title>', 'text/html')
      .createElement('template');
    template.innerHTML = html;

    for (const img of template.content.querySelectorAll('img[data-original-src]')) {
      if (!includeTrackingPixels && img.getAttribute('data-tracking-pixel') === 'true') continue;

      // Validate URL before restoring - block javascript: and other dangerous URIs
      const src = img.getAttribute('data-original-src');
      if (!isSafeImageUrl(src)) continue;

      // Swap the placeholder style back for the image's own, kept aside while
      // it was blocked
      const originalStyle = img.getAttribute('data-original-style');
      if (originalStyle) img.setAttribute('style', originalStyle);
      else img.removeAttribute('style');
      img.removeAttribute('data-original-src');
      img.removeAttribute('data-original-style');
      img.removeAttribute('data-tracking-pixel');
      img.setAttribute('src', src);
    }

    // Put back the CSS backgrounds sanitizeEmailCss neutralized, so unblocking
    // restores a <style> sheet's imagery too and not just <img> tags. Only
    // stylesheet text holds real markers: one written into an attribute by
    // the email is left alone, as the quotes put back here would end the
    // attribute early.
    const cssMarker = new RegExp(`/\\*${CSS_BLOCKED_URL_MARKER}([^*]+)\\*/\\s*none`, 'g');
    for (const style of template.content.querySelectorAll('style')) {
      style.textContent = style.textContent.replace(cssMarker, (match, originalUrl) =>
        isSafeImageUrl(originalUrl) ? `url("${originalUrl}")` : match,
      );
    }

    // The user chose to load images: lift the reader's image CSP too.
    return template.innerHTML.split(REMOTE_IMAGES_BLOCKED_MARKER).join('');
  } catch (error) {
    console.error('Failed to restore images:', error);
    return html;
  }
}

// A reference that leaves the device: http(s) or protocol-relative.
const REMOTE_REF = /^\s*(?:https?:)?\/\//i;

// CSS functions that make the browser fetch something.
const CSS_FETCH_FN =
  /(?:url|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade|element|src)\s*\(/i;

// Elements that load a resource on their own, or embed another document.
// The quote shows text and images; none of these belong in it.
const QUOTE_FORBID_TAGS = [
  'style',
  'script',
  'link',
  'meta',
  'base',
  'video',
  'audio',
  'source',
  'track',
  'embed',
  'object',
  'iframe',
  'frame',
  'frameset',
  'input',
  'image',
  'use',
  'feimage',
];

/**
 * Decode CSS escapes (`\\72` → `r`, `\\(` → `(`) and drop comments, the
 * way the browser does before it looks for `url(`.
 */
function decodeCss(value) {
  return String(value)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/\\(.)/g, '$1');
}

/**
 * Split a style attribute into declarations on the semicolons that are not
 * inside quotes or parentheses (a data: URL carries its own semicolon).
 */
function splitDeclarations(style) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let current = '';
  for (let i = 0; i < style.length; i++) {
    const ch = style[i];
    if (ch === '\\') {
      current += ch + (style[i + 1] || '');
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/**
 * True when a declaration makes the browser fetch anything other than an
 * inline data: resource.
 */
function declarationFetches(declaration) {
  const decoded = decodeCss(declaration);
  if (!CSS_FETCH_FN.test(decoded)) return false;
  // every fetch in it must be a data: URL for it to stay
  const withoutData = decoded.replace(
    /(?:url|image-set|-webkit-image-set|image|cross-fade|-webkit-cross-fade|element|src)\s*\(\s*(['"]?)\s*data:[^)]*\)/gi,
    '',
  );
  return CSS_FETCH_FN.test(withoutData);
}

/**
 * Remove the declarations of an inline style that fetch something remote,
 * keeping the rest (layout, colours). Returns null when nothing is left.
 */
function stripFetchingDeclarations(style) {
  const kept = splitDeclarations(style).filter((d) => !declarationFetches(d));
  const out = kept
    .map((d) => d.trim())
    .filter(Boolean)
    .join('; ');
  return out || null;
}

function isHiddenOrTiny(el) {
  const width = Number.parseInt(el.getAttribute('width') || '', 10);
  const height = Number.parseInt(el.getAttribute('height') || '', 10);
  if ((Number.isFinite(width) && width <= 2) || (Number.isFinite(height) && height <= 2))
    return true;
  const style = decodeCss(el.getAttribute('style') || '').toLowerCase();
  if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[;\s]|$)/.test(style))
    return true;
  const sw = style.match(/(?:^|[;\s])width\s*:\s*(\d+(?:\.\d+)?)px/);
  const sh = style.match(/(?:^|[;\s])height\s*:\s*(\d+(?:\.\d+)?)px/);
  return Boolean((sw && Number(sw[1]) <= 2) || (sh && Number(sh[1]) <= 2));
}

/**
 * Sanitize the original message quoted in a reply or forward.
 *
 * The compose window renders the quote straight into the app's own DOM, not
 * in the sandboxed reader iframe, so anything left in it that points at a
 * remote host is fetched the moment Reply or Forward is pressed. That tells the
 * sender their message was replied to or forwarded, when, and from where,
 * without the recipient ever having chosen to load images.
 *
 * Images follow the reader's rules (tracking pixels blocked by default, other
 * remote images when the user blocks them), decided here on the parsed
 * document rather than by pattern matching the source, which crafted markup
 * can mislead. Everything else that could load something is removed: media,
 * embeds, frames, form images and SVG references (QUOTE_FORBID_TAGS), remote
 * srcset/background/poster attributes, and every inline style declaration
 * that fetches anything but a data: URL (after decoding CSS escapes, which is
 * how `u\\72l(` hides a `url(`). The quote keeps its text and layout; the
 * original HTML is still what is sent.
 *
 * The HTML is only ever parsed in an inert document here (DOMParser and
 * DOMPurify both use one), so nothing is requested before the caller inserts
 * the result.
 *
 * @param {string} html - The original message HTML
 * @param {object} [options]
 * @param {boolean} [options.blockRemoteImages] - Block remote images (default: user preference)
 * @param {boolean} [options.blockTrackingPixels] - Block tracking pixels (default: user preference, on)
 * @returns {string} Safe HTML for display in the compose window
 */
export function sanitizeQuotedHtml(html, options = {}) {
  if (!html || typeof html !== 'string') return '';

  let { blockRemoteImages, blockTrackingPixels } = options;
  if (blockRemoteImages === undefined)
    blockRemoteImages = Local.get('block_remote_images') === 'true';
  if (blockTrackingPixels === undefined)
    blockTrackingPixels = Local.get('block_tracking_pixels') !== 'false';

  const purified = DOMPurify.sanitize(html, {
    FORBID_TAGS: QUOTE_FORBID_TAGS,
    ADD_ATTR: ['data-original-src', 'data-tracking-pixel'],
  });
  if (!purified || typeof DOMParser === 'undefined') return '';

  // Edit in an inert document: an element created by the live document starts
  // fetching its src even while detached, which is exactly what this prevents.
  const doc = new DOMParser().parseFromString(purified, 'text/html');
  if (!doc.body) return '';

  for (const el of doc.body.querySelectorAll('*')) {
    const style = el.getAttribute('style');
    if (style) {
      const cleaned = stripFetchingDeclarations(style);
      if (cleaned === null) el.removeAttribute('style');
      else if (cleaned !== style.trim()) el.setAttribute('style', cleaned);
    }

    for (const attr of ['background', 'poster', 'lowsrc', 'dynsrc', 'longdesc']) {
      const value = el.getAttribute(attr);
      if (value && REMOTE_REF.test(value)) el.removeAttribute(attr);
    }

    // srcset candidates are fetched in preference to src
    if (el.hasAttribute('srcset') && /(?:https?:)?\/\//i.test(el.getAttribute('srcset') || ''))
      el.removeAttribute('srcset');

    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      if (REMOTE_REF.test(src)) {
        const pixel = isHiddenOrTiny(el);
        if ((pixel && blockTrackingPixels) || (!pixel && blockRemoteImages)) {
          el.removeAttribute('src');
          el.setAttribute('data-original-src', src);
          if (pixel) el.setAttribute('data-tracking-pixel', 'true');
        }
      } else if (
        src &&
        !/^\s*(?:data:|cid:|blob:)/i.test(src) &&
        /^\s*[a-z][a-z0-9+.-]*:/i.test(src)
      ) {
        // any other scheme (ftp:, file:, …) has no business loading here
        el.removeAttribute('src');
      }
    }
  }

  return doc.body.innerHTML;
}
