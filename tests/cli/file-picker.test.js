/**
 * The system file dialog (src/cli/file-picker.ts): which program each system
 * gets, how it is started, and what its answer means. The programs are
 * replaced at the child_process boundary, so no dialog opens.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = [];
// What each program does when started: (args) => { error, stdout, stderr }.
let programs = {};

vi.mock('node:child_process', () => ({
  execFile: vi.fn((file, args, options, callback) => {
    calls.push({ file, args, options });
    const run = programs[file];
    const child = { stdin: { end() {} }, kill: vi.fn() };
    setTimeout(() => {
      if (!run) {
        const error = Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' });
        callback(error, '', '');
        return;
      }
      const { error = null, stdout = '', stderr = '' } = run(args);
      callback(error, stdout, stderr);
    }, 0);
    return child;
  }),
}));

const { nativePickers, pickWithSystemDialog, pickerCommand } =
  await import('../../src/cli/file-picker');

const exit = (code, stderr = '') => ({
  error: Object.assign(new Error(`exit ${code}`), { code }),
  stderr,
});
const request = { title: 'Attach files', multiple: true };
const linuxDesktop = {
  platform: 'linux',
  home: '/home/me',
  wsl: null,
  env: { DISPLAY: ':0' },
};

beforeEach(() => {
  calls.length = 0;
  programs = {};
});

describe('which file dialog', () => {
  const pickers = (platform, env, wsl = null) =>
    nativePickers({ platform, env, wsl, home: '/home/me' });

  it('uses each system its own dialog', () => {
    expect(pickers('darwin', {})).toEqual(['osascript']);
    expect(pickers('win32', {})).toEqual(['powershell']);
    expect(pickers('linux', { DISPLAY: ':0' })).toEqual(['zenity', 'kdialog']);
    expect(pickers('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' })).toEqual([
      'kdialog',
      'zenity',
    ]);
    expect(pickers('freebsd', { DISPLAY: ':0' })).toEqual(['zenity', 'kdialog']);
  });

  it('asks in the terminal without a display, over SSH, or when told to', () => {
    expect(pickers('linux', {})).toEqual([]);
    expect(pickers('darwin', { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' })).toEqual([]);
    expect(pickers('win32', { SSH_CLIENT: '10.0.0.2 51000 22' })).toEqual([]);
    expect(pickers('linux', { SSH_TTY: '/dev/pts/1', WAYLAND_DISPLAY: 'wayland-0' })).toEqual([]);
    expect(pickers('darwin', { FORWARDEMAIL_FILE_PICKER: 'terminal' })).toEqual([]);
  });

  it('uses a forwarded X display over SSH, and the Windows dialog under WSL', () => {
    expect(pickers('linux', { SSH_CONNECTION: 'x', DISPLAY: 'localhost:10.0' })).toEqual([
      'zenity',
      'kdialog',
    ]);
    const wsl = { mountRoot: '/mnt/', distro: 'Ubuntu' };
    expect(pickers('linux', {}, wsl)).toEqual(['powershell']);
    expect(pickers('linux', { DISPLAY: ':0' }, wsl)).toEqual(['powershell', 'zenity', 'kdialog']);
  });
});

describe('starting the dialog', () => {
  it('passes the title as an argument, never through a shell', () => {
    const title = `Attach "files" $(rm -rf ~) 'now'`;
    const osascript = pickerCommand('osascript', { title, multiple: true });
    expect(osascript.file).toBe('osascript');
    expect(osascript.args.at(-1)).toBe(title);
    expect(
      osascript.args
        .filter((arg) => arg !== '-e')
        .slice(0, -1)
        .join('\n'),
    ).not.toContain(title);
    expect(osascript.args).toContain(
      'set picked to choose file with prompt (item 1 of argv) with multiple selections allowed',
    );

    expect(pickerCommand('zenity', { title, multiple: false }).args).toEqual([
      '--file-selection',
      `--title=${title}`,
    ]);
    expect(pickerCommand('kdialog', { title, multiple: true }).args).toEqual([
      '--title',
      title,
      '--getopenfilename',
      '.',
      '--multiple',
      '--separate-output',
    ]);

    // PowerShell gets its script encoded, the title as a quoted literal.
    const powershell = pickerCommand('powershell', { title: "Bob's files", multiple: true });
    expect(powershell.file).toBe('powershell.exe');
    const script = Buffer.from(powershell.args.at(-1), 'base64').toString('utf16le');
    expect(powershell.args.at(-2)).toBe('-EncodedCommand');
    expect(script).toContain("$dialog.Title = 'Bob''s files'");
    expect(script).toContain('$dialog.Multiselect = $true');
  });

  it('returns the chosen paths', async () => {
    programs.zenity = () => ({ stdout: '/home/me/a b.txt\n/home/me/c.pdf\n' });
    const pick = pickWithSystemDialog(request, linuxDesktop);
    expect(pick.dialog).toBe(true);
    expect(await pick.result).toEqual({
      status: 'picked',
      paths: ['/home/me/a b.txt', '/home/me/c.pdf'],
    });
    expect(calls.map((call) => call.file)).toEqual(['zenity']);
  });

  it('tries the next program when one is missing or has no display', async () => {
    programs.kdialog = () => ({ stdout: '/home/me/a.txt\n' });
    expect(await pickWithSystemDialog(request, linuxDesktop).result).toEqual({
      status: 'picked',
      paths: ['/home/me/a.txt'],
    });
    expect(calls.map((call) => call.file)).toEqual(['zenity', 'kdialog']);

    calls.length = 0;
    programs.zenity = () => exit(1, '(zenity:123): Gtk-WARNING **: cannot open display: :0');
    expect((await pickWithSystemDialog(request, linuxDesktop).result).status).toBe('picked');
    expect(calls.map((call) => call.file)).toEqual(['zenity', 'kdialog']);
  });

  it('stops at Cancel', async () => {
    programs.zenity = () => exit(1);
    programs.kdialog = () => ({ stdout: '/home/me/a.txt\n' });
    expect(await pickWithSystemDialog(request, linuxDesktop).result).toEqual({
      status: 'cancelled',
    });
    expect(calls.map((call) => call.file)).toEqual(['zenity']);

    programs.osascript = () => exit(1, 'execution error: User canceled. (-128)');
    const mac = { platform: 'darwin', home: '/Users/me', wsl: null, env: {} };
    expect((await pickWithSystemDialog(request, mac).result).status).toBe('cancelled');

    // PowerShell prints nothing when the dialog is cancelled.
    programs['powershell.exe'] = () => ({ stdout: '' });
    const win = { platform: 'win32', home: 'C:\\Users\\me', wsl: null, env: {} };
    expect((await pickWithSystemDialog(request, win).result).status).toBe('cancelled');
  });

  it('says when no dialog could be shown, so the terminal asks instead', async () => {
    const none = pickWithSystemDialog(request, { ...linuxDesktop, env: {} });
    expect(none.dialog).toBe(false);
    expect((await none.result).status).toBe('unavailable');
    expect(calls).toEqual([]);

    // Neither program is installed.
    expect((await pickWithSystemDialog(request, linuxDesktop).result).status).toBe('unavailable');
    expect(calls.map((call) => call.file)).toEqual(['zenity', 'kdialog']);

    // macOS without a GUI session.
    programs.osascript = () => exit(1, 'execution error: No user interaction allowed. (-1713)');
    const mac = { platform: 'darwin', home: '/Users/me', wsl: null, env: {} };
    expect((await pickWithSystemDialog(request, mac).result).status).toBe('unavailable');
  });

  it('turns the Windows dialog’s paths into WSL paths', async () => {
    programs['powershell.exe'] = () => ({
      stdout: '\uFEFFC:\\Users\\me\\My Report.pdf\r\n\\\\wsl.localhost\\Ubuntu\\home\\me\\a.txt',
    });
    const wsl = {
      platform: 'linux',
      home: '/home/me',
      wsl: { mountRoot: '/mnt/', distro: 'Ubuntu' },
      env: {},
    };
    expect(await pickWithSystemDialog(request, wsl).result).toEqual({
      status: 'picked',
      paths: ['/mnt/c/Users/me/My Report.pdf', '/home/me/a.txt'],
    });
  });

  it('closes the dialog on cancel()', async () => {
    let finish;
    programs.zenity = () => {
      throw new Error('not reached');
    };
    const { execFile } = await import('node:child_process');
    execFile.mockImplementationOnce((file, args, options, callback) => {
      calls.push({ file, args });
      finish = callback;
      return {
        stdin: { end() {} },
        kill: vi.fn(() =>
          finish(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }), '', ''),
        ),
      };
    });
    const pick = pickWithSystemDialog(request, linuxDesktop);
    await new Promise((resolve) => setTimeout(resolve, 0));
    pick.cancel();
    expect(await pick.result).toEqual({ status: 'cancelled' });
    expect(calls.map((call) => call.file)).toEqual(['zenity']);
  });
});
