/**
 * Link hover relay in the email iframe runtime.
 *
 * The runtime posts `link-hover` when the pointer or keyboard focus reaches an
 * anchor and `link-hover-end` when it leaves, so the parent can show the full
 * destination in its status bar. As with the shrink-to-fit test, the shipped
 * script is evaluated in JSDOM rather than reimplemented.
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
  while (openWindows.length) openWindows.pop().close();
});

function boot(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const posted = [];
  // The runtime addresses `parent`; give it one that records messages.
  Object.defineProperty(window, 'parent', {
    configurable: true,
    value: { postMessage: (msg) => posted.push(msg) },
  });
  window.eval(runtimeSource);
  openWindows.push(window);
  const hovers = () => posted.filter((m) => m.type === 'link-hover' || m.type === 'link-hover-end');
  return { window, posted, hovers };
}

const mouse = (window, type, target, relatedTarget = null) => {
  target.dispatchEvent(
    new window.MouseEvent(type, { bubbles: true, cancelable: true, relatedTarget }),
  );
};

describe('email iframe link hover relay', () => {
  it('posts the href and visible text when the pointer enters an anchor, and an end on leave', () => {
    const { window, hovers } = boot(
      '<p>See <a id="l" href="https://evil.example/x">  https://paypal.com/login  </a> now</p>',
    );
    const link = window.document.getElementById('l');
    mouse(window, 'mouseover', link);
    expect(hovers()).toEqual([
      {
        type: 'link-hover',
        payload: { url: 'https://evil.example/x', text: 'https://paypal.com/login' },
      },
    ]);
    mouse(window, 'mouseout', link, window.document.body);
    expect(hovers().at(-1)).toEqual({ type: 'link-hover-end', payload: {} });
  });

  it('does not re-post while moving between children of the same anchor', () => {
    const { window, hovers } = boot(
      '<a id="l" href="https://example.org/"><b id="b">bold</b> <i id="i">it</i></a>',
    );
    const b = window.document.getElementById('b');
    const i = window.document.getElementById('i');
    mouse(window, 'mouseover', b);
    mouse(window, 'mouseout', b, i);
    mouse(window, 'mouseover', i);
    expect(hovers()).toHaveLength(1);
    expect(hovers()[0].type).toBe('link-hover');
  });

  it('ends the preview when the pointer moves onto non-link content', () => {
    const { window, hovers } = boot(
      '<a id="l" href="https://example.org/">x</a><p id="p">text</p>',
    );
    mouse(window, 'mouseover', window.document.getElementById('l'));
    mouse(window, 'mouseover', window.document.getElementById('p'));
    expect(hovers().map((m) => m.type)).toEqual(['link-hover', 'link-hover-end']);
  });

  it('relays keyboard focus the same way', () => {
    const { window, hovers } = boot('<a id="l" href="https://example.org/">x</a>');
    const link = window.document.getElementById('l');
    link.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }));
    link.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
    expect(hovers().map((m) => m.type)).toEqual(['link-hover', 'link-hover-end']);
  });

  it('ignores anchors without an href and caps the relayed text', () => {
    const { window, hovers } = boot(
      `<a id="n" name="anchor">no href</a><a id="l" href="https://example.org/">${'x'.repeat(500)}</a>`,
    );
    mouse(window, 'mouseover', window.document.getElementById('n'));
    expect(hovers()).toHaveLength(0);
    mouse(window, 'mouseover', window.document.getElementById('l'));
    expect(hovers()[0].payload.text).toHaveLength(200);
  });
});
