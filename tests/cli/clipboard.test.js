/**
 * Copying to the system clipboard (src/cli/system-clipboard.ts and
 * navigator.clipboard in src/cli/clipboard.ts): the route a copy takes on
 * each system, with the platform, the environment and the program runner
 * handed in, then with real programs.
 */
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TermDOM } from '@b9g/termdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installClipboard } from '../../src/cli/clipboard';
import {
  MAX_TERMINAL_COPY,
  clipboardSequences,
  copyPrograms,
  createClipboardWriter,
  isRemoteSession,
  isWsl,
} from '../../src/cli/system-clipboard';

const TEXT = 'José Núñez <jose@example.com>, 山田 太郎, 🦄 $(touch hacked) "x" \'y\' `z`';

const osc52 = (text) => `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;

/**
 * A stand-in for child_process.spawn. Each program does what `outcomes` says
 * for its file name: 'ok' (exits 0, the default), 'fail' (exits 1), 'missing'
 * (cannot start) or 'hang' (never exits).
 */
function fakeSpawn(outcomes = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    const call = { command, args, options, input: null, killed: null };
    calls.push(call);
    child.stdin = {
      on() {},
      end(data) {
        call.input = data;
      },
    };
    child.kill = (signal) => {
      call.killed = signal;
    };
    // The file name, from a Windows path too.
    const outcome = outcomes[command.split(/[\\/]/).pop()] ?? 'ok';
    process.nextTick(() => {
      if (outcome === 'missing') {
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }),
        );
        return;
      }
      child.emit('spawn');
      if (outcome === 'ok') child.emit('exit', 0, null);
      if (outcome === 'fail') child.emit('exit', 1, null);
    });
    return child;
  };
  return { spawn, calls };
}

function writer({ platform, env = {}, wsl = false, outcomes, timeoutMs, output } = {}) {
  const fake = fakeSpawn(outcomes);
  const written = [];
  const copy = createClipboardWriter({
    platform,
    env,
    wsl,
    spawn: fake.spawn,
    timeoutMs,
    output: output ?? { write: (text) => written.push(text) },
  });
  return { copy, calls: fake.calls, written };
}

describe('the route a copy takes', () => {
  it('uses pbcopy on macOS, reading UTF-8, and OSC 52 alongside', async () => {
    const { copy, calls, written } = writer({ platform: 'darwin', env: { LANG: 'C' } });
    await expect(copy(TEXT)).resolves.toEqual({ program: 'pbcopy' });
    expect(calls.map((call) => [call.command, call.args])).toEqual([['/usr/bin/pbcopy', []]]);
    expect(calls[0].input.toString('utf8')).toBe(TEXT);
    expect(calls[0].options.env).toMatchObject({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' });
    expect(calls[0].options.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    // A session of its own, so the copy outlives the terminal window.
    expect(calls[0].options.detached).toBe(true);
    expect(written).toEqual([osc52(TEXT)]);
  });

  it('uses PowerShell on Windows, fed UTF-8 bytes, from System32', async () => {
    const { copy, calls } = writer({ platform: 'win32', env: { SystemRoot: 'D:\\Windows' } });
    await expect(copy(TEXT)).resolves.toEqual({ program: 'PowerShell' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Sta', '-Command']);
    // The script reads bytes and decodes them as UTF-8; the text is not in it.
    expect(call.args[4]).toContain('Set-Clipboard');
    expect(call.args[4]).toContain('UTF8.GetString');
    expect(call.args.join(' ')).not.toContain('José');
    expect(call.input.equals(Buffer.from(TEXT, 'utf8'))).toBe(true);
    expect(call.options).toMatchObject({ windowsHide: true, detached: false });
  });

  it('falls back to clip.exe on Windows, fed UTF-16LE with no byte order mark', async () => {
    for (const outcome of ['missing', 'fail']) {
      const { copy, calls } = writer({
        platform: 'win32',
        outcomes: { 'powershell.exe': outcome },
      });
      await expect(copy(TEXT)).resolves.toEqual({ program: 'clip.exe' });
      expect(calls.map((call) => call.command)).toEqual([
        'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        'C:\\Windows\\System32\\clip.exe',
      ]);
      const input = calls[1].input;
      expect(input.equals(Buffer.from(TEXT, 'utf16le'))).toBe(true);
      expect([input[0], input[1]]).not.toEqual([0xff, 0xfe]);
    }
  });

  it('uses wl-copy under Wayland, and xclip when wl-copy is missing', async () => {
    const env = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
    const wayland = writer({ platform: 'linux', env });
    await expect(wayland.copy(TEXT)).resolves.toEqual({ program: 'wl-copy' });
    expect(wayland.calls.map((call) => [call.command, call.args])).toEqual([
      ['wl-copy', ['--type', 'text/plain;charset=utf-8']],
    ]);
    expect(wayland.calls[0].input.toString('utf8')).toBe(TEXT);

    const fallback = writer({ platform: 'linux', env, outcomes: { 'wl-copy': 'missing' } });
    await expect(fallback.copy(TEXT)).resolves.toEqual({ program: 'xclip' });
  });

  it('uses xclip under X11, then xsel, on Linux and the BSDs', async () => {
    for (const platform of ['linux', 'freebsd', 'openbsd']) {
      const x11 = writer({ platform, env: { DISPLAY: ':0' } });
      await expect(x11.copy(TEXT)).resolves.toEqual({ program: 'xclip' });
      expect(x11.calls.map((call) => [call.command, call.args])).toEqual([
        ['xclip', ['-selection', 'clipboard']],
      ]);
    }
    const xsel = writer({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      outcomes: { xclip: 'missing' },
    });
    await expect(xsel.copy(TEXT)).resolves.toEqual({ program: 'xsel' });
    expect(xsel.calls.map((call) => [call.command, call.args])).toEqual([
      ['xclip', ['-selection', 'clipboard']],
      ['xsel', ['--clipboard', '--input']],
    ]);
  });

  it('counts OSC 52 as the copy where the system has no clipboard program or no desktop', async () => {
    const none = writer({ platform: 'linux', env: {} });
    await expect(none.copy(TEXT)).resolves.toEqual({ program: null });
    expect(none.calls).toEqual([]);
    expect(none.written).toEqual([osc52(TEXT)]);

    const missing = writer({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      outcomes: { xclip: 'missing', xsel: 'missing' },
    });
    await expect(missing.copy(TEXT)).resolves.toEqual({ program: null });
    expect(missing.written).toEqual([osc52(TEXT)]);
  });

  it('fails in a terminal that ignores OSC 52 when no clipboard program is installed', async () => {
    for (const env of [
      { VTE_VERSION: '7600', WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      { VTE_VERSION: '7600', TMUX: '/tmp/tmux,1,0', TERM: 'tmux-256color', DISPLAY: ':0' },
    ]) {
      const vte = writer({
        platform: 'linux',
        env,
        outcomes: { 'wl-copy': 'missing', xclip: 'missing', xsel: 'missing' },
      });
      await expect(vte.copy(TEXT)).rejects.toThrow(
        env.WAYLAND_DISPLAY
          ? 'this terminal does not take copies; install wl-clipboard or xclip or xsel'
          : 'this terminal does not take copies; install xclip or xsel',
      );
      // The sequence still went out, for a terminal that takes it after all.
      expect(vte.written[0]).toContain(osc52(TEXT));
    }

    const console = writer({ platform: 'linux', env: { TERM: 'linux' } });
    await expect(console.copy(TEXT)).rejects.toThrow('this terminal does not take copies');

    // An installed program takes the copy there as anywhere.
    const xclip = writer({ platform: 'linux', env: { VTE_VERSION: '7600', DISPLAY: ':0' } });
    await expect(xclip.copy(TEXT)).resolves.toEqual({ program: 'xclip' });

    // Over SSH the variables describe the remote computer, so OSC 52 counts.
    const remote = writer({
      platform: 'darwin',
      env: { TERM_PROGRAM: 'Apple_Terminal', SSH_TTY: '/dev/ttys001' },
    });
    await expect(remote.copy(TEXT)).resolves.toEqual({ program: null });
  });

  it('uses the Windows programs in WSL, then the Linux ones', async () => {
    const wsl = writer({ platform: 'linux', env: { DISPLAY: ':0' }, wsl: true });
    await expect(wsl.copy(TEXT)).resolves.toEqual({ program: 'PowerShell' });
    expect(wsl.calls[0].command).toBe('powershell.exe');
    expect(wsl.calls[0].options.detached).toBe(true);

    // PowerShell failed, so the copy skips it at its full path; clip.exe
    // could not start from the PATH or the default mount.
    const failed = writer({
      platform: 'linux',
      env: {},
      wsl: true,
      outcomes: { 'powershell.exe': 'fail', 'clip.exe': 'missing' },
    });
    await expect(failed.copy(TEXT)).rejects.toThrow('PowerShell failed');
    expect(failed.calls.map((call) => call.command)).toEqual([
      'powershell.exe',
      'clip.exe',
      '/mnt/c/Windows/System32/clip.exe',
    ]);

    // Interop turned off: nothing starts, and WSLg's X11 takes the copy.
    const off = writer({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      wsl: true,
      outcomes: { 'powershell.exe': 'missing', 'clip.exe': 'missing' },
    });
    await expect(off.copy(TEXT)).resolves.toEqual({ program: 'xclip' });
  });

  it('tells WSL from its environment and kernel', () => {
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, '6.8.0')).toBe(true);
    expect(isWsl({}, '5.15.153.1-microsoft-standard-WSL2')).toBe(true);
    expect(isWsl({}, '6.8.0-45-generic')).toBe(false);
  });

  it('runs no program over SSH, where OSC 52 reaches the computer in front of the user', async () => {
    for (const env of [
      { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22', DISPLAY: 'localhost:10.0' },
      { SSH_TTY: '/dev/pts/3' },
      { SSH_CLIENT: '10.0.0.2 50000 22' },
    ]) {
      expect(isRemoteSession(env)).toBe(true);
      for (const platform of ['linux', 'darwin', 'win32']) {
        const remote = writer({ platform, env });
        await expect(remote.copy(TEXT)).resolves.toEqual({ program: null });
        expect(remote.calls).toEqual([]);
        expect(remote.written).toEqual([osc52(TEXT)]);
      }
    }
    expect(isRemoteSession({ SSH_CONNECTION: '' })).toBe(false);
  });

  it('wraps the sequence for tmux, keeping the plain one for set-clipboard on', async () => {
    const plain = osc52(TEXT);
    const wrapped = `\u001bPtmux;\u001b${plain}\u001b\\`;
    for (const TERM of ['tmux-256color', 'screen-256color', 'screen']) {
      expect(clipboardSequences(TEXT, { TMUX: '/tmp/tmux-1000/default,1234,0', TERM })).toEqual([
        plain,
        wrapped,
      ]);
    }
    const { copy, written } = writer({
      platform: 'linux',
      env: { TMUX: '/tmp/tmux,1,0', TERM: 'tmux-256color' },
    });
    await copy(TEXT);
    expect(written).toEqual([plain + wrapped]);
  });

  it('sends the plain sequence alone when TMUX or STY is left over from a shell', () => {
    // A terminal window opened from a shell in tmux or screen inherits the
    // variable, but its TERM is its own.
    for (const env of [
      { TMUX: '/tmp/tmux-1000/default,1234,0', TERM: 'xterm-256color' },
      { STY: '1234.pts-0.host', TERM: 'xterm-kitty' },
      { TMUX: '/tmp/tmux-1000/default,1234,0' },
    ]) {
      expect(clipboardSequences(TEXT, env)).toEqual([osc52(TEXT)]);
    }
  });

  it('wraps the sequence for GNU screen in pieces screen passes on whole', () => {
    const long = 'x'.repeat(1000);
    const [plain, wrapped] = clipboardSequences(long, {
      STY: '1234.pts-0.host',
      TERM: 'screen.xterm-256color',
    });
    expect(plain).toBe(osc52(long));
    const pieces = wrapped.split('\u001b\\').filter(Boolean);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith('\u001bP')).toBe(true);
      expect(piece.length + 2).toBeLessThanOrEqual(256);
    }
    expect(pieces.map((piece) => piece.slice(2)).join('')).toBe(plain);
    expect(clipboardSequences(TEXT, {})).toEqual([osc52(TEXT)]);
  });

  it('fails when the clipboard program fails, so the app does not say "Copied"', async () => {
    const { copy, written } = writer({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      outcomes: { xclip: 'fail', xsel: 'missing' },
    });
    await expect(copy(TEXT)).rejects.toThrow('xclip failed');
    // The terminal got its sequence all the same.
    expect(written).toEqual([osc52(TEXT)]);
  });

  it('stops a program that does not finish and tries the next', async () => {
    const { copy, calls } = writer({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      outcomes: { xclip: 'hang' },
      timeoutMs: 50,
    });
    await expect(copy(TEXT)).resolves.toEqual({ program: 'xsel' });
    expect(calls[0].killed).toBe('SIGKILL');

    const stuck = writer({ platform: 'darwin', outcomes: { pbcopy: 'hang' }, timeoutMs: 50 });
    await expect(stuck.copy(TEXT)).rejects.toThrow('pbcopy failed');
  });

  it('leaves a very long copy to the clipboard program', async () => {
    const long = 'a'.repeat(MAX_TERMINAL_COPY + 1);
    const local = writer({ platform: 'darwin' });
    await expect(local.copy(long)).resolves.toEqual({ program: 'pbcopy' });
    expect(local.written).toEqual([]);
    expect(local.calls[0].input.length).toBe(long.length);

    const remote = writer({ platform: 'linux', env: { SSH_TTY: '/dev/pts/1' } });
    await expect(remote.copy(long)).rejects.toThrow('too long');
  });

  it('fails when writing to the terminal fails and no program took the text', async () => {
    const { copy } = writer({
      platform: 'linux',
      output: {
        write() {
          throw new Error('EIO');
        },
      },
    });
    await expect(copy(TEXT)).rejects.toThrow('the terminal is not reachable');
  });

  it('lists no program for an unknown desktop', () => {
    expect(copyPrograms('linux', {})).toEqual([]);
    expect(copyPrograms('aix', { DISPLAY: ':0' }).map((program) => program.name)).toEqual([
      'xclip',
      'xsel',
    ]);
  });
});

// Real processes: fake xclip, xsel and wl-copy on the PATH record what they
// get, the way the real ones would take it.
describe.runIf(process.platform === 'linux')('with clipboard programs on Linux', () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      // A fork a fake program left running.
      const pid = Number(fs.readFileSync(path.join(dir, 'fork.pid'), 'utf8').trim() || 0);
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone already
        }
      }
    }
  });

  // A directory of programs that write their arguments and input to
  // <name>.args and <name>.txt, then exit with `code`. With `fork`, the
  // program leaves a process behind that holds on to the output, as xclip
  // does to keep serving the copy.
  function programs(names, { code = 0, fork = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-clip-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'fork.pid'), '');
    for (const name of names) {
      const script = [
        '#!/bin/sh',
        `printf '%s\\n' "$@" > '${dir}/${name}.args'`,
        `cat > '${dir}/${name}.txt'`,
        fork ? `sleep 60 & echo $! > '${dir}/fork.pid'` : '',
        `exit ${code}`,
      ].join('\n');
      fs.writeFileSync(path.join(dir, name), `${script}\n`, { mode: 0o755 });
    }
    return {
      dir,
      env: (extra) => ({ PATH: `${dir}:/usr/bin:/bin`, ...extra }),
      input: (name) => {
        const file = path.join(dir, `${name}.txt`);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      },
      args: (name) => fs.readFileSync(path.join(dir, `${name}.args`), 'utf8').split('\n'),
    };
  }

  it('hands the text to xclip on its input, as written, with no shell', async () => {
    const bin = programs(['xclip']);
    const written = [];
    const copy = createClipboardWriter({
      platform: 'linux',
      env: bin.env({ DISPLAY: ':99' }),
      wsl: false,
      output: { write: (text) => written.push(text) },
    });
    await expect(copy(TEXT)).resolves.toEqual({ program: 'xclip' });
    expect(bin.input('xclip')).toBe(TEXT);
    expect(bin.args('xclip').slice(0, 2)).toEqual(['-selection', 'clipboard']);
    // $(touch hacked) stayed text.
    expect(fs.existsSync(path.join(process.cwd(), 'hacked'))).toBe(false);
    expect(fs.existsSync(path.join(bin.dir, 'hacked'))).toBe(false);
    expect(written).toEqual([osc52(TEXT)]);
  });

  it('hands the text to wl-copy under Wayland', async () => {
    const bin = programs(['wl-copy', 'xclip']);
    const copy = createClipboardWriter({
      platform: 'linux',
      env: bin.env({ WAYLAND_DISPLAY: 'wayland-1', DISPLAY: ':99' }),
      wsl: false,
      output: { write() {} },
    });
    await expect(copy(TEXT)).resolves.toEqual({ program: 'wl-copy' });
    expect(bin.input('wl-copy')).toBe(TEXT);
    expect(bin.args('wl-copy').slice(0, 2)).toEqual(['--type', 'text/plain;charset=utf-8']);
    expect(bin.input('xclip')).toBeNull();
  });

  it('does not wait for the process a program leaves behind to serve the copy', async () => {
    const bin = programs(['xclip'], { fork: true });
    const copy = createClipboardWriter({
      platform: 'linux',
      env: bin.env({ DISPLAY: ':99' }),
      wsl: false,
      output: { write() {} },
      timeoutMs: 10_000,
    });
    const started = Date.now();
    await expect(copy(TEXT)).resolves.toEqual({ program: 'xclip' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(bin.input('xclip')).toBe(TEXT);
  });

  it('fails when xclip fails and xsel is not installed', async () => {
    const bin = programs(['xclip'], { code: 1 });
    const copy = createClipboardWriter({
      platform: 'linux',
      env: bin.env({ DISPLAY: ':99' }),
      wsl: false,
      output: { write() {} },
    });
    await expect(copy(TEXT)).rejects.toThrow('xclip failed');
  });

  it('counts OSC 52 as the copy when the PATH holds no clipboard program', async () => {
    const bin = programs([]);
    const written = [];
    const copy = createClipboardWriter({
      platform: 'linux',
      env: bin.env({ DISPLAY: ':99', WAYLAND_DISPLAY: 'wayland-1' }),
      wsl: false,
      output: { write: (text) => written.push(text) },
    });
    await expect(copy(TEXT)).resolves.toEqual({ program: null });
    expect(written).toEqual([osc52(TEXT)]);
  });
});

// The system clipboard itself, read back with the system's own program. These
// run on CI and leave a developer's clipboard alone.
describe.runIf(process.env.CI)('the system clipboard', () => {
  const copyHere = () =>
    createClipboardWriter({
      output: { write() {} },
      env: { ...process.env, SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '' },
    });

  it.runIf(process.platform === 'darwin')('takes Unicode text through pbcopy', async () => {
    await expect(copyHere()(TEXT)).resolves.toEqual({ program: 'pbcopy' });
    const pasted = spawnSync('pbpaste', [], {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
    });
    expect(pasted.stdout).toBe(TEXT);
  });

  it.runIf(process.platform === 'win32')('takes Unicode text through PowerShell', async () => {
    await expect(copyHere()(TEXT)).resolves.toEqual({ program: 'PowerShell' });
    const pasted = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Sta',
        '-Command',
        // UTF-8 with no byte order mark, so the output is the clipboard's text.
        '[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding $false;[Console]::Out.Write((Get-Clipboard -Raw))',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(pasted.stdout).toBe(TEXT);
  });
});

describe('navigator.clipboard in the terminal', () => {
  const quietTransport = (readable) => ({
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
  });
  const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  // A terminal to type into, with the clipboard's output and programs caught.
  function terminal(outcomes, env = { DISPLAY: ':0' }) {
    let type;
    const readable = new ReadableStream({
      start(controller) {
        type = (text) => controller.enqueue(text);
      },
    });
    const term = new TermDOM({
      html: '<body><p id="p">hello world</p></body>',
      transport: quietTransport(readable),
    });
    const written = [];
    const fake = fakeSpawn(outcomes);
    installClipboard(term.window, {
      output: { write: (text) => written.push(text) },
      clipboard: { platform: 'linux', env, wsl: false, spawn: fake.spawn },
    });
    return { term, type: (text) => type(text), written, calls: fake.calls };
  }

  it('turns down a copy that no click or key press asked for', async () => {
    const { term, written, calls } = terminal();
    await term.attach();
    try {
      const error = await term.window.navigator.clipboard.writeText('hi').catch((e) => e);
      expect(error.name).toBe('NotAllowedError');
      expect(written).toEqual([]);
      expect(calls).toEqual([]);
    } finally {
      await term.dispose();
    }
  });

  it('copies after a key press, also once the handler has awaited something', async () => {
    const { term, type, written, calls } = terminal();
    const results = [];
    term.window.addEventListener('keydown', async () => {
      await tick(10);
      results.push(await term.window.navigator.clipboard.writeText(TEXT).then(() => 'ok'));
    });
    await term.attach();
    try {
      type('x');
      await tick(150);
      expect(results).toEqual(['ok']);
      expect(written).toEqual([osc52(TEXT)]);
      expect(calls[0].input.toString('utf8')).toBe(TEXT);
    } finally {
      await term.dispose();
    }
  });

  it('rejects when the text reached no clipboard, which the app shows as "Failed to copy"', async () => {
    const { term, type } = terminal({ xclip: 'fail', xsel: 'fail' });
    const results = [];
    term.window.addEventListener('keydown', () => {
      term.window.navigator.clipboard.writeText(TEXT).then(
        () => results.push('copied'),
        (error) => results.push(`${error.name}: ${error.message}`),
      );
    });
    await term.attach();
    try {
      type('x');
      await tick(150);
      expect(results).toEqual(['NotAllowedError: Could not copy: xclip and xsel failed']);
    } finally {
      await term.dispose();
    }
  });

  it('copies the text/plain entry of navigator.clipboard.write', async () => {
    const { term, type, written } = terminal(undefined, {});
    const win = term.window;
    const results = [];
    win.addEventListener('keydown', () => {
      const item = new win.ClipboardItem({
        'text/plain': new Blob([TEXT], { type: 'text/plain' }),
      });
      win.navigator.clipboard.write([item]).then(() => results.push('copied'));
    });
    await term.attach();
    try {
      type('x');
      await tick(150);
      expect(results).toEqual(['copied']);
      expect(written).toEqual([osc52(TEXT)]);
    } finally {
      await term.dispose();
    }
  });

  // Selects "hello" in the page's paragraph.
  const selectHello = (term) => {
    const range = term.document.createRange();
    range.setStart(term.document.getElementById('p').firstChild, 0);
    range.setEnd(term.document.getElementById('p').firstChild, 5);
    term.window.getSelection().addRange(range);
  };

  it('copies the selection on Ctrl+C through the clipboard program as well', async () => {
    const { term, type, written, calls } = terminal();
    const notices = [];
    term.window.addEventListener('fe-terminal-notice', (event) => notices.push(event.detail));
    await term.attach();
    try {
      selectHello(term);
      type('\u0003');
      await tick(150);
      expect(term.window.closed).toBe(false);
      expect(calls.map((call) => call.input.toString('utf8'))).toEqual(['hello']);
      expect(written).toEqual([osc52('hello')]);
      expect(notices).toEqual(['Copied']);
      expect(term.window.getSelection().toString()).toBe('');
    } finally {
      await term.dispose();
    }
  });

  it('keeps the selection and says so when Ctrl+C could not copy it', async () => {
    const { term, type } = terminal({ xclip: 'fail', xsel: 'missing' });
    const notices = [];
    term.window.addEventListener('fe-terminal-notice', (event) => notices.push(event.detail));
    await term.attach();
    try {
      selectHello(term);
      type('\u0003');
      await tick(150);
      expect(term.window.closed).toBe(false);
      expect(notices).toEqual([{ text: 'Could not copy: xclip failed', failed: true }]);
      expect(term.window.getSelection().toString()).toBe('hello');
    } finally {
      await term.dispose();
    }
  });
});
