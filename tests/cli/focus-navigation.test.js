/**
 * Keyboard focus after a click (src/cli/focus-navigation.ts), on a TermDOM
 * document driven through its input: mouse reports and key presses as a
 * terminal sends them.
 */
import { TermDOM } from '@b9g/termdom';
import { afterEach, describe, expect, it } from 'vitest';
import { focusableFrom, installFocusNavigation } from '../../src/cli/focus-navigation';

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

// An interactive TermDOM document to click and type into.
async function page(html) {
  let push;
  const readable = new ReadableStream({
    start(controller) {
      push = (text) => controller.enqueue(text);
    },
  });
  const term = new TermDOM({
    html: `<body>${html}</body>`,
    transport: {
      cols: 80,
      rows: 24,
      colorDepth: 'rgb',
      interactive: true,
      sharesScreen: false,
      readable,
      writable: new WritableStream({}),
      resizes: new ReadableStream({}),
      ready: Promise.resolve(),
      closed: new Promise(() => {}),
      close() {},
    },
  });
  installFocusNavigation(term.window);
  await term.attach();
  const document = term.document;
  const at = (selector) => document.querySelector(selector);
  return {
    term,
    document,
    at,
    type: async (keys) => {
      push(keys);
      await tick();
    },
    // A left click on the first cell of an element, as a terminal reports it.
    click: async (el) => {
      const rect = el.getBoundingClientRect();
      const col = Math.floor(rect.left) + 1;
      const row = Math.floor(rect.top) + 1;
      push(`\u001b[<0;${col};${row}M\u001b[<0;${col};${row}m`);
      await tick();
    },
    focusedId: () => document.activeElement?.id || null,
  };
}

let open = [];
afterEach(async () => {
  for (const term of open.splice(0)) await term.dispose();
});
async function start(html) {
  const p = await page(html);
  open.push(p.term);
  return p;
}

describe('the element Tab moves to from a point', () => {
  it('follows document order across a shadow tree, past inert and hidden controls', async () => {
    const { document, at } = await start(
      '<button id="a">A</button>' +
        '<p id="text">Some text <a id="link" href="#x">link</a> more</p>' +
        '<div id="host"></div>' +
        '<div id="gap">gap</div>' +
        '<div inert><button id="inert">I</button></div>' +
        '<button id="hidden" style="display: none">H</button>' +
        '<button id="b">B</button>',
    );
    at('#host').attachShadow({ mode: 'open' }).innerHTML =
      '<p>inside <a id="inner" href="#y">inner</a></p>';
    const id = (point, back) => focusableFrom(document, point, back)?.id;
    const text = at('#text');
    expect(id({ parent: text, next: text.firstChild })).toBe('link');
    expect(id({ parent: text, next: text.lastChild })).toBe('inner');
    // After the shadow tree, its link counts as before the point.
    const gap = at('#gap');
    expect(id({ parent: gap, next: gap.firstChild })).toBe('b');
    expect(id({ parent: gap, next: gap.firstChild }, true)).toBe('inner');
    expect(id({ parent: text, next: text.firstChild }, true)).toBe('a');
    // Past either end, around to the other.
    expect(id({ parent: document.body, next: null })).toBe('a');
    expect(id({ parent: document.body, next: document.body.firstChild }, true)).toBe('b');
  });

  it('puts positive tabindex values first, and passes over them going forward', async () => {
    const { document, at } = await start(
      '<button id="a">A</button><span id="pos" tabindex="2">P</span><button id="b">B</button>',
    );
    const a = at('#a');
    expect(focusableFrom(document, { parent: a, next: a.firstChild })?.id).toBe('b');
    expect(focusableFrom(document, { parent: document.body, next: null })?.id).toBe('pos');
  });
});

describe('Tab after a click', () => {
  it('moves to the next control after a click on plain text', async () => {
    const p = await start(
      '<button id="top">Top</button>' +
        '<h2 id="heading">Density</h2>' +
        '<button id="compact">Compact</button>' +
        '<button id="comfortable">Comfortable</button>',
    );
    p.at('#comfortable').focus();
    await p.click(p.at('#heading'));
    // The click took the focus away, as in a browser.
    expect(p.focusedId()).toBe(null);
    await p.type('\t');
    expect(p.focusedId()).toBe('compact');
    await p.click(p.at('#heading'));
    await p.type('\u001b[Z');
    expect(p.focusedId()).toBe('top');
  });

  it('still focuses a clicked control, and Tab moves on from it', async () => {
    const p = await start('<button id="one">One</button><button id="two">Two</button>');
    await p.click(p.at('#one'));
    expect(p.focusedId()).toBe('one');
    await p.type('\t');
    expect(p.focusedId()).toBe('two');
  });

  it('focuses the control of a label on a click on its text', async () => {
    const p = await start(
      '<label><input type="radio" name="theme" id="light"><span id="light-text">Light</span></label>' +
        '<label><input type="radio" name="theme" id="dark"><span>Dark</span></label>' +
        '<label for="name" id="name-label">Name</label><input id="name">',
    );
    await p.click(p.at('#light-text'));
    expect(p.at('#light').checked).toBe(true);
    expect(p.focusedId()).toBe('light');
    await p.type('\t');
    expect(p.focusedId()).toBe('dark');
    await p.click(p.at('#name-label'));
    expect(p.focusedId()).toBe('name');
    await p.type('Ada');
    expect(p.at('#name').value).toBe('Ada');
  });

  it('starts from where a focused menu item was when its menu closes', async () => {
    const p = await start(
      '<button id="menu-button">⋯</button>' +
        '<div id="menu"><button id="item">Star</button></div>' +
        '<button id="after">After</button>',
    );
    p.at('#item').addEventListener('click', () => p.at('#menu').remove());
    await p.click(p.at('#item'));
    expect(p.at('#menu')).toBeNull();
    await p.type('\t');
    expect(p.focusedId()).toBe('after');
  });
});

