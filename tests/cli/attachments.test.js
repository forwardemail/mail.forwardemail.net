/**
 * Attaching files in the terminal (src/cli/attachments.ts): file paths as
 * terminals paste them when a file is dropped, Tab completion, reading the
 * files, FileReader, and the compose window's file input on a real TermDOM
 * document driven by terminal input.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TermDOM } from '@b9g/termdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_BYTES,
  formatSize,
  installAttachments,
  mimeTypeOf,
  readFiles,
} from '../../src/cli/attachments';
import { completePath, parseDroppedPaths } from '../../src/cli/file-paths';
import { FileReader } from '../../src/cli/file-reader';
import { installHints } from '../../src/cli/hints';

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

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const mac = { platform: 'darwin', home: '/Users/me', wsl: null };
const linux = { platform: 'linux', home: '/home/me', wsl: null };
const windows = { platform: 'win32', home: 'C:\\Users\\me', wsl: null };
const wsl = { platform: 'linux', home: '/home/me', wsl: { mountRoot: '/mnt/', distro: 'Ubuntu' } };

describe('dropped file paths', () => {
  it('reads macOS Terminal and iTerm2 drops: backslash escapes and a trailing space', () => {
    expect(parseDroppedPaths('/Users/me/My\\ Report\\ \\(final\\).pdf ', mac)).toEqual([
      '/Users/me/My Report (final).pdf',
    ]);
    expect(parseDroppedPaths('/Users/me/a\\ b.txt /Users/me/c.png ', mac)).toEqual([
      '/Users/me/a b.txt',
      '/Users/me/c.png',
    ]);
  });

  it('reads single- and double-quoted paths (GNOME Terminal, WezTerm)', () => {
    expect(parseDroppedPaths("'/home/me/My Report.pdf' '/home/me/b.txt' ", linux)).toEqual([
      '/home/me/My Report.pdf',
      '/home/me/b.txt',
    ]);
    // A quote inside a name, the way a shell quotes it.
    expect(parseDroppedPaths("'/home/me/Bob'\\''s notes.txt'", linux)).toEqual([
      "/home/me/Bob's notes.txt",
    ]);
    expect(parseDroppedPaths('"/home/me/a \\"b\\".txt"', linux)).toEqual(['/home/me/a "b".txt']);
  });

  it('reads file:// URIs, percent-decoded, with or without a host', () => {
    expect(parseDroppedPaths('file:///home/me/My%20Report.pdf', linux)).toEqual([
      '/home/me/My Report.pdf',
    ]);
    expect(
      parseDroppedPaths(
        'file://localhost/home/me/a%20b.txt\r\nfile://laptop/home/me/%C3%A9t%C3%A9.txt\r\n',
        linux,
      ),
    ).toEqual(['/home/me/a b.txt', '/home/me/été.txt']);
    expect(parseDroppedPaths('file:///C:/Users/me/My%20Report.pdf', windows)).toEqual([
      'C:\\Users\\me\\My Report.pdf',
    ]);
  });

  it('reads Windows Terminal drops: quoted drive paths, several at once', () => {
    expect(parseDroppedPaths('"C:\\Users\\me\\My Report.pdf"', windows)).toEqual([
      'C:\\Users\\me\\My Report.pdf',
    ]);
    expect(
      parseDroppedPaths(
        '"C:\\Users\\me\\a b.txt" C:\\Users\\me\\c.txt \\\\server\\share\\d.txt',
        windows,
      ),
    ).toEqual(['C:\\Users\\me\\a b.txt', 'C:\\Users\\me\\c.txt', '\\\\server\\share\\d.txt']);
    // mintty (Git Bash) writes the drive as /c/.
    expect(parseDroppedPaths('/c/Users/me/report.pdf', windows)).toEqual([
      'C:\\Users\\me\\report.pdf',
    ]);
  });

  it('turns Windows paths into WSL paths under WSL', () => {
    expect(parseDroppedPaths('"C:\\Users\\me\\My Report.pdf"', wsl)).toEqual([
      '/mnt/c/Users/me/My Report.pdf',
    ]);
    expect(parseDroppedPaths('\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.txt', wsl)).toEqual([
      '/home/me/notes.txt',
    ]);
    // Newer Windows Terminal versions translate the path themselves.
    expect(parseDroppedPaths("'/mnt/d/Photos/a b.jpg'", wsl)).toEqual(['/mnt/d/Photos/a b.jpg']);
    // Without WSL a Windows path is no path at all.
    expect(parseDroppedPaths('"C:\\Users\\me\\a.txt"', linux)).toBeNull();
  });

  it('expands ~ to the home directory', () => {
    expect(parseDroppedPaths('~/Documents/a.txt', linux)).toEqual(['/home/me/Documents/a.txt']);
    expect(parseDroppedPaths('~\\Desktop\\a.txt', windows)).toEqual([
      'C:\\Users\\me\\Desktop\\a.txt',
    ]);
  });

  it('reads one path per line, and a whole line when its words are not paths', () => {
    expect(parseDroppedPaths('/home/me/a.txt\n/home/me/b.txt\n', linux)).toEqual([
      '/home/me/a.txt',
      '/home/me/b.txt',
    ]);
    // Alacritty pastes a dropped path as it is, spaces and all.
    const exists = (file) => file === '/home/me/My Report.pdf';
    expect(parseDroppedPaths('/home/me/My Report.pdf', linux, { exists })).toEqual([
      '/home/me/My Report.pdf',
    ]);
  });

  it('says text that is not a list of paths is not one', () => {
    for (const text of [
      '',
      'Hello there',
      'see /home/me/a.txt',
      'relative/path.txt',
      'https://example.com/a.pdf',
      "'/home/me/unclosed.txt",
      '/home/me/a.txt\nand some words',
      `/home/me/a.txt\u0007`,
    ]) {
      expect(parseDroppedPaths(text, linux), JSON.stringify(text)).toBeNull();
    }
  });

  it('takes relative paths when given a directory to resolve them against', () => {
    expect(parseDroppedPaths('docs/a.txt', linux, { relativeTo: '/home/me' })).toEqual([
      '/home/me/docs/a.txt',
    ]);
  });
});

describe('Tab completion of a typed path', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-complete-'));
    fs.writeFileSync(path.join(dir, 'report-2025.pdf'), 'a');
    fs.writeFileSync(path.join(dir, 'report-2026.pdf'), 'b');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'c');
    fs.writeFileSync(path.join(dir, '.hidden'), 'd');
    fs.mkdirSync(path.join(dir, 'Photos'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = () => ({ ...linux, home: dir, cwd: dir });

  it('fills in a single match, with a slash after a folder', async () => {
    expect(await completePath(`${dir}/no`, context())).toEqual({
      value: `${dir}/notes.txt`,
      matches: [],
    });
    expect(await completePath('Ph', context())).toEqual({ value: 'Photos/', matches: [] });
    expect(await completePath('~/ph', context())).toEqual({ value: '~/Photos/', matches: [] });
  });

  it('fills in what several matches share and lists them', async () => {
    expect(await completePath(`${dir}/re`, context())).toEqual({
      value: `${dir}/report-202`,
      matches: ['report-2025.pdf', 'report-2026.pdf'],
    });
  });

  it('leaves hidden files out unless asked for, and keeps text without matches', async () => {
    expect((await completePath(`${dir}/`, context())).matches).not.toContain('.hidden');
    expect(await completePath(`${dir}/.h`, context())).toEqual({
      value: `${dir}/.hidden`,
      matches: [],
    });
    expect(await completePath(`${dir}/zzz`, context())).toEqual({
      value: `${dir}/zzz`,
      matches: [],
    });
  });
});

describe('reading files to attach', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-read-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('gives each file its name, type and bytes', async () => {
    const pdf = path.join(dir, 'My Report.pdf');
    fs.writeFileSync(pdf, '%PDF-1.4 test');
    const { files, problems } = await readFiles([pdf, path.join(dir, 'none.txt')]);
    expect(problems).toEqual([`Not found: ${path.join(dir, 'none.txt')}`]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('My Report.pdf');
    expect(files[0].type).toBe('application/pdf');
    expect(Buffer.from(await files[0].arrayBuffer()).toString()).toBe('%PDF-1.4 test');
  });

  it('skips folders', async () => {
    fs.mkdirSync(path.join(dir, 'Photos'));
    const { files, problems } = await readFiles([path.join(dir, 'Photos')]);
    expect(files).toEqual([]);
    expect(problems).toEqual(['Not attached: Photos is a folder']);
  });

  it('keeps to the size the server takes in one message', async () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(39_321_600);
    expect(formatSize(MAX_ATTACHMENT_BYTES)).toBe('37.5 MB');
    // A sparse file: its size is known without writing 40 MB.
    const big = path.join(dir, 'big.iso');
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 40 * 1024 * 1024);
    const { files, problems } = await readFiles([big]);
    expect(files).toEqual([]);
    expect(problems).toEqual(['Too large to attach: big.iso (40 MB). The limit is 37.5 MB.']);

    // The limit is for all the files together.
    fs.writeFileSync(path.join(dir, 'a.txt'), '123456');
    fs.writeFileSync(path.join(dir, 'b.txt'), '123456');
    const pair = await readFiles([path.join(dir, 'a.txt'), path.join(dir, 'b.txt')], { limit: 10 });
    expect(pair.files.map((file) => file.name)).toEqual(['a.txt']);
    expect(pair.problems).toEqual(['Not attached: b.txt would make the message larger than 10 B']);

    // So are the attachments the message has already.
    const more = await readFiles([path.join(dir, 'a.txt')], { limit: 10, already: 5 });
    expect(more.files).toEqual([]);
    expect(more.problems).toEqual(['Not attached: a.txt would make the message larger than 10 B']);
    expect(
      (await readFiles([path.join(dir, 'a.txt')], { limit: 10, already: 4 })).files,
    ).toHaveLength(1);
  });

  it('types files by extension, as a browser does', () => {
    expect(mimeTypeOf('a.PDF')).toBe('application/pdf');
    expect(mimeTypeOf('photo.jpeg')).toBe('image/jpeg');
    expect(mimeTypeOf('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeTypeOf('archive.unknownext')).toBe('');
  });
});

describe('FileReader', () => {
  const read = (method, blob, ...args) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      const events = [];
      for (const type of ['loadstart', 'load', 'loadend']) {
        reader.addEventListener(type, () => events.push(type));
      }
      reader.onload = () => resolve({ result: reader.result, events, reader });
      reader.onerror = () => reject(reader.error);
      reader[method](blob, ...args);
      expect(reader.readyState).toBe(FileReader.LOADING);
    });

  it('reads a file as a data URL, text and bytes, and reports like a browser', async () => {
    const file = new File(['héllo'], 'a.txt', { type: 'text/plain' });
    const url = await read('readAsDataURL', file);
    expect(url.result).toBe(`data:text/plain;base64,${Buffer.from('héllo').toString('base64')}`);
    expect(url.reader.readyState).toBe(FileReader.DONE);
    await tick(0);
    expect(url.events).toEqual(['loadstart', 'load', 'loadend']);

    expect((await read('readAsText', file)).result).toBe('héllo');
    const bytes = (await read('readAsArrayBuffer', file)).result;
    expect(Buffer.from(bytes).toString()).toBe('héllo');
    // An untyped file is described as bytes.
    expect((await read('readAsDataURL', new Blob(['x']))).result).toBe(
      'data:application/octet-stream;base64,eA==',
    );
  });

  it('reports a failed read as an error, and nothing after abort()', async () => {
    const broken = { type: '', arrayBuffer: () => Promise.reject(new Error('EIO')) };
    await expect(read('readAsText', broken)).rejects.toThrow('EIO');

    const reader = new FileReader();
    let loaded = false;
    reader.onload = () => (loaded = true);
    reader.readAsText(new Blob(['x']));
    reader.abort();
    await tick(10);
    expect(loaded).toBe(false);
    expect(reader.result).toBeNull();
  });
});

// A compose window as the app draws it, for what attachments.ts looks for:
// the To and Subject fields, the message body and the hidden file input.
// The input's change handler reads the files the way Compose.svelte's
// processSelectedFiles does, through FileReader, and the window counts the
// bytes of its attachments in data-attachment-bytes, as Compose.svelte does.
const COMPOSE = `<body>
  <div data-testid="compose-modal" role="dialog" style="height: 20px" data-attachment-bytes="0">
    <input id="to" placeholder="To">
    <input id="subject" placeholder="Subject">
    <textarea id="body"></textarea>
    <input type="file" multiple class="attach-input hidden">
  </div>
</body>`;

function composeTerminal({ pick, html = COMPOSE, cwd, limit } = {}) {
  let push;
  const readable = new ReadableStream({
    start(controller) {
      push = (text) => controller.enqueue(text);
    },
  });
  const term = new TermDOM({
    html,
    transport: { ...quietTransport(100, 30), interactive: true, readable },
  });
  const win = term.window;
  win.FileReader = FileReader;
  const attachments = [];
  const cancelled = [];
  const notices = [];
  const toasts = [];
  const input = term.document.querySelector('input[type="file"]');
  const count = () =>
    term.document
      .querySelector('[data-testid="compose-modal"]')
      ?.setAttribute(
        'data-attachment-bytes',
        String(attachments.reduce((sum, attachment) => sum + attachment.size, 0)),
      );
  input?.addEventListener('change', async (event) => {
    for (const file of event.target.files) {
      const reader = new win.FileReader();
      const content = await new Promise((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      attachments.push({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        size: file.size,
        content,
      });
    }
    count();
  });
  input?.addEventListener('cancel', () => cancelled.push(true));
  win.addEventListener('fe-terminal-notice', (event) => notices.push(event.detail));
  win.addEventListener('fe:mail-service-toast', (event) => toasts.push(event.detail));
  const picks = [];
  installAttachments(win, {
    context: linux,
    env: {},
    cwd: () => cwd ?? os.tmpdir(),
    limit,
    pick: (request, environment) => {
      picks.push({ request, environment });
      return pick(request);
    },
  });
  return {
    term,
    win,
    document: term.document,
    type: (text) => push(text),
    paste: (text) => push(`\x1b[200~${text}\x1b[201~`),
    attachments,
    // The ✕ on an attachment.
    remove: (filename) => {
      attachments.splice(
        attachments.findIndex((attachment) => attachment.filename === filename),
        1,
      );
      count();
    },
    cancelled,
    notices,
    toasts,
    picks,
  };
}

const unavailable = () => ({
  dialog: false,
  result: Promise.resolve({ status: 'unavailable', reason: 'no display' }),
  cancel() {},
});

async function waitUntil(test, timeout = 3000) {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > timeout) throw new Error('timed out');
    await tick(20);
  }
}

describe('attaching in the compose window', () => {
  let dir;
  let session;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forwardemail-attach-'));
  });
  afterEach(async () => {
    await session?.term.dispose();
    session = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attaches files dropped on the message (pasted paths) instead of typing them', async () => {
    const report = path.join(dir, 'My Report.pdf');
    const notes = path.join(dir, 'notes.txt');
    fs.writeFileSync(report, '%PDF-1.4 report');
    fs.writeFileSync(notes, 'some notes');
    session = composeTerminal({ pick: unavailable });
    await session.term.attach();
    const body = session.document.getElementById('body');
    body.focus();
    // macOS Terminal: escaped spaces and a trailing space.
    session.paste(`${report.replace(/ /g, '\\ ')} ${notes} `);
    await waitUntil(() => session.attachments.length === 2);

    expect(body.value).toBe('');
    expect(session.attachments).toEqual([
      {
        filename: 'My Report.pdf',
        contentType: 'application/pdf',
        size: 15,
        content: Buffer.from('%PDF-1.4 report').toString('base64'),
      },
      {
        filename: 'notes.txt',
        contentType: 'text/plain',
        size: 10,
        content: Buffer.from('some notes').toString('base64'),
      },
    ]);
    // No hint bar here, so the app's toast says it.
    expect(session.toasts).toEqual([
      { message: 'Attached My Report.pdf, notes.txt', type: 'success' },
    ]);
  });

  it('attaches a dropped file:// URI and reports it on the hint bar', async () => {
    const file = path.join(dir, 'a b.txt');
    fs.writeFileSync(file, 'x');
    session = composeTerminal({ pick: unavailable });
    installHints(session.win, { columns: () => 100 });
    await session.term.attach();
    session.document.getElementById('body').focus();
    session.paste(`file://${file.replace(/ /g, '%20')}\r\n`);
    await waitUntil(() => session.attachments.length === 1);
    expect(session.attachments[0].filename).toBe('a b.txt');
    expect(session.notices).toEqual([{ text: 'Attached a b.txt', failed: false }]);
    await tick();
    expect(session.document.getElementById('fe-terminal-hints').textContent).toContain(
      '✓ Attached a b.txt',
    );
  });

  it('leaves pasted text alone: in To and Subject, and when the paths do not exist', async () => {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    session = composeTerminal({ pick: unavailable });
    await session.term.attach();
    const subject = session.document.getElementById('subject');
    subject.focus();
    session.paste(file);
    await tick(100);
    expect(subject.value).toBe(file);

    const body = session.document.getElementById('body');
    body.focus();
    session.paste('/no/such/file.txt');
    await tick(100);
    expect(body.value).toBe('/no/such/file.txt');
    session.paste(' and some words');
    await tick(100);
    expect(body.value).toBe('/no/such/file.txt and some words');
    expect(session.attachments).toEqual([]);
  });

  it('skips a dropped folder and a missing file, and says so', async () => {
    const folder = path.join(dir, 'Photos');
    fs.mkdirSync(folder);
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    session = composeTerminal({ pick: unavailable });
    installHints(session.win, { columns: () => 200 });
    await session.term.attach();
    const body = session.document.getElementById('body');
    body.focus();
    session.paste(`'${folder}'`);
    await waitUntil(() => session.notices.length === 1);
    expect(session.notices[0]).toEqual({ text: 'Not attached: Photos is a folder', failed: true });
    expect(body.value).toBe('');
    expect(session.attachments).toEqual([]);

    session.paste(`${file}\n${path.join(dir, 'gone.txt')}`);
    await waitUntil(() => session.notices.length === 2);
    expect(session.attachments.map((a) => a.filename)).toEqual(['a.txt']);
    expect(session.notices[1]).toEqual({
      text: `Attached a.txt. Not found: ${path.join(dir, 'gone.txt')}`,
      failed: true,
    });
    await tick();
    expect(session.document.getElementById('fe-terminal-hints').textContent).toContain(
      '✗ Attached a.txt',
    );
  });

  it('counts the attachments the message has when files are dropped one after another', async () => {
    const make = (name, size) => {
      fs.writeFileSync(path.join(dir, name), 'x'.repeat(size));
      return path.join(dir, name);
    };
    const first = make('first.txt', 60);
    const second = make('second.txt', 50);
    const third = make('third.txt', 30);
    session = composeTerminal({ pick: unavailable, limit: 100 });
    installHints(session.win, { columns: () => 200 });
    await session.term.attach();
    session.document.getElementById('body').focus();

    session.paste(first);
    await waitUntil(() => session.notices.length === 1);
    expect(session.attachments.map((a) => a.filename)).toEqual(['first.txt']);

    // 60 + 50 is over the limit of 100, though each drop is under it.
    session.paste(second);
    await waitUntil(() => session.notices.length === 2);
    expect(session.notices[1]).toEqual({
      text: 'Not attached: second.txt would make the message larger than 100 B',
      failed: true,
    });
    expect(session.attachments.map((a) => a.filename)).toEqual(['first.txt']);

    // Two drops at once: the second counts the first.
    session.paste(third);
    session.paste(third.replace('third', 'second'));
    await waitUntil(() => session.notices.length === 4);
    expect(session.attachments.map((a) => a.filename)).toEqual(['first.txt', 'third.txt']);
    expect(session.notices[3].failed).toBe(true);

    // Removing an attachment makes room again.
    session.remove('first.txt');
    session.paste(second);
    await waitUntil(() => session.notices.length === 5);
    expect(session.notices[4]).toEqual({ text: 'Attached second.txt', failed: false });
    expect(session.attachments.map((a) => a.filename)).toEqual(['third.txt', 'second.txt']);
  });

  it('opens the system file dialog on Attach and attaches what is chosen', async () => {
    const file = path.join(dir, 'chosen.png');
    fs.writeFileSync(file, 'PNG');
    session = composeTerminal({
      pick: () => ({
        dialog: true,
        result: Promise.resolve({ status: 'picked', paths: [file] }),
        cancel() {},
      }),
    });
    await session.term.attach();
    // The app's Attach button clicks the hidden input.
    session.document.querySelector('input[type="file"]').click();
    await waitUntil(() => session.attachments.length === 1);
    expect(session.picks).toHaveLength(1);
    expect(session.picks[0].request).toEqual({ title: 'Attach files', multiple: true });
    expect(session.attachments[0]).toMatchObject({
      filename: 'chosen.png',
      contentType: 'image/png',
      content: Buffer.from('PNG').toString('base64'),
    });
  });

  it('sends cancel when the dialog is cancelled, and Esc closes an open dialog', async () => {
    let cancel;
    session = composeTerminal({
      pick: () => {
        let resolve;
        const result = new Promise((done) => (resolve = done));
        cancel = () => resolve({ status: 'cancelled' });
        return { dialog: true, result, cancel: () => cancel() };
      },
    });
    installHints(session.win, { columns: () => 200 });
    await session.term.attach();
    session.document.getElementById('body').focus();
    // Ctrl+O, as typed.
    session.type('\x0f');
    await waitUntil(() => session.picks.length === 1);
    await tick();
    expect(session.document.getElementById('fe-terminal-hints').textContent).toContain(
      'Choose files in the file dialog',
    );
    session.type('\x1b');
    await waitUntil(() => session.cancelled.length === 1);
    expect(session.attachments).toEqual([]);
    expect(session.document.documentElement.hasAttribute('data-fe-picking')).toBe(false);
  });

  it('asks for a path in the terminal when there is no file dialog, with Tab completion', async () => {
    fs.writeFileSync(path.join(dir, 'quarterly-report.csv'), 'a,b\n1,2\n');
    session = composeTerminal({ pick: unavailable, cwd: dir });
    installHints(session.win, { columns: () => 200 });
    await session.term.attach();
    const body = session.document.getElementById('body');
    body.focus();
    session.type('\x0f');
    await waitUntil(() => session.document.getElementById('fe-terminal-attach'));
    const field = session.document.querySelector('#fe-terminal-attach input');
    expect(session.document.activeElement).toBe(field);
    await tick();
    expect(session.document.getElementById('fe-terminal-hints').textContent).toMatch(
      /Tab Complete.*Enter Attach.*Esc Cancel/,
    );

    // A relative path, completed with Tab, then Enter.
    session.type('quar\t');
    await waitUntil(() => field.value === 'quarterly-report.csv');
    session.type('\r');
    await waitUntil(() => session.attachments.length === 1);
    expect(session.attachments[0]).toMatchObject({
      filename: 'quarterly-report.csv',
      contentType: 'text/csv',
      content: Buffer.from('a,b\n1,2\n').toString('base64'),
    });
    expect(session.document.getElementById('fe-terminal-attach')).toBeNull();
    // Focus goes back to where it was.
    expect(session.document.activeElement).toBe(body);
  });

  it('cancels the path prompt with Esc', async () => {
    session = composeTerminal({ pick: unavailable, cwd: dir });
    await session.term.attach();
    session.document.querySelector('input[type="file"]').click();
    await waitUntil(() => session.document.getElementById('fe-terminal-attach'));
    session.type('something');
    await tick();
    session.type('\x1b');
    await waitUntil(() => session.cancelled.length === 1);
    expect(session.document.getElementById('fe-terminal-attach')).toBeNull();
    expect(session.attachments).toEqual([]);
  });
});

describe('the compose hint bar', () => {
  // The hint bar over a compose window, as wide as `columns`.
  const bar = async (columns) => {
    const term = new TermDOM({ html: COMPOSE, transport: quietTransport(columns, 24) });
    term.document.body.classList.add('mailbox-mode');
    const shortcuts = globalThis.__forwardemailShortcuts;
    globalThis.__forwardemailShortcuts = {
      getShortcutsList: () => [{ key: 'ctrl+s', originalKey: 'ctrl+s', action: 'save-draft' }],
    };
    try {
      installHints(term.window, { columns: () => columns });
      return term.document.getElementById('fe-terminal-hints').textContent;
    } finally {
      globalThis.__forwardemailShortcuts = shortcuts;
    }
  };

  it('shows Ctrl+O Attach where it fits, and keeps Quit on a narrow row', async () => {
    expect(await bar(120)).toBe(
      'Tab Next fieldShift+Tab PreviousCtrl+S Save draftCtrl+O AttachCtrl+C Quit',
    );
    // 80 columns, the phone layout: Attach gives way to Quit.
    expect(await bar(80)).toBe('Tab Next fieldShift+Tab PreviousCtrl+S Save draftCtrl+C Quit');
    // 70 columns, the narrowest the end-to-end tests use: Shift+Tab goes too.
    expect(await bar(70)).toBe('Tab Next fieldCtrl+S Save draftCtrl+C Quit');
  });
});
