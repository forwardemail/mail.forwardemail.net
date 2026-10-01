/**
 * The pieces that let the webmail run on TermDOM, exercised against a real
 * TermDOM document: storage, CSS length conversion, message frames, the
 * DOM fixes DOMPurify and Svelte need, downloads, and the app's view of
 * the viewport.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TermDOM } from '@b9g/termdom';
import createDOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import { installAnimations, installDomFixes } from '../../src/cli/dom-fixes';
import { installFrames } from '../../src/cli/frames';
import { createImageConstructor } from '../../src/cli/images';
import { bytesFor, displayCombo } from '../../src/cli/hints';
import { installLinks, safeFileName, writeUnique } from '../../src/cli/links';
import { MAX_SHOWN, installOriginalViewer } from '../../src/cli/original';
import {
  insertAfterRule,
  opaqueColors,
  pruneCustomProperties,
  pruneStylesheet,
} from '../../src/cli/prune-css.js';
import {
  convertDeclarations,
  convertMediaQuery,
  convertStylesheet,
} from '../../src/cli/px-to-cells.js';
import { thumbPlacement } from '../../src/cli/scrollbars';
import { createStorage } from '../../src/cli/storage';
import { createPgpModal } from '../../src/utils/pgp-key-prompt';
import { wrappedRows } from '../../src/cli/textareas';
import { createAppWindow, installGeometry } from '../../src/cli/viewport';

const quietTransport = (cols = 80, rows = 24) => ({
  cols,
  rows,
  colorDepth: 'rgb',
  interactive: false,
  sharesScreen: false,
  readable: new ReadableStream({}),
  writable: new WritableStream({}),
  resizes: new ReadableStream({}),
  ready: Promise.resolve(),
  closed: new Promise(() => {}),
  close() {},
});

// eslint-disable-next-line no-control-regex -- ANSI escapes start with ESC
const plain = (ansi) => ansi.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');

describe('new Image()', () => {
  // The way bits-ui's Avatar preloads a contact photo: src first, handlers after.
  const preload = (Image, src) =>
    new Promise((resolve) => {
      const img = new Image();
      img.src = src;
      img.onload = () => resolve({ img, result: 'load' });
      img.onerror = () => resolve({ img, result: 'error' });
    });

  it('creates an <img> that reports it could not load, after the handlers are set', async () => {
    const win = new TermDOM({ transport: quietTransport() }).window;
    const Image = createImageConstructor(win);
    const { img, result } = await preload(Image, 'data:image/png;base64,iVBORw0KGgo=');
    expect(result).toBe('error');
    expect(img).toBeInstanceOf(win.HTMLImageElement);
    expect(img.tagName).toBe('IMG');
    expect(img.src).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(img.complete).toBe(true);
    expect(img.naturalWidth).toBe(0);
  });

  it('takes a size, and sends nothing for an empty src or a replaced one', async () => {
    const win = new TermDOM({ transport: quietTransport() }).window;
    const Image = createImageConstructor(win);
    const sized = new Image(64, 32);
    expect([sized.width, sized.height]).toEqual([64, 32]);

    const img = new Image();
    let errors = 0;
    img.addEventListener('error', () => errors++);
    img.src = '';
    img.src = 'https://example.com/a.png';
    img.src = 'https://example.com/b.png';
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(errors).toBe(1);
  });
});

describe('localStorage', () => {
  it('persists to a private file and reads back in a new session', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-storage-'));
    const file = path.join(dir, 'local-storage.json');
    const first = createStorage(file);
    first.setItem('webmail_email', 'user@example.com');
    first.theme = 'dark';
    first.setItem('gone', 'x');
    first.removeItem('gone');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      webmail_email: 'user@example.com',
      theme: 'dark',
    });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    const second = createStorage(file);
    expect(second.getItem('webmail_email')).toBe('user@example.com');
    expect(second.theme).toBe('dark');
    expect(second.length).toBe(2);
    expect(second.getItem('missing')).toBeNull();
    expect(Object.keys(second).sort()).toEqual(['theme', 'webmail_email']);
  });
});

describe('CSS lengths to cells', () => {
  it('converts per axis: 8px columns, 16px rows, rem as 16px', () => {
    const css = convertStylesheet(
      '.a{width:240px;height:64px;padding:1rem;margin:8px 16px;gap:calc(var(--spacing)*4)}',
    );
    expect(css).toContain('width:30px');
    expect(css).toContain('height:4px');
    expect(css).toContain('padding:1px 2px');
    expect(css).toContain('margin:0px 2px');
    expect(css).toContain('gap:1px 2px');
  });

  it('keeps borders one cell, drops font sizes, and converts media queries', () => {
    const css = convertStylesheet(
      '@media (min-width:821px){.a{border:2px solid red;font-size:14px;line-height:1.5}}',
    );
    expect(css).toContain('border:1px solid red');
    expect(css).not.toContain('font-size');
    expect(css).not.toContain('line-height');
    expect(css).toContain('(min-width:102.625px)');
    expect(convertMediaQuery('(max-width: 640px)')).toBe('(max-width: 80px)');
  });

  it('gives length custom properties a row twin for vertical use', () => {
    const css = convertStylesheet(':root{--gap:16px}.a{padding-top:var(--gap);width:var(--gap)}');
    expect(css).toContain('--gap:2px');
    expect(css).toContain('--gap-v:1px');
    expect(css).toContain('padding-top:var(--gap-v)');
    expect(css).toContain('width:var(--gap)');
  });

  it('converts inline styles', () => {
    expect(convertDeclarations('width:240px;min-width:240px')).toBe('width:30px;min-width:30px');
  });

  it('prunes what a terminal cannot draw and custom properties nothing reads', () => {
    const pruned = pruneCustomProperties(
      pruneStylesheet(
        '*,:before,:after{--tw-x:0}@keyframes k{to{opacity:1}}.a{box-shadow:0 0 1px red;color:red;--used:1;--unused:2}.b{width:var(--used)}@media print{.c{color:blue}}',
      ),
    );
    expect(pruned).toBe('.a{color:red;--used:1}.b{width:var(--used)}');
  });

  it('blends translucent colors with the page background', () => {
    // Tailwind's bg-muted/50 and friends, and rgb()/hsl() with an alpha.
    expect(opaqueColors('color-mix(in oklab,var(--muted) 50%,transparent)')).toBe(
      'color-mix(in oklab,var(--muted) 50%, var(--background))',
    );
    expect(opaqueColors('rgb(37 99 235/.18)')).toBe(
      'color-mix(in srgb, rgb(37 99 235) 18%, var(--background))',
    );
    expect(opaqueColors('rgba(0, 0, 0, 0.5)')).toBe(
      'color-mix(in srgb, rgb(0, 0, 0) 50%, var(--background))',
    );
    // Spaces with more than one word; a "transparent" after the color-mix
    // is not its argument; fully transparent paints nothing.
    expect(opaqueColors('color-mix(in oklch shorter hue, var(--a) 20%, transparent)')).toBe(
      'color-mix(in oklch shorter hue, var(--a) 20%, var(--background))',
    );
    expect(opaqueColors('linear-gradient(color-mix(in oklab, red 50%, blue), transparent)')).toBe(
      'linear-gradient(color-mix(in oklab, red 50%, blue), transparent)',
    );
    expect(opaqueColors('rgba(0, 0, 0, 0)')).toBe('transparent');
    expect(opaqueColors('rgb(0 0 0 / 0%)')).toBe('transparent');
    // Opaque colors and plain transparent are left alone.
    expect(opaqueColors('rgb(1 2 3)')).toBe('rgb(1 2 3)');
    expect(opaqueColors('rgba(1, 2, 3, 1)')).toBe('rgba(1, 2, 3, 1)');
    expect(opaqueColors('transparent')).toBe('transparent');
    // Applied by the stylesheet pruning, except to --background itself.
    expect(pruneStylesheet('.a{background:rgb(0 0 0/.5)}:root{--background:rgb(0 0 0/.5)}')).toBe(
      '.a{background:color-mix(in srgb, rgb(0 0 0) 50%, var(--background))}:root{--background:rgb(0 0 0/.5)}',
    );
  });

  it('draws transparent elements as hidden and the rest as visible', () => {
    const css = pruneStylesheet(
      '.a{opacity:0}.b{opacity:0%}.c{opacity:.5}.d:hover{opacity:1!important}',
    );
    expect(css).toBe(
      '.a{visibility:hidden}.b{visibility:hidden}.c{visibility:visible}.d:hover{visibility:visible!important}',
    );
    const term = new TermDOM({ transport: quietTransport() });
    expect(
      plain(term.renderANSI(`<style>${css}</style><div>A<span class="a">B</span>C</div>`)),
    ).toBe('A C\n');
  });

  it('places the terminal display fixes so responsive utilities still win', () => {
    const utilities = fs.readFileSync(path.resolve('src/cli/terminal-utilities.css'), 'utf8');
    const css = insertAfterRule(
      '@layer utilities{.flex{display:flex}.inline-flex{display:inline-flex}@media (min-width:96px){.md\\:hidden{display:none}}}',
      '.inline-flex',
      utilities,
    );
    expect(css.indexOf(':where(.flex')).toBeGreaterThan(css.indexOf('.inline-flex{'));
    expect(css.indexOf(':where(.flex')).toBeLessThan(css.indexOf('.md\\:hidden'));

    const markup = `<style>${css}</style><div class="flex"><span class="inline-flex">AAA</span><span class="inline-flex md:hidden">BBB</span></div>`;
    // 120 columns is md (768 virtual px) and up: md:hidden applies.
    expect(plain(new TermDOM({ transport: quietTransport(120, 5) }).renderANSI(markup))).toBe(
      'AAA\n',
    );
    expect(plain(new TermDOM({ transport: quietTransport(80, 5) }).renderANSI(markup))).toBe(
      'AAABBB\n',
    );
    expect(() => insertAfterRule('.a{color:red}', '.missing', '.b{color:blue}')).toThrow();
  });
});

describe('message frames', () => {
  it('lays out an iframe srcdoc inside the frame, with scoped styles and linked clicks', async () => {
    const term = new TermDOM({ transport: quietTransport() });
    const win = term.window;
    installFrames(win);
    const messages = [];
    win.addEventListener('message', (event) => messages.push(event.data));

    const frame = term.document.createElement('iframe');
    frame.className = 'fe-email-iframe';
    term.document.body.append(frame);
    frame.srcdoc =
      '<!DOCTYPE html><html class="fe-iframe-dark"><head><style>body{margin:0} p{padding-left:16px}</style>' +
      '<script src="/email-iframe.js"></script></head><body><p>Hello from the message</p>' +
      '<a href="https://forwardemail.net/">a link</a><script>alert(1)</script></body></html>';
    await new Promise((resolve) => setTimeout(resolve, 20));

    const view = frame.querySelector('.fe-frame-view');
    expect(view).toBeTruthy();
    const root = view.shadowRoot.querySelector('.fe-frame-root');
    expect(root.className).toContain('fe-iframe-dark');
    expect(root.textContent).toContain('Hello from the message');
    expect(view.shadowRoot.querySelector('script')).toBeNull();
    expect(view.shadowRoot.querySelector('style').textContent).toContain('padding-left:2px');
    expect(messages.map((message) => message.type)).toEqual(['ready', 'height']);

    root.querySelector('a').click();
    expect(messages.at(-1)).toEqual({
      type: 'link',
      payload: { url: 'https://forwardemail.net/', isMailto: false },
    });
  });
});

describe('DOM fixes', () => {
  it('lets DOMPurify sanitize on the terminal DOM', () => {
    const term = new TermDOM({ transport: quietTransport() });
    installDomFixes(term.window);
    const purify = createDOMPurify(term.window);
    expect(
      purify.sanitize(
        '<p onclick="x()">Hi <b>there</b><script>alert(1)</script><img src=x onerror=y()></p>',
      ),
    ).toBe('<p>Hi <b>there</b><img src="x"></p>');
  });

  it('finishes element animations at once, as Svelte transitions expect', async () => {
    const term = new TermDOM({ transport: quietTransport() });
    installAnimations(term.window);
    const el = term.document.createElement('div');
    const animation = el.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 300,
      fill: 'forwards',
    });
    const events = [];
    animation.onfinish = (event) => events.push(event.type);
    animation.addEventListener('finish', () => events.push('listener'));
    expect(await animation.finished).toBe(animation);
    expect(events).toEqual(['finish', 'listener']);
    expect(animation.playState).toBe('finished');
    expect(animation.currentTime).toBe(300);

    const cancelled = el.animate([], 100);
    let finished = false;
    cancelled.onfinish = () => {
      finished = true;
    };
    cancelled.cancel();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    expect(cancelled.playState).toBe('idle');
    expect(el.getAnimations()).toEqual([]);
  });
});

describe('downloads', () => {
  it('saves an <a download> of a blob to the downloads folder without overwriting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-downloads-'));
    const term = new TermDOM({ transport: quietTransport() });
    const win = term.window;
    installLinks(win, () => dir);
    const toasts = [];
    win.addEventListener('fe:mail-service-toast', (event) => toasts.push(event.detail));

    // As the webmail saves a file: click, then revoke the URL at once.
    const download = (content, name) => {
      const url = URL.createObjectURL(new Blob([content]));
      const link = term.document.createElement('a');
      link.href = url;
      link.download = name;
      term.document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    };
    download('BEGIN:VCARD', 'Alice.vcf');
    download('second', 'Alice.vcf');
    download('sneaky', '../../etc/passwd');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fs.readdirSync(dir).sort()).toEqual(['Alice (1).vcf', 'Alice.vcf', 'passwd']);
    expect(fs.readFileSync(path.join(dir, 'Alice.vcf'), 'utf8')).toBe('BEGIN:VCARD');
    expect(fs.readFileSync(path.join(dir, 'Alice (1).vcf'), 'utf8')).toBe('second');
    expect(toasts[0]).toEqual({
      message: `Saved to ${path.join(dir, 'Alice.vcf')}`,
      type: 'success',
    });
  });

  it('makes file names safe on every system', () => {
    expect(safeFileName('a/b\\c.txt')).toBe('c.txt');
    expect(safeFileName('re: "plan"?.pdf')).toBe('re_ _plan__.pdf');
    expect(safeFileName('..')).toBe('download');
    expect(safeFileName('')).toBe('download');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-unique-'));
    expect(path.basename(writeUnique(dir, 'x', new Uint8Array([1])))).toBe('x');
    expect(path.basename(writeUnique(dir, 'x', new Uint8Array([2])))).toBe('x (1)');
  });
});

// installGeometry patches the engine's shared prototypes, so it runs once.
let geometryInstalled = false;
function geometry(win) {
  if (!geometryInstalled) installGeometry(win);
  geometryInstalled = true;
}

describe('viewport', () => {
  it('reports the terminal in virtual pixels and converts media queries and inline styles', () => {
    const term = new TermDOM({ transport: quietTransport(120, 40) });
    const win = term.window;
    geometry(win);
    const app = createAppWindow(win);

    // innerWidth is 0 until attached; the proxy scales whatever the engine reports.
    expect(app.innerWidth).toBe(win.innerWidth * 8);
    expect(app.innerHeight).toBe(win.innerHeight * 16);
    expect(app.window).toBe(app);

    const el = term.document.createElement('div');
    el.style.width = '240px';
    expect(el.getAttribute('style')).toContain('width: 30px');
    expect(el.style.width).toBe('240px');
    el.setAttribute('style', 'height: 32px');
    expect(el.getAttribute('style')).toBe('height:2px');

    term.document.body.append(el);
    expect(plain(term.renderANSI('<div style="padding-left:1ch">x</div>')).startsWith(' x')).toBe(
      true,
    );
  });
});

describe('hint bar keys', () => {
  it('writes shortcuts the way the bar shows them', () => {
    expect(displayCombo('ctrl + n')).toBe('Ctrl+N');
    expect(displayCombo('shift + r')).toBe('Shift+R');
    expect(displayCombo('delete')).toBe('Del');
    expect(displayCombo('?')).toBe('?');
    expect(displayCombo('r')).toBe('r');
    expect(displayCombo('ctrl + shift + u')).toBe('Ctrl+Shift+U');
  });

  it('turns a shortcut into what a terminal sends for it', () => {
    expect(bytesFor('ctrl + n')).toBe('\x0e');
    expect(bytesFor('r')).toBe('r');
    expect(bytesFor('shift + r')).toBe('R');
    expect(bytesFor('?')).toBe('?');
    expect(bytesFor('delete')).toBe('\x1b[3~');
    expect(bytesFor('esc')).toBe('\x1b');
    // Combinations a terminal cannot send are not pressed.
    expect(bytesFor('ctrl + shift + u')).toBeNull();
    expect(bytesFor('alt + x')).toBeNull();
    expect(bytesFor('ctrl + s')).toBe('\x13');
    expect(bytesFor('ctrl + y')).toBe('\x19');
    expect(bytesFor('shift + tab')).toBe('\x1b[Z');
    // Ctrl+M is Enter to a terminal, so it is not pressed as Ctrl+M.
    expect(bytesFor('ctrl + m')).toBeNull();
  });
});

describe('scroll bar thumb', () => {
  it('is as long as the share of the content on screen', () => {
    // 10 rows of 40 on screen: a quarter of the track.
    expect(thumbPlacement(20, 10, 40, 0)).toEqual({ thumbTop: 0, thumbRows: 5 });
    // At least one row, however long the content.
    expect(thumbPlacement(20, 10, 10_000, 0).thumbRows).toBe(1);
  });

  it('sits at the ends only when the box is scrolled to them', () => {
    expect(thumbPlacement(20, 10, 40, 30)).toEqual({ thumbTop: 15, thumbRows: 5 });
    // One row scrolled in a long list leaves the top; one row short of the
    // end does not reach the bottom.
    expect(thumbPlacement(20, 10, 1000, 1).thumbTop).toBe(1);
    expect(thumbPlacement(20, 10, 1000, 989).thumbTop).toBe(18);
    expect(thumbPlacement(20, 10, 1000, 990).thumbTop).toBe(19);
  });
});

describe('text area rows', () => {
  it('counts lines, including an empty last line', () => {
    expect(wrappedRows('', 20)).toBe(1);
    expect(wrappedRows('one\ntwo', 20)).toBe(2);
    expect(wrappedRows('one\n', 20)).toBe(2);
  });

  it('wraps at spaces, lets spaces hang, and breaks words longer than the line', () => {
    expect(wrappedRows('aaaa bbbb cccc', 9)).toBe(2);
    expect(wrappedRows('aaaa     ', 4)).toBe(1);
    expect(wrappedRows('abcdefghij', 4)).toBe(3);
    expect(wrappedRows('ab abcdefghij', 4)).toBe(4);
  });

  it('counts wide characters as two columns, each a place to break', () => {
    expect(wrappedRows('日本語のテキスト', 8)).toBe(2);
    expect(wrappedRows('ab 日本語のテキストです', 12)).toBe(2);
  });

  it('moves a tab to the next stop of eight, wrapping when it does not fit', () => {
    expect(wrappedRows('a\tb', 12)).toBe(1);
    expect(wrappedRows('a\tb\tc\td\te', 12)).toBe(4);
    expect(wrappedRows('\t\t\tword', 12)).toBe(3);
  });

  it('wraps text the way TermDOM wraps a text area', async () => {
    const dom = new TermDOM({ transport: quietTransport(40, 30) });
    // A box styled as the engine styles a text area's text. A one-row box
    // gives the row height, whatever units an earlier test left rects in.
    dom.document.body.innerHTML =
      '<div id="row" style="height: 1px"></div>' +
      '<div id="copy" style="width: 12ch; white-space: pre-wrap; overflow-wrap: break-word"></div>';
    const copy = dom.document.getElementById('copy');
    const row = dom.document.getElementById('row').getBoundingClientRect().height;
    for (const text of [
      'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs.',
      'one\n\nSupercalifragilisticexpialidocious!',
      'a\tb\tc\td\te',
      '\t\t\tword',
      'ab 日本語のテキストです',
    ]) {
      copy.textContent = text;
      expect({ text, rows: copy.getBoundingClientRect().height / row }).toEqual({
        text,
        rows: wrappedRows(text, 12),
      });
    }
    dom.dispose?.();
  });
});

describe('the missing PGP key prompt in a terminal', () => {
  it('fits an 80 by 24 terminal with both buttons on screen', () => {
    const term = new TermDOM({ transport: quietTransport(80, 24) });
    geometry(term.window);
    const saved = globalThis.document;
    globalThis.document = term.document;
    try {
      createPgpModal({});
    } finally {
      globalThis.document = saved;
    }
    // Rects reach scripts in virtual pixels: 8 per column, 16 per row.
    const rows = (el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top / 16, bottom: rect.bottom / 16 };
    };
    const dialog = term.document.querySelector('.fe-modal');
    expect(rows(dialog).bottom).toBeLessThanOrEqual(24);
    for (const button of dialog.querySelectorAll('button')) {
      expect(rows(button).top).toBeGreaterThanOrEqual(0);
      expect(rows(button).bottom).toBeLessThanOrEqual(24);
      // A button is one row of text, not 16 rows of padding.
      expect(rows(button).bottom - rows(button).top).toBeLessThanOrEqual(3);
    }
  });
});

describe('the original message viewer', () => {
  // Keys typed into the terminal, so Tab, Enter and typing take the paths a
  // user's keys take.
  function typedTerminal() {
    let type;
    const readable = new ReadableStream({
      start(controller) {
        type = (text) => controller.enqueue(text);
      },
    });
    const term = new TermDOM({
      html: '<body><button id="delete">Delete</button><input id="field"></body>',
      transport: {
        ...quietTransport(80, 24),
        interactive: true,
        readable,
      },
    });
    return { term, type: (text) => type(text) };
  }
  const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  it('keeps keys away from the page behind it until it is closed', async () => {
    const { term, type } = typedTerminal();
    const win = term.window;
    const viewer = installOriginalViewer(win);
    let deleted = 0;
    term.document.querySelector('#delete').addEventListener('click', () => deleted++);
    await term.attach();
    try {
      term.document.querySelector('#field').focus();
      win.dispatchEvent(
        new win.CustomEvent('fe:view-original', {
          detail: { raw: 'Subject: Hi\r\n\r\nBody', subject: 'Hi' },
        }),
      );
      expect(viewer.isOpen()).toBe(true);
      const overlay = term.document.querySelector('#fe-terminal-original');
      const labels = () => term.document.activeElement?.textContent;
      expect(labels()).toBe('Close');

      // Tab goes round the viewer's buttons, both ways.
      for (const expected of ['Save .eml', 'Copy raw', 'Close', 'Save .eml']) {
        type('\t');
        await tick();
        expect(labels()).toBe(expected);
      }
      type('\x1b[Z');
      await tick();
      expect(labels()).toBe('Close');

      // Focus moved behind the viewer some other way: keys still do nothing there.
      term.document.querySelector('#delete').focus();
      type('\r');
      await tick();
      term.document.querySelector('#delete').focus();
      type(' ');
      await tick();
      term.document.querySelector('#field').focus();
      type('x');
      await tick();
      expect(deleted).toBe(0);
      expect(term.document.querySelector('#field').value).toBe('');
      expect(viewer.isOpen()).toBe(true);
      expect(overlay.contains(term.document.activeElement)).toBe(true);

      // Esc closes it and gives focus back.
      type('\x1b');
      await tick(150);
      expect(viewer.isOpen()).toBe(false);
      expect(term.document.querySelector('#fe-terminal-original')).toBeNull();
    } finally {
      await term.dispose();
    }
  });

  it('shows the start of a very large message and says where the rest is', () => {
    const term = new TermDOM({ transport: quietTransport() });
    installOriginalViewer(term.window);
    const raw = `Subject: Big\r\n\r\n${'A'.repeat(MAX_SHOWN * 4)}`;
    term.window.dispatchEvent(
      new term.window.CustomEvent('fe:view-original', { detail: { raw, subject: 'Big' } }),
    );
    const shown = term.document.querySelectorAll('#fe-terminal-original pre')[1].textContent;
    expect(shown.length).toBeLessThan(MAX_SHOWN + 200);
    expect(shown).toContain('Save .eml for the full message');
  });
});