// The mailbox as the app draws it, cut down to what the focus follows: the
// message list, and the reader with a message in it.
const MAILBOX =
  '<div role="listbox" aria-label="Conversations">' +
  ['m1', 'm2', 'm3']
    .map(
      (id) =>
        `<div data-conversation-row data-message-id="${id}" id="row-${id}" role="option" tabindex="0" aria-selected="false">Message ${id}</div>`,
    )
    .join('') +
  '</div>' +
  '<button id="sidebar">Inbox</button>' +
  '<section data-testid="reader-pane" id="reader"></section>';

function openMessage(p, id) {
  for (const row of p.document.querySelectorAll('[data-conversation-row]')) {
    row.setAttribute('aria-selected', String(row.getAttribute('data-message-id') === id));
  }
  p.at('#reader').innerHTML =
    '<div><button id="back" aria-label="Back to list">‹</button><button id="star">☆</button></div>' +
    `<strong id="subject">Subject of ${id}</strong>` +
    '<button id="actions" aria-label="Message actions">⋯</button>';
}

// Another message in the same reader, as ↓ shows it: the controls stay.
function switchMessage(p, id) {
  for (const row of p.document.querySelectorAll('[data-conversation-row]')) {
    row.setAttribute('aria-selected', String(row.getAttribute('data-message-id') === id));
  }
  p.at('#subject').textContent = `Subject of ${id}`;
}

function closeMessage(p) {
  p.at('#reader').replaceChildren();
  for (const row of p.document.querySelectorAll('[data-conversation-row]')) {
    row.setAttribute('aria-selected', 'false');
  }
}

describe('an open message', () => {
  it('takes the keyboard from the list row that opened it', async () => {
    const p = await start(MAILBOX);
    p.at('#row-m2').focus();
    openMessage(p, 'm2');
    await tick();
    expect(p.focusedId()).toBe(null);
    await p.type('\t');
    expect(p.focusedId()).toBe('back');
  });

  it('leaves the focus in a text field or in the message', async () => {
    const p = await start(`${MAILBOX}<input id="search">`);
    p.at('#search').focus();
    openMessage(p, 'm1');
    await tick();
    expect(p.focusedId()).toBe('search');

    p.at('#star').focus();
    switchMessage(p, 'm2');
    await tick();
    expect(p.focusedId()).toBe('star');
  });

  it('takes the keyboard into the next message from a row clicked beside it', async () => {
    const p = await start(MAILBOX);
    openMessage(p, 'm1');
    await tick();
    // A list beside the reader (the classic layout): a row clicked there
    // opens its message, and the keyboard follows.
    await p.click(p.at('#row-m3'));
    expect(p.focusedId()).toBe('row-m3');
    switchMessage(p, 'm3');
    await tick();
    expect(p.focusedId()).toBe(null);
    await p.type('\t');
    expect(p.focusedId()).toBe('back');
  });

  it('gives the focus to its row in the list when it closes', async () => {
    const p = await start(MAILBOX);
    openMessage(p, 'm2');
    await tick();
    await p.type('\t');
    expect(p.focusedId()).toBe('back');
    closeMessage(p);
    await tick();
    expect(p.focusedId()).toBe('row-m2');
  });

  it('keeps a focus that went elsewhere on purpose when it closes', async () => {
    const p = await start(MAILBOX);
    openMessage(p, 'm1');
    await tick();
    p.at('#sidebar').focus();
    closeMessage(p);
    await tick();
    expect(p.focusedId()).toBe('sidebar');
  });

  it('gives the keyboard back to where it was when a compose window closes', async () => {
    const p = await start(MAILBOX);
    p.at('#sidebar').focus();
    const compose = p.document.createElement('div');
    compose.setAttribute('data-testid', 'compose-modal');
    compose.innerHTML = '<input id="to">';
    p.document.body.append(compose);
    await tick();
    p.at('#to').focus();
    compose.remove();
    await tick();
    expect(p.focusedId()).toBe('sidebar');
  });
});
