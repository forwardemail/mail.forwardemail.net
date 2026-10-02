/**
 * Where the keyboard goes after a click, end to end: the built client in a
 * real pseudo-terminal with the demo account. Each test clicks, presses
 * keys, and checks what those keys did.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI, KEYS, canRunInteractive, startTerminal, tempHome } from './terminal.js';

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing; run pnpm build:cli first (pnpm test:cli does).`);
  }
});

// Focus shows as the primary color behind the focused control
// (src/cli/terminal.css); user.css sets that color to this one.
const FOCUS = 0xb45309;
function homeWithFocusColor() {
  const home = tempHome();
  fs.writeFileSync(path.join(home, 'user.css'), ':root, .dark { --fe-primary: #b45309; }\n');
  return home;
}

const inList = (text) => text.includes('INBOX(') && !text.includes('To: Demo User');

describe.runIf(canRunInteractive)('keyboard focus after a click', () => {
  let session;
  afterEach(async () => {
    await session?.stop();
    session = null;
  });

  it('moves Tab into a message opened with a click, and back to its row in the list', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Privacy settings to try');
    session.click('Privacy settings to try');
    await session.waitFor('Privacy Tips <privacy@forwardemail.net>');
    // Tab goes to the message's first control, ‹ (Back to list), not to the
    // rows of the list behind the message; Enter presses it.
    session.type(KEYS.tab);
    session.type(KEYS.enter);
    await session.waitFor(inList, { label: 'the message list' });
    // The row of the message that was open has the focus: Enter opens it.
    session.type(KEYS.enter);
    await session.waitFor('Privacy Tips <privacy@forwardemail.net>');
  });

  it('shows the focus on the message row after Esc, and opens the next message with ↓', async () => {
    session = startTerminal({ home: homeWithFocusColor(), args: ['--demo'] });
    await session.waitFor('Privacy settings to try');
    session.click('Privacy settings to try');
    await session.waitFor('Privacy Tips <privacy@forwardemail.net>');
    session.type(KEYS.escape);
    await session.waitFor(inList, { label: 'the message list' });
    await session.waitFor(() => session.colorsAt('Privacy settings to try').bg === FOCUS, {
      label: 'the focus on the row',
    });
    expect(session.colorsAt('Meeting tomorrow at 2pm').bg).not.toBe(FOCUS);
    // ↓ opens the message after the one that was open, not the first one.
    session.type(KEYS.down);
    await session.waitFor('Alice Johnson <alice@example.com>');
    // And ↑ the one before, once back in the list.
    session.type(KEYS.escape);
    await session.waitFor(inList, { label: 'the message list' });
    session.type(KEYS.up);
    await session.waitFor('Privacy Tips <privacy@forwardemail.net>');
  });

  it('moves the keyboard into a message opened with ↓, which keeps its shortcuts', async () => {
    session = startTerminal({ home: homeWithFocusColor(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    session.type(KEYS.tab);
    await session.waitFor(() => session.colorsAt('‹').bg === FOCUS, { label: 'the focus on ‹' });
    // The one-key shortcuts and the arrows still act on the message.
    session.type(KEYS.down);
    await session.waitFor('Privacy Tips <privacy@forwardemail.net>');
    session.type('r');
    await session.waitFor('wrote:');
  });

  it('moves on with Tab from a click on the text of a message', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    // The subject in the message header is plain text; Reply comes after it.
    const header = session
      .screen()
      .split('\n')
      .findIndex((line) => line.includes('Welcome to Forward Email!') && line.includes('INBOX'));
    session.click('Welcome to Forward Email!', header);
    session.type(KEYS.tab);
    session.type(KEYS.enter);
    await session.waitFor('wrote:');
  });

  it('gives the keyboard back to the message when a reply window closes', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.down);
    await session.waitFor('To: Demo User');
    session.type('r');
    await session.waitFor('wrote:');
    // The discard button at the end of the compose toolbar, then Discard,
    // once the prompt has moved to the middle of the screen.
    const toolbar = session.locate('⤓');
    session.click('✖', toolbar.row - 1);
    await session.waitFor('Discard draft?');
    await new Promise((resolve) => setTimeout(resolve, 500));
    const buttons = session
      .screen()
      .split('\n')
      .findIndex((line) => /Cancel\s+Discard/.test(line));
    session.click('Discard', buttons);
    await session.waitFor((text) => !text.includes('wrote:') && text.includes('To: Demo User'), {
      label: 'the message without the reply window',
    });
    // Tab starts in the message again: ‹, which goes back to the list.
    session.type(KEYS.tab);
    session.type(KEYS.enter);
    await session.waitFor(inList, { label: 'the message list' });
  });

  it('moves on with Tab from a click in a compose window, and types where clicked', async () => {
    session = startTerminal({ home: homeWithFocusColor(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.type(KEYS.ctrlN);
    await session.waitFor('Subject');
    expect(session.colorsAt('−').bg).not.toBe(FOCUS);
    // The window's title is plain text; its first button (−, Minimize to
    // dock) comes next, not the controls at the top of the mailbox.
    session.click('New message');
    session.type(KEYS.tab);
    await session.waitFor(() => session.colorsAt('−').bg === FOCUS, { label: 'the focus on −' });
    expect(session.colorsAt('≡').bg).not.toBe(FOCUS);
    // A click in a field puts the typing there.
    session.click('Subject');
    session.type('Quarterly plan');
    await session.waitFor('Quarterly plan');
  });

  it('focuses a settings control clicked by its label, and moves on with Tab', async () => {
    session = startTerminal({ home: tempHome(), args: ['--demo'] });
    await session.waitFor('Welcome to Forward Email!');
    session.click('Settings');
    await session.waitFor('Appearance');
    session.click('Appearance');
    await session.waitFor('(x) Auto (follow system)');
    // A click on the label text picks Light and focuses it; Tab moves to
    // Dark, and Space picks that.
    session.click('Light');
    await session.waitFor('(x) Light');
    session.type(KEYS.tab);
    session.type(' ');
    await session.waitFor('(x) Dark');
    // A click on a heading, then Tab: the controls under it, Compact and
    // then Comfortable.
    session.click('Density');
    session.type(KEYS.tab);
    session.type(KEYS.tab);
    session.type(' ');
    await session.waitFor('(x) Comfortable');
  });
});
