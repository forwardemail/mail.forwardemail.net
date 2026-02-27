/**
 * Forward Email – Favicon Badge
 *
 * Canvas-based badge overlay on the existing favicon to display unread
 * message count in the browser tab.
 *
 * Works by:
 * 1. Loading the original favicon into an off-screen canvas
 * 2. Drawing a red circle with the count number on top
 * 3. Replacing the favicon <link> href with the canvas data URL
 *
 * When the count is 0, the original favicon is restored.
 *
 * Hardening:
 *   - Count is bounds-checked (0–99999).
 *   - Canvas operations are wrapped in try/catch for CSP restrictions.
 *   - Original favicon href is cached to allow clean restoration.
 *   - Only runs in browser context (no-op in SSR/Tauri).
 */

import { isTauri } from './platform.js';

// ── State ──────────────────────────────────────────────────────────────────

let originalFaviconHref = null;
let faviconLinkElement = null;
let cachedFaviconImage = null;
let currentCount = 0;

// Reusable off-screen canvas and context to avoid per-update allocation
let _canvas = null;
let _ctx = null;

function getCanvas() {
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _ctx = _canvas.getContext('2d');
  }
  return { canvas: _canvas, ctx: _ctx };
}

// ── Constants ──────────────────────────────────────────────────────────────

const BADGE_BG_COLOR = '#ef4444'; // red-500
const BADGE_TEXT_COLOR = '#ffffff';
const CANVAS_SIZE = 64; // Favicon rendered at 64x64 for clarity
const BADGE_RADIUS_RATIO = 0.28; // Badge circle radius relative to canvas
const BADGE_FONT_SIZE_RATIO = 0.3; // Font size relative to canvas
const BADGE_OFFSET_X = 0.72; // Badge center X position (right side)
const BADGE_OFFSET_Y = 0.28; // Badge center Y position (top side)
const MAX_BADGE_COUNT = 99999;

// ── Helpers ────────────────────────────────────────────────────────────────

function getFaviconLink() {
  if (faviconLinkElement) return faviconLinkElement;

  // Look for existing favicon link
  faviconLinkElement =
    document.querySelector('link[rel="icon"]') ||
    document.querySelector('link[rel="shortcut icon"]');

  if (!faviconLinkElement) {
    // Create one if it doesn't exist
    faviconLinkElement = document.createElement('link');
    faviconLinkElement.rel = 'icon';
    faviconLinkElement.type = 'image/png';
    document.head.appendChild(faviconLinkElement);
  }

  // Cache the original href for restoration
  if (!originalFaviconHref && faviconLinkElement.href) {
    originalFaviconHref = faviconLinkElement.href;
  }

  return faviconLinkElement;
}

function loadFaviconImage() {
  return new Promise((resolve, reject) => {
    if (cachedFaviconImage) {
      resolve(cachedFaviconImage);
      return;
    }

    const link = getFaviconLink();
    const src = originalFaviconHref || link.href;

    if (!src) {
      reject(new Error('No favicon source'));
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      cachedFaviconImage = img;
      resolve(img);
    };
    img.onerror = () => reject(new Error('Failed to load favicon'));
    img.src = src;
  });
}

function formatBadgeText(count) {
  if (count <= 0) return '';
  if (count > 999) return '999+';
  return String(count);
}

function drawBadge(canvas, ctx, img, count) {
  const size = CANVAS_SIZE;
  canvas.width = size;
  canvas.height = size;

  // Clear and draw original favicon
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);

  if (count <= 0) return;

  const text = formatBadgeText(count);
  const badgeRadius = size * BADGE_RADIUS_RATIO;
  const centerX = size * BADGE_OFFSET_X;
  const centerY = size * BADGE_OFFSET_Y;

  // Adjust badge size for longer text
  const extraWidth = text.length > 2 ? (text.length - 2) * (size * 0.08) : 0;

  // Draw badge background (pill shape for long text, circle for short)
  ctx.beginPath();
  if (extraWidth > 0) {
    // Pill shape
    const left = centerX - badgeRadius - extraWidth / 2;
    const right = centerX + badgeRadius + extraWidth / 2;
    const top = centerY - badgeRadius;
    const bottom = centerY + badgeRadius;
    ctx.moveTo(left + badgeRadius, top);
    ctx.lineTo(right - badgeRadius, top);
    ctx.arc(right - badgeRadius, centerY, badgeRadius, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(left + badgeRadius, bottom);
    ctx.arc(left + badgeRadius, centerY, badgeRadius, Math.PI / 2, -Math.PI / 2);
  } else {
    ctx.arc(centerX, centerY, badgeRadius, 0, Math.PI * 2);
  }
  ctx.fillStyle = BADGE_BG_COLOR;
  ctx.fill();

  // Draw white border
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = size * 0.03;
  ctx.stroke();

  // Draw text
  const fontSize = Math.round(size * BADGE_FONT_SIZE_RATIO);
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = BADGE_TEXT_COLOR;
  ctx.fillText(text, centerX, centerY + 1); // +1 for visual centering
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Update the favicon badge with the given unread count.
 * Pass 0 to clear the badge and restore the original favicon.
 *
 * @param {number} count - Unread message count (0 to clear)
 */
export async function updateFaviconBadge(count) {
  // No-op outside browser or in Tauri (Tauri uses native badge)
  if (typeof document === 'undefined') return;
  if (isTauri) return;

  const n =
    typeof count === 'number' ? Math.max(0, Math.min(Math.round(count), MAX_BADGE_COUNT)) : 0;

  // Skip if count hasn't changed
  if (n === currentCount) return;
  currentCount = n;

  try {
    const link = getFaviconLink();

    if (n === 0) {
      // Restore original favicon
      if (originalFaviconHref) {
        link.href = originalFaviconHref;
      }
      return;
    }

    const img = await loadFaviconImage();
    const { canvas, ctx } = getCanvas();
    if (!ctx) return;

    drawBadge(canvas, ctx, img, n);

    // Update favicon
    link.href = canvas.toDataURL('image/png');
  } catch (err) {
    // Canvas operations may fail due to CSP or CORS
    console.warn('[favicon-badge] Failed to update badge:', err);
  }
}

/**
 * Clear the favicon badge and restore the original favicon.
 */
export async function clearFaviconBadge() {
  return updateFaviconBadge(0);
}

/**
 * Get the current badge count.
 */
export function getFaviconBadgeCount() {
  return currentCount;
}

/**
 * Reset the cached favicon image (e.g., after theme change).
 */
export function resetFaviconCache() {
  cachedFaviconImage = null;
  originalFaviconHref = null;
  faviconLinkElement = null;
  _canvas = null;
  _ctx = null;
  currentCount = -1; // Force re-render on next update
}
