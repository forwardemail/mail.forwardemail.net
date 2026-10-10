/**
 * Contacts in the terminal client, end to end: the built client in a real
 * pseudo-terminal with the demo account. The list and the details scroll in
 * a terminal too short to show them whole, and a click on a contact's
 * initials opens no file dialog.
 */
import fs from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CLI, canRunInteractive, startTerminal, tempHome } from './terminal.js';

beforeAll(() => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing; run pnpm build:cli first (pnpm test:cli does).`);
  }
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Scroll bars (src/cli/scrollbars.ts).
const THUMB = '█';
const TRACK = '│';

async function openContacts(rows) {
  const session = startTerminal({ home: tempHome(), args: ['--demo'], cols: 120, rows });
  await session.waitFor('Privacy settings to try');
  session.click('Contacts');
  await session.waitFor((text) => text.includes('New Contact') && text.includes('Bob Smith'), {
    label: 'the contact list',
  });
  // The first contact opens in the details.
  await session.waitFor('AJ  alice@example.com', { label: 'the details' });
  return session;
}

// The cell just left of the details' border: the list's scroll bar column.
const listBarColumn = (session) => {
  const lines = session.screen().split('\n');
  const row = lines.findIndex((line) => line.includes('Bob Smith'));
  return { lines, col: lines[row].indexOf('│') - 1, row };
};

describe.runIf(canRunInteractive)('contacts', () => {
  let session;
  afterEach(async () => {
    await session?.stop();
    session = null;
  });

  it('scrolls the contact list with the wheel, with a scroll bar', async () => {
    session = await openContacts(16);
    // Six contacts do not fit: the last is below the end of the list.
    expect(session.screen()).not.toContain('team@forwardemail.net');
    await session.waitFor(
      () => {
        const { lines, col, row } = listBarColumn(session);
        return [TRACK, THUMB].includes(lines[row][col]);
      },
      { label: "the list's scroll bar" },
    );

    const { col: nameCol, row: nameRow } = session.locate('Bob Smith');
    session.wheel(nameCol, nameRow, 'down', 3);
    await session.waitFor('team@forwardemail.net', { label: 'the end of the list' });

    // The list scrolled inside its own box: the header above it and the
    // border below it are drawn as before, with no initials over them.
    const text = session.screen();
    const header = text.split('\n').find((line) => line.includes('Search contacts'));
    expect(header).toMatch(/^\s+⌕\s+Search contacts\s+│/);
    expect(text).toMatch(/^\s+6 contacts\s+│/m);
    expect(text).not.toMatch(/─── [A-Z]{2} ───/);
  });

  it('scrolls the details of a contact with the wheel', async () => {
    session = await openContacts(22);
    expect(session.screen()).not.toContain('Acme Corp');
    const { col, row } = session.locate('+1-555-0101');
    session.wheel(col, row, 'down', 8);
    await session.waitFor('Acme Corp', { label: 'the company, below the first screen' });
  });

  it('opens no file dialog from a click on the initials of a contact', async () => {
    session = await openContacts(36);
    const { col, row } = session.locate('AJ  alice@example.com');
    session.clickAt(col, row);
    await pause(1500);
    const text = session.screen();
    // Neither the typed-path prompt nor a system file dialog's hint.
    expect(text).not.toContain('File to attach');
    expect(text).not.toContain('Choose files in the file dialog');
    expect(text).toContain('Alice Johnson');
  });
});
