/**
 * Shrink-to-fit behaviour of the email iframe runtime.
 *
 * Marketing email is authored at a fixed desktop width and cannot reflow, so
 * on a phone it overflows sideways and the document height belongs to that
 * wide layout — the reader scrolls through a very tall, half-visible email.
 * public/email-iframe.js scales the body down to the viewport width and pins
 * the painted height on .fe-email-viewport.
 *
 * The script is the real artifact shipped to the iframe, so it is evaluated
 * here in an isolated JSDOM rather than reimplemented. JSDOM does no layout,
 * so the metrics the fit pass reads are stubbed to model a 720px-wide email
 * in a 390px-wide phone viewport.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let runtimeSource;
const openWindows = [];

beforeAll(() => {
  runtimeSource = readFileSync(path.join(projectRoot, 'public/email-iframe.js'), 'utf8');
});

afterEach(() => {
  // The runtime keeps timers and a resize listener alive for the life of the
  // document; close each one so they don't bleed into the next case.
  while (openWindows.length) openWindows.pop().close();
});

/**
 * Boot the runtime against a document whose layout metrics are stubbed.
 *
 * @param {object} layout
 * @param {number} layout.viewportWidth  width of the iframe, in CSS px
 * @param {number} layout.naturalWidth   width the email lays out at unscaled
 * @param {number} layout.naturalHeight  height the email lays out at unscaled
 */
async function renderEmail({ viewportWidth, naturalWidth, naturalHeight }) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
       <div class="fe-email-viewport"><div class="fe-email-content"></div></div>
     </body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true },
  );

  const { window } = dom;
  const viewport = window.document.querySelector('.fe-email-viewport');
  const content = window.document.querySelector('.fe-email-content');

  Object.defineProperty(window.document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => viewportWidth,
  });

  // scrollWidth exposes the sideways overflow; offsetWidth is the clamped box
  // until the fit pass pins an explicit width. Both ignore transforms, which
  // is exactly why the fit pass can measure without undoing its own scale.
  Object.defineProperty(content, 'scrollWidth', {
    configurable: true,
    get: () => naturalWidth,
  });
  Object.defineProperty(content, 'offsetWidth', {
    configurable: true,
    get: () => (content.style.width ? Number.parseFloat(content.style.width) : viewportWidth),
  });
  Object.defineProperty(content, 'offsetHeight', {
    configurable: true,
    get: () => naturalHeight,
  });

  // The pinned height is what the parent is told to size the iframe to.
  viewport.getBoundingClientRect = () => ({
    height: viewport.style.height ? Number.parseFloat(viewport.style.height) : naturalHeight,
    width: viewportWidth,
    top: 0,
    left: 0,
    right: viewportWidth,
    bottom: 0,
    x: 0,
    y: 0,
  });

  const heights = [];
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'height') heights.push(event.data.payload.height);
  });

  openWindows.push(window);
  window.eval(runtimeSource);

  // The first height report is scheduled on a zero-delay timer, and the fit
  // pass runs as part of it. JSDOM timers are real, so yield to them.
  await new Promise((resolve) => setTimeout(resolve, 25));

  return { window, viewport, content, heights };
}

const scaleOf = (content) => {
  const match = /scale\(([\d.]+)\)/.exec(content.style.transform);
  return match ? Number.parseFloat(match[1]) : 1;
};

describe('email iframe shrink-to-fit', () => {
  it('scales a 720px email down to a 390px viewport', async () => {
    const { content } = await renderEmail({
      viewportWidth: 390,
      naturalWidth: 720,
      naturalHeight: 2189,
    });

    expect(scaleOf(content)).toBeCloseTo(390 / 720, 5);
    expect(content.style.transformOrigin).toBe('0 0');
  });

  it('pins the width it scaled against so the max-width clamp cannot fight it', async () => {
    const { content } = await renderEmail({
      viewportWidth: 390,
      naturalWidth: 720,
      naturalHeight: 2189,
    });

    expect(content.style.width).toBe('720px');
    expect(content.style.maxWidth).toBe('none');
  });

  it('collapses the document height to what is actually painted', async () => {
    // The whole point: without this the reader scrolls the full 2189px of a
    // layout only 54% of which is on screen.
    const { viewport } = await renderEmail({
      viewportWidth: 390,
      naturalWidth: 720,
      naturalHeight: 2189,
    });

    expect(viewport.style.height).toBe(`${Math.ceil(2189 * (390 / 720))}px`);
    expect(Number.parseFloat(viewport.style.height)).toBeLessThan(2189);
  });

  it('reports the scaled height to the parent, not the unscaled one', async () => {
    const { heights } = await renderEmail({
      viewportWidth: 390,
      naturalWidth: 720,
      naturalHeight: 2189,
    });

    expect(heights.length).toBeGreaterThan(0);
    expect(heights.at(-1)).toBe(Math.ceil(2189 * (390 / 720)));
  });

  it('leaves an email that already fits untouched', async () => {
    const { viewport, content } = await renderEmail({
      viewportWidth: 800,
      naturalWidth: 720,
      naturalHeight: 900,
    });

    expect(content.style.transform).toBe('');
    expect(content.style.width).toBe('');
    expect(viewport.style.height).toBe('');
  });

  it('does not scale for sub-pixel overflow', async () => {
    const { content } = await renderEmail({
      viewportWidth: 390,
      naturalWidth: 391,
      naturalHeight: 900,
    });

    expect(content.style.transform).toBe('');
  });

  it('stops shrinking at the legibility floor and lets the body scroll instead', async () => {
    // 390/4000 would be 0.0975 — unreadable. The floor caps the shrink, and
    // the leftover width stays reachable through the body's horizontal scroll.
    const { content, viewport } = await renderEmail({
      viewportWidth: 390,
      naturalWidth: 4000,
      naturalHeight: 1000,
    });

    expect(scaleOf(content)).toBeCloseTo(0.35, 5);
    expect(viewport.style.height).toBe('350px');
  });

  it('skips the fit pass when the iframe has no measurable width', async () => {
    // Reader pane collapsed / display:none — scaling against 0 would divide
    // the email into nothing. A later resize re-runs the pass.
    const { content, viewport } = await renderEmail({
      viewportWidth: 0,
      naturalWidth: 720,
      naturalHeight: 2189,
    });

    expect(content.style.transform).toBe('');
    expect(viewport.style.height).toBe('');
  });
});
