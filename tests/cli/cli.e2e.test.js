/**
 * End-to-end tests of the built terminal client (pnpm build:cli):
 * the command line, and the webmail itself driven through a real
 * pseudo-terminal with the demo account.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI, KEYS, canRunInteractive, runCli, startTerminal, tempHome } from './terminal.js';

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing; run pnpm build:cli first (pnpm test:cli does).`);
  }
});

describe('command line', () => {
  it('prints its version', () => {
    const result = runCli(['--version'], { home: tempHome() });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(runCli(['-v'], { home: tempHome() }).stdout.trim()).toBe(pkg.version);
  });

  it('prints help with the commands, options and the data directory', () => {
    const home = tempHome();
    const result = runCli(['--help'], { home });
    expect(result.status).toBe(0);
    for (const text of ['forwardemail update', 'forwardemail logout', '--demo', '--api', home]) {
      expect(result.stdout).toContain(text);
    }
  });

  it('rejects an unknown command and an unknown option', () => {
    const command = runCli(['frobnicate'], { home: tempHome() });
    expect(command.status).toBe(2);
    expect(command.stderr).toContain('unknown command "frobnicate"');

    const option = runCli(['--frobnicate'], { home: tempHome() });
    expect(option.status).toBe(2);
    expect(option.stderr).toContain('--frobnicate');
  });

  it('refuses to start without an interactive terminal', () => {
    const result = runCli([], { home: tempHome(), input: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('needs an interactive terminal');
  });

  it('logout removes the stored session and leaves other files alone', () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'local-storage.json'), '{"webmail_email":"a@b.c"}');
    fs.writeFileSync(path.join(home, 'user.css'), '');
    const result = runCli(['logout'], { home });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Signed out');
    expect(fs.existsSync(path.join(home, 'local-storage.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'user.css'))).toBe(true);

    expect(runCli(['logout'], { home }).stdout).toContain('Nothing to remove');
  });

  it('keeps its data in the directory given with --data-dir', () => {
    const home = tempHome();
    const chosen = path.join(home, 'chosen dir');
    const help = runCli(['--data-dir', chosen, '--help'], { home });
    expect(help.stdout).toContain(chosen);

    fs.mkdirSync(chosen);
    fs.writeFileSync(path.join(chosen, 'local-storage.json'), '{}');
    fs.writeFileSync(path.join(home, 'local-storage.json'), '{}');
    expect(runCli(['--data-dir', chosen, 'logout'], { home }).stdout).toContain(chosen);
    expect(fs.existsSync(path.join(chosen, 'local-storage.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, 'local-storage.json'))).toBe(true);
  });

  it('reports desktop notifications: off when asked, and the notifier for this system', () => {
    const off = runCli(['notifications'], {
      home: tempHome(),
      env: { FORWARDEMAIL_NOTIFICATIONS: '0' },
    });
    expect(off.status).toBe(0);
    expect(off.stdout).toContain('off here (turned off)');

    // macOS and Windows use a program shipped with the client
    // (cli/dist/notifier); Linux uses the system's notify-send.
    const on = runCli(['notifications'], {
      home: tempHome(),
      env: { FORWARDEMAIL_NOTIFICATIONS: '1', DISPLAY: ':0', SSH_CONNECTION: '' },
    });
    if (process.platform === 'darwin' || process.platform === 'win32') {
      expect(on.status).toBe(0);
      const program = on.stdout.match(/program: (.+)/)?.[1];
      expect(program).toBeTruthy();
      expect(fs.existsSync(program)).toBe(true);
      expect(on.stdout).toContain('not turned on yet');
    } else {
      expect(on.stdout).toMatch(/notify-send/);
    }
  });

  it('update reports that a source checkout updates with git', () => {
    const result = runCli(['update'], { home: tempHome() });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('git pull');
  });
});

// The rich-text formatting toolbar: bold, italic, underline.
const FORMATTING = /B {2,3}I {2,3}U/;

// The plain/rich switch is the T (plain) or ≣ (rich) button just before Save
// (⤓) in the compose toolbar.
function switchTextMode(session) {
  const save = session.locate('⤓');
  const row = session.screen().split('\n')[save.row - 1];
  const at = Math.max(row.lastIndexOf('T', save.col - 1), row.lastIndexOf('≣', save.col - 1));
  session.clickAt(at + 1, save.row);
}

// Scroll bars (src/cli/scrollbars.ts): a track of │ with a thumb of █.
const cellsOf = (line) => [...line];
// The column of the first scroll bar thumb right of a column, or -1.
function barColumn(screen, from = 0) {
  let found = -1;
  for (const line of screen.split('\n')) {
    const col = cellsOf(line).indexOf('█', from);
    if (col !== -1 && (found === -1 || col < found)) found = col;
  }
  return found;
}
// The screen rows the thumb fills in a column.
function thumbRows(screen, col) {
  return screen.split('\n').flatMap((line, row) => (cellsOf(line)[col] === '█' ? [row] : []));
}
const PASTE = (text) => `\u001b[200~${text}\u001b[201~`;

describe.runIf(canRunInteractive)('in a terminal', () => {
  let session;
  afterEach(async () => {
    await session?.stop();
    session = null;
  });

  it('shows the sign-in screen', async () => {
    session = startTerminal({ home: tempHome() });
    const form = ['Forward Email', 'you@example.com', 'Password', 'Sign In', 'Try Demo'];
    await session.waitFor((text) => form.every((part) => text.includes(part)), {
      label: 'the sign-in form',
    });
  });

  it('applies user.css from the data directory over the built-in styles', async () => {
    const home = tempHome();
    fs.writeFileSync(path.join(home, 'user.css'), ':root, .dark { --fe-primary: #b45309; }\n');
    session = startTerminal({ home });
    await session.waitFor('Try Demo');
    expect(session.colorsAt('Sign In').bg).toBe(0xb45309);

    // Without it, the stock primary color.
    await session.stop();
    session = startTerminal({ home: tempHome() });
    await session.waitFor('Try Demo');
    expect(session.colorsAt('Sign In').bg).not.toBe(0xb45309);
  });

  it('reads mail in the demo account: list, message body, keyboard navigation', async () => {
    const home = tempHome();
    session = startTerminal({ home, args: ['--demo'] });

    // The mailbox: folders, the message list with senders and subjects.
    let screen = await session.waitFor('Welcome to Forward Email!');
    for (const text of ['Inbox', 'Sent', 'Forward Email Team', 'Privacy Monitor', 'Compose']) {
      expect(screen).toContain(text);
    }

    // Down arrow opens the first message; its body is rendered from the
    // message frame, not just the list preview.
    session.type(KEYS.down);
    screen = await session.waitFor('To: Demo User');
    screen = await session.waitFor('The Forward Email Team', { label: 'the message body' });
    expect(screen).toContain('Feel free to click around');

    // Next message.
    session.type(KEYS.down);
    await session.waitFor('Privacy Monitor <privacy@forwardemail.net>');

    // The session was stored where FORWARDEMAIL_HOME points.
    expect(fs.existsSync(path.join(home, 'local-storage.json'))).toBe(true);
  });

  it('composes a message: recipient, subject and a plain-text body', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.ctrlN);
    await session.waitFor('Subject');
    expect(session.screen()).toContain('New message');

    // The recipient field has focus; an address becomes a chip.
    session.type('bob@example.org,');
    await session.waitFor('bob@example.org  ✕');

    session.click('Subject');
    session.type('Quarterly plan');
    await session.waitFor('Quarterly plan');

    // Tab moves on into the body, where Enter starts a new line.
    session.type(KEYS.tab);
    session.type('Hi Bob, here is the plan.');
    session.type(KEYS.enter);
    session.type('Second line.');
    const screen = await session.waitFor('Second line.');
    const lines = screen.split('\n');
    const first = lines.findIndex((line) => line.includes('Hi Bob, here is the plan.'));
    expect(first).toBeGreaterThan(-1);
    expect(lines[first + 1]).toContain('Second line.');
    // Plain text is the terminal's default, so there is no formatting toolbar.
    expect(screen).not.toMatch(FORMATTING);
  });

  it('switches the compose window to rich text and back', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.ctrlN);
    await session.waitFor('Subject');
    switchTextMode(session);
    await session.waitFor((text) => FORMATTING.test(text), { label: 'the formatting toolbar' });
    switchTextMode(session);
    await session.waitFor((text) => !FORMATTING.test(text), {
      label: 'the formatting toolbar to go',
    });
  });

  it('quotes the message as text in a plain-text reply', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    session.type('r');
    const screen = await session.waitFor('> Thanks for trying out Forward Email webmail.');
    expect(screen).toContain('wrote:');
    expect(screen).not.toContain('<blockquote');
    expect(screen).not.toContain('<p');
  });

  it('moves between views through the app router: settings, contacts, calendar', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');

    session.click('Settings');
    let screen = await session.waitFor('Appearance');
    expect(screen).toContain('Privacy & Security');
    expect(screen).toContain('Keyboard Shortcuts');

    session.type(KEYS.escape);
    session.click('‹');
    await session.waitFor('Welcome to Forward Email!');
    session.click('Contacts');
    screen = await session.waitFor('New Contact');
    expect(screen).toContain('alice@example.com');

    session.click('‹');
    await session.waitFor('Welcome to Forward Email!');
    session.click('Calendar');
    screen = await session.waitFor(
      (text) => ['Today', 'SUN', 'MON', 'SAT'].every((t) => text.includes(t)),
      {
        label: 'the month grid',
      },
    );
    expect(screen).toContain('Today');
  });

  it('shows the demo contacts by name and the demo events on the calendar, which open', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');

    session.click('Contacts');
    await session.waitFor('New Contact');
    // Names, not only addresses, in the list, and the phone number of the open contact
    await session.waitFor(
      (text) => ['Alice Johnson', 'Bob Smith', '+1-555-0101'].every((part) => text.includes(part)),
      { label: 'the contacts by name' },
    );

    session.click('‹');
    await session.waitFor('Welcome to Forward Email!');
    session.click('Calendar');
    const screen = await session.waitFor('Team Meeting', { label: 'the event in the month grid' });
    expect(screen).toContain('Lunch with Dave');

    // Opening an event shows it, and the client keeps running
    session.click('Team Meeting');
    await session.waitFor('Discuss Q4 roadmap', { label: 'the open event' });
  });

  it('saves a download to the downloads folder', async () => {
    const downloads = tempHome();
    session = startTerminal({
      home: tempHome(),
      args: ['--demo'],
      env: { FORWARDEMAIL_DOWNLOADS: downloads },
    });
    await session.waitFor('Welcome to Forward Email!');
    session.click('Contacts');
    await session.waitFor('alice@example.com');
    session.click('alice@example.com');
    await session.waitFor('…');
    session.click('…');
    await session.waitFor('Export vCard');
    session.click('Export vCard');
    await session.waitFor(`Saved to ${downloads}`);

    const files = fs.readdirSync(downloads);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.vcf$/);
    const vcard = fs.readFileSync(path.join(downloads, files[0]), 'utf8');
    expect(vcard).toContain('BEGIN:VCARD');
    expect(vcard).toContain('alice@example.com');
  });

  it('opens the shortcut list with ? and closes it with Esc', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type('?');
    // The dialog lists each action with its keys, inside the dialog.
    const screen = await session.waitFor(
      (text) => text.includes('Keyboard shortcuts') && text.includes('ctrl + n'),
      { label: 'the shortcut list' },
    );
    const row = screen.split('\n').find((line) => line.includes('New message'));
    expect(row).toContain('ctrl + n');
    session.type(KEYS.escape);
    await session.waitFor((text) => !text.includes('Keyboard shortcuts'), {
      label: 'the dialog to close',
    });
  });

  it('Esc closes a menu first, then goes back from an open message', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');

    // The sort menu opens beside its button, at its own width.
    session.click('⏷');
    const menu = await session.waitFor(
      (text) => text.includes('SORT BY') && text.includes('Newest first'),
      { label: 'the sort menu' },
    );
    const row = menu
      .split('\n')
      .find((line) => line.includes('Newest first'))
      // The message list's scroll bar on the right edge is not the menu.
      .replace(/\s{2,}[│█]\s*$/, '');
    expect(row.indexOf('Newest first')).toBeGreaterThan(20);
    expect(row.trimEnd().length - row.indexOf('Newest first')).toBeLessThan(40);
    session.type(KEYS.escape);
    await session.waitFor((text) => !text.includes('SORT BY'), { label: 'the menu to close' });

    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    session.type(KEYS.escape);
    await session.waitFor((text) => !text.includes('To: Demo User') && text.includes('INBOX('), {
      label: 'the message list',
    });
  });

  it('asks for focus reports and does not read them as keys', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    expect(session.modes().sendFocusMode).toBe(true);
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    // Focus out and in, the way a terminal reports switching windows. Read
    // as keys, the ESC in them would go back from the message.
    session.type('\u001b[O');
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.type('\u001b[I');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(session.screen()).toContain('To: Demo User');
  });

  it('keeps the message list drawn while the pointer moves over it', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Privacy Monitor');
    const top = session.locate('Forward Email Team');
    // Over the second row and on down the list, then off it.
    for (const step of [4, 7, 10, 13, 25]) {
      session.hover(60, top.row + step);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const screen = session.screen();
    for (const text of [
      'Forward Email Team',
      'Welcome to Forward Email!',
      'Privacy Monitor',
      'Your weekly privacy report',
      'Alice Johnson',
    ]) {
      expect(screen).toContain(text);
    }
  });

  it('copies text selected with the mouse to the clipboard', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('This is a demo account');
    // Across the message body, which is drawn from the message's own HTML.
    const start = session.locate('This is a demo account');
    await session.drag(start, { col: start.col + 14, row: start.row });
    await session.waitFor((text) => text.split('\n').at(-1).includes('Copied'), {
      label: 'the copy notice',
    });
    expect(session.clipboard.at(-1)).toBe('This is a demo');
  });

  it('places the caret where the rich-text editor is clicked', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    session.type('r');
    await session.waitFor('wrote:');
    switchTextMode(session);
    await session.waitFor((text) => FORMATTING.test(text), { label: 'the formatting toolbar' });
    // Once the compose window has put the caret at the top, as it does.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const attribution = session.locate('wrote:');
    const line = session.screen().split('\n')[attribution.row - 1];
    session.clickAt(line.indexOf('On ') + 1, attribution.row);
    await new Promise((resolve) => setTimeout(resolve, 500));
    session.type('XYZ');
    await session.waitFor('XYZOn ');
    // The app reports errors as a toast; clicking used to raise one.
    expect(session.screen()).not.toContain('Something went wrong');
  });

  it('wraps a prompt inside its box', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    session.type('r');
    await session.waitFor('wrote:');
    session.type('Hello');
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The discard button at the end of the compose toolbar, after Send.
    const toolbar = session.locate('⤓');
    const row = session.screen().split('\n')[toolbar.row - 1];
    const discard = row.lastIndexOf('✖') + 1;
    expect(discard).toBeGreaterThan(toolbar.col);
    session.click('✖', toolbar.row - 1);
    const prompt = await session.waitFor('Discard draft?');
    const lines = prompt.split('\n');
    const title = lines.findIndex((line) => line.includes('Discard draft?'));
    const left = lines[title].lastIndexOf('│', lines[title].indexOf('Discard draft?'));
    const right = lines[title].indexOf('│', lines[title].indexOf('Discard draft?'));
    // The question wraps between the box's sides, and the buttons show.
    const body = lines.slice(title, title + 8).join('\n');
    expect(body).toContain('discard this draft?');
    expect(body).toContain('Cancel');
    expect(body).toContain('Discard');
    for (const line of lines.slice(title, title + 8)) {
      if (line.includes('Your message') || line.includes('discard this')) {
        expect(line.lastIndexOf('draft') < right || line.indexOf('Your') > left).toBe(true);
      }
    }
  });

  it('shows the label of an icon button in the bottom row while the pointer is on it', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    // The reader toolbar: ‹ ☆ ⊟ ✖ …, icon-only buttons.
    const back = session.locate('‹');
    session.hover(back.col, back.row);
    await session.waitFor((text) => text.split('\n').at(-1).trim().startsWith('Back'), {
      label: 'the button label on the bottom row',
    });
  });

  it('reads Esc followed by another key in one burst as two key presses', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    // A busy client reads both bytes at once; this is Esc, then Ctrl+N, not
    // Alt+Ctrl+N.
    session.type(`${KEYS.escape}${KEYS.ctrlN}`);
    await session.waitFor('New message');
    // The Esc did not go back from the message once the compose window was
    // opening: the message is still behind it.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(session.screen()).toContain('To: Demo Use');
  });

  it('keeps what is typed while a compose window opens for the message', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    // Typed at once: the letters must not reach the mailbox's one-key
    // shortcuts (e archives, j marks junk) before the To field has focus.
    // The sidebar's Inbox line, with its unread count.
    const unread = (text) =>
      text
        .split('\n')
        .find((line) => line.includes('Inbox'))
        .slice(0, 28);
    const before = unread(session.screen());
    session.type(`${KEYS.ctrlN}bob@example.org`);
    await session.waitFor('New message');
    const screen = await session.waitFor('bob@example.org');
    // Nothing was archived or marked read on the way.
    expect(unread(screen)).toBe(before);
  });

  it('puts what is typed right after r into the reply', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    // r opens the reply; the text typed with it goes into the reply's
    // editor, not to the mailbox's shortcuts (e would archive the message).
    session.type('rHello there');
    const screen = await session.waitFor('Hello there');
    expect(screen).toContain('Re: Welcome to Forward Email!');
  });

  it('draws the theme colors, including translucent and black ones', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    // The list toolbar is a translucent fill (color-mix); it is blended with
    // the page, not left to the terminal's own background.
    await session.waitFor(() => session.colorsAt('INBOX(').bg !== null, {
      label: 'the toolbar fill',
    });

    // In the light theme the calendar's day numbers are black, which is
    // drawn as black, not as the terminal's default foreground.
    session.click('☀');
    await session.waitFor('☾');
    session.click('Calendar');
    await session.waitFor((text) => ['SUN', 'MON', '14'].every((part) => text.includes(part)), {
      label: 'the month grid',
    });
    await session.waitFor(() => session.colorsAt('14').fg !== null, {
      label: 'the day numbers in color',
    });
    const { fg } = session.colorsAt('14');
    const [r, g, b] = [fg >> 16, (fg >> 8) & 255, fg & 255];
    expect(Math.max(r, g, b)).toBeLessThan(0x40);
  });

  it('shows the keys for the screen on the bottom row', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    const bottom = () => session.screen().split('\n').at(-1);
    await session.waitFor(() => bottom().includes('r Reply'), { label: 'the list hints' });
    for (const hint of ['Ctrl+N New', 'e Archive', '? Shortcuts']) expect(bottom()).toContain(hint);

    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    await session.waitFor(() => bottom().includes('Esc Back'), { label: 'the message hints' });
    for (const hint of ['a Reply all', 'f Forward', 'Del Delete']) expect(bottom()).toContain(hint);
  });

  it('rebinds a shortcut in settings and shows the new key', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    const bottom = () => session.screen().split('\n').at(-1);

    // From the shortcut list, the hint bar leads to the settings page.
    session.type('?');
    await session.waitFor(() => bottom().includes('Change keys in Settings'), {
      label: 'the way to the settings',
    });
    session.click('Change keys in Settings');
    await session.waitFor('Customize or review the shortcuts');

    // Edit next to "Archive message", then the new key.
    const row = session
      .screen()
      .split('\n')
      .find((line) => line.includes('Archive message'));
    expect(row).toContain('Edit');
    session.click('Edit', session.screen().split('\n').indexOf(row));
    await session.waitFor('Press a key');
    session.type('x');
    await session.waitFor('Shortcut updated');

    session.type(KEYS.escape);
    await session.waitFor('INBOX(');
    await session.waitFor(() => bottom().includes('x Archive'), { label: 'the new key' });
  });

  it('hides the hint bar with --no-hints', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo', '--no-hints'] });
    await session.waitFor('Welcome to Forward Email!');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(session.screen()).not.toContain('? Shortcuts');
  });

  it('adapts to a narrow terminal with the mobile layout', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'], cols: 70, rows: 30 });
    const screen = await session.waitFor('Forward Email Team');
    // No folder sidebar beside the list at this width.
    expect(screen).not.toContain('Outbox');
  });

  it('runs on the alternate screen, so the wheel cannot reach the shell above it', async () => {
    session = startTerminal({ home: tempHome(), shellLines: ['$ ls', 'notes.txt'] });
    await session.waitFor('Try Demo');
    // The shell's lines and scrollback stay on the normal screen, out of
    // reach of the wheel, as with vim or less.
    expect(session.bufferType()).toBe('alternate');
    expect(session.screen()).not.toContain('notes.txt');
    session.type(KEYS.ctrlC);
    const { code } = await session.exit;
    expect(code).toBe(0);
    // Quitting puts the shell's screen back as it was, with no trace of
    // the app over it.
    expect(session.bufferType()).toBe('normal');
    const screen = session.screen();
    expect(screen).toContain('$ ls');
    expect(screen).toContain('notes.txt');
    expect(screen).not.toContain('Try Demo');
    expect(screen).not.toContain('Ctrl+C');
  });

  it('shows a scroll bar beside the message list that follows the wheel, the track and the thumb', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'], cols: 120, rows: 30 });
    await session.waitFor((text) => text.includes('Forward Email Team') && text.includes('█'), {
      label: 'the message list and its scroll bar',
    });
    const top = session.locate('Forward Email Team');
    const col = barColumn(session.screen(), top.col);
    const start = thumbRows(session.screen(), col);
    // The list starts at the top, with more below: the thumb is at the top
    // of the track and the track runs on under it.
    expect(start[0]).toBe(top.row - 1);
    expect(cellsOf(session.screen().split('\n')[start.at(-1) + 1])[col]).toBe('│');

    // The wheel scrolls the list and the thumb follows.
    session.wheel(top.col, top.row, 'down', 6);
    await session.waitFor((text) => thumbRows(text, col)[0] > start[0], {
      label: 'the thumb to move down',
    });
    expect(session.screen()).not.toContain('Forward Email Team');

    // A click on the track below the thumb scrolls a page.
    const moved = thumbRows(session.screen(), col);
    session.clickAt(col + 1, moved.at(-1) + 2);
    await session.waitFor((text) => thumbRows(text, col)[0] > moved[0], {
      label: 'the thumb to page down',
    });

    // Dragging the thumb to the top scrolls back to the first message.
    const now = thumbRows(session.screen(), col);
    await session.drag({ col: col + 1, row: now[0] + 1 }, { col: col + 1, row: start[0] + 1 });
    await session.waitFor(
      (text) => text.includes('Forward Email Team') && thumbRows(text, col)[0] === start[0],
      { label: 'the list and its thumb back at the top' },
    );
  });

  it('scrolls a long draft inside the compose window and keeps the caret in view', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'], cols: 120, rows: 30 });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.ctrlN);
    await session.waitFor('Message');
    session.click('Message');
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1} of a long draft`);
    session.type(PASTE(lines.join('\r')));

    // The body grows past the window; the window scrolls to the last line,
    // where the caret is, and its title stays on screen.
    let screen = await session.waitFor('Line 40 of a long draft');
    expect(screen).toContain('New message');
    expect(screen).not.toContain('Line 1 of a long draft');
    expect(screen.split('\n')[0]).toContain('Search mail');
    // No text is drawn over the toolbar below the body.
    const send = screen.split('\n').findIndex((line) => line.includes('Send'));
    expect(screen.split('\n').slice(send).join('\n')).not.toContain('of a long draft');
    // A scroll bar beside the text shows there is more above: its thumb is
    // below the top of its track.
    const text = session.locate('Line 40 of a long draft');
    const thumbBelowTop = (now) => {
      const col = barColumn(now, text.col);
      const first = col === -1 ? -1 : thumbRows(now, col)[0];
      return first > 0 && cellsOf(now.split('\n')[first - 1])[col] === '│';
    };
    await session.waitFor(thumbBelowTop, { label: 'a scroll bar with its thumb off the top' });

    // Moving the caret up to the first line scrolls back to it.
    session.type(KEYS.up.repeat(40));
    screen = await session.waitFor('Line 1 of a long draft', { label: 'the first line' });
    expect(screen).toContain('New message');
    expect(screen).not.toContain('Line 40 of a long draft');
  });

  it('quits on Ctrl+C and hands the terminal back', async () => {
    session = startTerminal({ home: tempHome() });
    await session.waitFor('Try Demo');
    session.type(KEYS.ctrlC);
    const { code } = await session.exit;
    expect(code).toBe(0);
  });
});
