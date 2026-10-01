/**
 * Desktop notifications in the terminal client: the Notification API on a
 * real TermDOM document, the system notifier run as a real program (a
 * stand-in notify-send that records its arguments), and the terminal focus
 * reports that decide between a toast and a system notification.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TermDOM } from '@b9g/termdom';
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { IDLE_MS, installFocus } from '../../src/cli/focus';
import {
  createSystemNotifier,
  installNotifications,
  unavailableReason,
} from '../../src/cli/notifications';

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-notify-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// A notify-send that writes each argument on its own line.
function fakeNotifySend() {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'notify-send.log');
  fs.writeFileSync(
    path.join(bin, 'notify-send'),
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done >> '${log}'\necho --- >> '${log}'\n`,
    { mode: 0o755 },
  );
  return {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, DISPLAY: ':0' },
    calls: () =>
      fs.existsSync(log)
        ? fs
            .readFileSync(log, 'utf8')
            .split('---\n')
            .filter(Boolean)
            .map((call) => call.trimEnd().split('\n'))
        : [],
  };
}

// A terminal whose input the test types, so clicks and keys arrive the way
// a user's do.
function interactiveTerminal() {
  let type;
  const readable = new ReadableStream({
    start(controller) {
      type = (text) => controller.enqueue(text);
    },
  });
  const term = new TermDOM({
    html: '<body><button id="allow">Allow notifications</button></body>',
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
  return { term, type: (text) => type(text) };
}

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describe('system notifier', () => {
  it('is off over SSH, without a desktop session and when turned off', () => {
    const desktop = { DISPLAY: ':0', PATH: '' };
    expect(unavailableReason({ ...desktop, SSH_CONNECTION: '1 2 3 4' }, 'linux')).toBe(
      'remote session',
    );
    expect(unavailableReason({ PATH: '' }, 'linux')).toBe('no desktop session');
    expect(unavailableReason(desktop, 'linux')).toBe('notify-send is not installed');
    expect(unavailableReason({ FORWARDEMAIL_NOTIFICATIONS: '0' }, 'darwin')).toBe('turned off');
    expect(unavailableReason({}, 'darwin')).toBeNull();
    expect(unavailableReason({ SSH_TTY: '/dev/pts/1' }, 'win32')).toBe('remote session');
    expect(
      unavailableReason({ SSH_TTY: '/dev/pts/1', FORWARDEMAIL_NOTIFICATIONS: '1' }, 'darwin'),
    ).toBeNull();
    expect(
      createSystemNotifier({ dataDir: dir, version: '1.0.0', env: {}, platform: 'linux' }),
    ).toBeNull();
  });

  it.skipIf(process.platform !== 'linux')(
    'runs notify-send with the text as plain arguments, never through a shell',
    async () => {
      const fake = fakeNotifySend();
      // notify-send is found on the process's PATH, as for a user.
      const pathBefore = process.env.PATH;
      process.env.PATH = fake.env.PATH;
      onTestFinished(() => {
        process.env.PATH = pathBefore;
      });
      const notifier = createSystemNotifier({
        dataDir: dir,
        version: '1.0.0',
        env: fake.env,
        platform: 'linux',
      });
      const shown = await notifier.show({
        title: '-Alice $(touch pwned) `id`',
        body: 'Invoice "May"\nPlease find attached',
      });
      expect(shown).toBe(true);
      expect(fs.existsSync(path.join(process.cwd(), 'pwned'))).toBe(false);
      const [call] = fake.calls();
      expect(call[0]).toBe('‑Alice $(touch pwned) `id`');
      expect(call[1]).toBe('Invoice "May" · Please find attached');
      expect(call).toContain('--app-name');
      expect(call[call.indexOf('--app-name') + 1]).toBe('Forward Email');
    },
  );
});

describe('Notification', () => {
  it('is missing when the system has no notifier, as in a browser without them', () => {
    const term = new TermDOM({ html: '<body></body>' });
    expect(installNotifications(term.window, { dataDir: dir, notifier: null })).toBeNull();
    expect('Notification' in term.window).toBe(false);
  });

  it('asks from a click, remembers the answer, notifies and can be turned off', async () => {
    const shown = [];
    const notifier = {
      async show(notification) {
        shown.push(notification);
        return true;
      },
    };
    const { term, type } = interactiveTerminal();
    const Notification = installNotifications(term.window, { dataDir: dir, notifier });
    await term.attach();
    try {
      expect(Notification.permission).toBe('default');

      // Asked with no click or key press (calendar reminders do): ignored.
      expect(await Notification.requestPermission()).toBe('default');
      expect(Notification.permission).toBe('default');

      // Asked from the button the user presses: granted, and kept on disk.
      let answer;
      term.document.querySelector('#allow').addEventListener('click', () => {
        Notification.requestPermission((permission) => {
          answer = permission;
        });
      });
      term.document.querySelector('#allow').focus();
      type('\r');
      await tick(200);
      expect(answer).toBe('granted');
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'notifications.json'), 'utf8'))).toEqual({
        permission: 'granted',
      });
      const again = installNotifications(new TermDOM({ html: '' }).window, {
        dataDir: dir,
        notifier,
      });
      expect(again.permission).toBe('granted');

      // What the app does for new mail (utils/notification-bridge.js).
      const events = [];
      const notification = new Notification('Alice', {
        body: 'Lunch?\nAre you free at noon',
        tag: 'new-message-1',
        data: { path: 'INBOX' },
      });
      notification.onshow = () => events.push('show');
      notification.onclick = () => events.push('click');
      await tick();
      expect(shown).toHaveLength(1);
      expect(shown[0]).toMatchObject({
        title: 'Alice',
        body: 'Lunch?\nAre you free at noon',
        tag: 'new-message-1',
      });
      shown[0].onClick();
      expect(events).toEqual(['show', 'click']);

      // Settings › Notifications › Turn off notifications.
      await Notification.revokePermission();
      expect(Notification.permission).toBe('default');
      const errors = [];
      new Notification('Bob', { body: 'Hi' }).onerror = () => errors.push('error');
      await tick();
      expect(errors).toEqual(['error']);
      expect(shown).toHaveLength(1);
    } finally {
      await term.dispose();
    }
  });
});

describe('terminal focus', () => {
  function setup() {
    const term = new TermDOM({ html: '<body></body>' });
    const input = new EventEmitter();
    const received = [];
    input.on('data', (chunk) => received.push(String(chunk)));
    const written = [];
    let now = 0;
    const events = [];
    term.window.addEventListener('focus', () => events.push('focus'));
    term.window.addEventListener('blur', () => events.push('blur'));
    installFocus(term.window, {
      input,
      output: { write: (text) => written.push(text) },
      now: () => now,
    });
    return {
      term,
      input,
      received,
      written,
      events,
      advance: (ms) => {
        now += ms;
      },
    };
  }

  it('turns on focus reports and takes them out of the input', async () => {
    const { term, input, received, written, events } = setup();
    expect(written).toContain('\x1b[?1004h');
    expect(term.document.hasFocus()).toBe(true);

    input.emit('data', '\x1b[O');
    await tick(10);
    expect(term.document.hasFocus()).toBe(false);
    expect(events).toEqual(['blur']);

    // Keys around a report still arrive, without it.
    input.emit('data', 'a\x1b[Ib');
    input.emit('data', Buffer.from('\x1b'));
    await tick(10);
    expect(term.document.hasFocus()).toBe(true);
    expect(events).toEqual(['blur', 'focus']);
    expect(received).toEqual(['ab', '\x1b']);
  });

  it('counts a terminal without focus reports as away after a while without input', async () => {
    const { term, input, events, advance } = setup();
    advance(IDLE_MS - 1);
    expect(term.document.hasFocus()).toBe(true);
    advance(2);
    expect(term.document.hasFocus()).toBe(false);
    input.emit('data', 'j');
    await tick(10);
    expect(term.document.hasFocus()).toBe(true);
    expect(events).toEqual(['focus']);
  });
});
