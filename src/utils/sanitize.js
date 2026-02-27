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
      processedHtml = html.replace(/<img([^>]*)>/gi, (match, attributes) => {
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

    const sanitized = DOMPurify.sanitize(processedHtml, {
      USE_PROFILES: { html: true },
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      ADD_ATTR: ['data-original-src', 'data-tracking-pixel'],
      HOOKS: {
        afterSanitizeAttributes: (node) => {
          // Ensure links open in new tab and are safe
          if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        },
      },
    });

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

    return restoredHtml;
  } catch (error) {
    console.error('Failed to restore images:', error);
    return html;
  }
}
