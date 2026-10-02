/**
 * "Click to copy" on the addresses of an open message, end to end: the
 * built client in a real pseudo-terminal with the demo account, with fake
 * clipboard programs on the PATH that record what they get.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI, KEYS, canRunInteractive, quote, startTerminal, tempHome } from './terminal.js';

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing; run pnpm build:cli first (pnpm test:cli does).`);
  }
});

const SENDER = 'Forward Email Team <team@forwardemail.net>';
const RECIPIENT = 'Demo User <demo@forwardemail.net>';

// A session on this computer with no desktop, multiplexer or SSH, whatever
// the machine running the tests has; each test adds what it needs.
const LOCAL = {
  DISPLAY: '',
  WAYLAND_DISPLAY: '',
  SSH_CONNECTION: '',
  SSH_CLIENT: '',
  SSH_TTY: '',
  TMUX: '',
  STY: '',
  VTE_VERSION: '',
  TERM_PROGRAM: '',
  WSL_DISTRO_NAME: '',
  WSL_INTEROP: '',
};

const osc52 = (text) => `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;

// Programs that stand in for xclip and the like: each writes what it reads
// to <name>.txt and exits with `code`.
function clipboardPrograms(names, code = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-clip-'));
  for (const name of names) {
    const script = `#!/bin/sh\ncat > '${dir}/${name}.txt'\nexit ${code}\n`;
    fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 });
  }
  return {
    path: `${dir}:${process.env.PATH}`,
    received: (name) => {
      const file = path.join(dir, `${name}.txt`);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    },
  };
}

async function openWelcome(session) {
  await session.waitFor('Welcome to Forward Email!');
  session.type(KEYS.down);
  await session.waitFor('To: Demo User');
}

const hasTmux = spawnSync('tmux', ['-V']).status === 0;
// WSL copies through the Windows programs before xclip.
const inWsl = /microsoft/i.test(os.release());

describe.runIf(canRunInteractive)('copying an address', () => {
  let session;
  const tmuxServers = [];
  afterEach(async () => {
    await session?.stop();
    session = null;
    for (const socket of tmuxServers.splice(0)) spawnSync('tmux', ['-S', socket, 'kill-server']);
  });

  it.skipIf(inWsl)('copies the sender on a click, through xclip and OSC 52', async () => {
    const programs = clipboardPrograms(['xclip']);
    session = startTerminal({
      home: tempHome(),
      args: ['--demo'],
      env: { ...LOCAL, DISPLAY: ':99', PATH: programs.path },
    });
    await openWelcome(session);
    session.click('team@forwardemail.net');
    await session.waitFor('Copied to clipboard');
    expect(programs.received('xclip')).toBe(SENDER);
    expect(session.clipboard).toEqual([SENDER]);
  });

  it.skipIf(inWsl)('says "Failed to copy" when the clipboard program fails', async () => {
    const programs = clipboardPrograms(['xclip'], 1);
    session = startTerminal({
      home: tempHome(),
      args: ['--demo'],
      env: { ...LOCAL, DISPLAY: ':99', PATH: programs.path },
    });
    await openWelcome(session);
    session.click('team@forwardemail.net');
    const screen = await session.waitFor('Failed to copy');
    expect(screen).not.toContain('Copied to clipboard');
    expect(programs.received('xclip')).toBe(SENDER);
  });

  it.skipIf(inWsl)(
    'says "Failed to copy" in a terminal that ignores OSC 52 with no clipboard program',
    async () => {
      // GNOME Terminal on a desktop with no xclip, xsel or wl-clipboard.
      session = startTerminal({
        home: tempHome(),
        args: ['--demo'],
        env: { ...LOCAL, VTE_VERSION: '7600' },
      });
      await openWelcome(session);
      session.click('team@forwardemail.net');
      const screen = await session.waitFor('Failed to copy');
      expect(screen).not.toContain('Copied to clipboard');
    },
  );

  it('copies through the terminal alone over SSH, running no program', async () => {
    const programs = clipboardPrograms(['xclip', 'xsel']);
    session = startTerminal({
      home: tempHome(),
      args: ['--demo'],
      env: {
        ...LOCAL,
        SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22',
        DISPLAY: 'localhost:10.0',
        PATH: programs.path,
      },
    });
    await openWelcome(session);
    session.click('demo@forwardemail.net');
    await session.waitFor('Copied to clipboard');
    expect(session.clipboard).toEqual([RECIPIENT]);
    expect(programs.received('xclip')).toBeNull();
    expect(programs.received('xsel')).toBeNull();
  });

  it('wraps the sequence for tmux to pass on, and sends the plain one too', async () => {
    session = startTerminal({
      home: tempHome(),
      args: ['--demo'],
      env: { ...LOCAL, TMUX: '/tmp/tmux-1000/default,4242,0', TERM: 'tmux-256color' },
    });
    await openWelcome(session);
    session.click('team@forwardemail.net');
    await session.waitFor('Copied to clipboard');
    const plain = osc52(SENDER);
    expect(session.output()).toContain(`${plain}\u001bPtmux;\u001b${plain}\u001b\\`);
    // With no tmux in between, the terminal ends the wrapper's string at its
    // first ESC and reads the sequence inside as well: the text twice.
    expect(session.clipboard).toEqual([SENDER, SENDER]);
  });

  // The client inside a real tmux, inside the test's terminal: the copy
  // reaches the terminal around tmux with either setting that lets it out.
  for (const [setting, conf] of [
    ['allow-passthrough on', 'set -g allow-passthrough on\nset -g set-clipboard off\n'],
    ['set-clipboard on', 'set -g allow-passthrough off\nset -g set-clipboard on\n'],
  ]) {
    it.runIf(hasTmux)(`reaches the terminal around tmux with ${setting}`, async () => {
      const dir = tempHome();
      const file = path.join(dir, 'tmux.conf');
      fs.writeFileSync(file, `set -g status off\n${conf}`);
      // A server of its own, with its socket in the test's directory.
      const socket = path.join(dir, 'tmux.sock');
      tmuxServers.push(socket);
      session = startTerminal({
        home: tempHome(),
        args: ['--demo'],
        env: LOCAL,
        wrap: (command) =>
          `tmux -S ${quote(socket)} -f ${quote(file)} new-session -x 120 -y 36 ${quote(command)}`,
      });
      await openWelcome(session);
      session.click('team@forwardemail.net');
      await session.waitFor('Copied to clipboard');
      expect(session.clipboard).toEqual([SENDER]);
    });
  }
});
