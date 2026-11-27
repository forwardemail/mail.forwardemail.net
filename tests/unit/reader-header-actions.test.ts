import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: vi.fn(async () => ({})) },
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    settingsLabels: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    settings: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  },
  handleDatabaseError: vi.fn(async () => {}),
}));

import {
  DEFAULT_READER_HEADER_ACTIONS,
  READER_HEADER_ACTIONS,
  normalizeReaderHeaderActions,
  visibleReaderHeaderActions,
} from '../../src/utils/reader-header-actions';
import {
  getSettingDefinition,
  parseLocalValue,
  serializeLocalValue,
} from '../../src/stores/settingsRegistry';
import {
  getEffectiveSettingValue,
  localSettingsVersion,
  setSettingValue,
} from '../../src/stores/settingsStore';

const ALL = READER_HEADER_ACTIONS.map((a) => a.id);

describe('normalizeReaderHeaderActions', () => {
  it('defaults to Reply alone, the header as it was', () => {
    expect(DEFAULT_READER_HEADER_ACTIONS).toEqual(['reply']);
    expect(normalizeReaderHeaderActions(undefined)).toEqual(['reply']);
    expect(normalizeReaderHeaderActions(null)).toEqual(['reply']);
    expect(normalizeReaderHeaderActions('not json')).toEqual(['reply']);
    expect(normalizeReaderHeaderActions({ reply: true })).toEqual(['reply']);
  });

  it('keeps an empty choice, so all buttons can be turned off', () => {
    expect(normalizeReaderHeaderActions([])).toEqual([]);
    expect(normalizeReaderHeaderActions('[]')).toEqual([]);
  });

  it('drops unknown ids and duplicates and sorts into the fixed order', () => {
    expect(
      normalizeReaderHeaderActions(['move', 'bogus', 'archive', 'reply', 'archive', 7]),
    ).toEqual(['reply', 'archive', 'move']);
    expect(normalizeReaderHeaderActions('["reportSpam","archive"]')).toEqual([
      'archive',
      'reportSpam',
    ]);
  });

  it('offers every bulk-selection action plus report spam and the reply family', () => {
    for (const id of [
      'archive',
      'delete',
      'toggleRead',
      'move',
      'reportSpam',
      'reply',
      'replyAll',
      'forward',
    ]) {
      expect(ALL).toContain(id);
    }
  });
});

describe('visibleReaderHeaderActions', () => {
  it('shows every chosen action when the folder allows them', () => {
    expect(visibleReaderHeaderActions(ALL)).toEqual(ALL);
  });

  it('hides actions the folder does not allow', () => {
    // In Spam: no Report spam, no Archive, no read toggle
    expect(
      visibleReaderHeaderActions(['archive', 'reportSpam', 'toggleRead', 'delete', 'move'], {
        canArchive: false,
        canReportSpam: false,
        canToggleRead: false,
      }),
    ).toEqual(['delete', 'move']);
    // In Drafts: no reply family
    expect(
      visibleReaderHeaderActions(['reply', 'replyAll', 'forward', 'delete'], {
        canReply: false,
        canForward: false,
      }),
    ).toEqual(['delete']);
  });

  it('does not repeat what the full-screen reader toolbar already shows', () => {
    expect(visibleReaderHeaderActions(ALL, { fullscreenToolbar: true })).toEqual([
      'reply',
      'replyAll',
      'forward',
      'reportSpam',
    ]);
  });
});

describe('reader_header_actions setting', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is a portable device setting stored as JSON', () => {
    const def = getSettingDefinition('reader_header_actions');
    expect(def?.scope).toBe('device');
    expect(def?.portable).toBe(true);
    expect(parseLocalValue(def, null)).toEqual(['reply']);
    expect(serializeLocalValue(def, ['move', 'archive', 'nope'])).toBe('["archive","move"]');
    expect(parseLocalValue(def, '["archive","move"]')).toEqual(['archive', 'move']);
  });

  it('reads Reply alone before anything is saved', () => {
    expect(getEffectiveSettingValue('reader_header_actions')).toEqual(['reply']);
  });

  it('persists a choice and bumps the local settings version so the reader re-reads it', async () => {
    const before = get(localSettingsVersion);
    await setSettingValue('reader_header_actions', ['reportSpam', 'archive', 'reply']);
    expect(get(localSettingsVersion)).toBeGreaterThan(before);
    expect(localStorage.getItem('webmail_reader_header_actions')).toBe(
      '["reply","archive","reportSpam"]',
    );
    expect(getEffectiveSettingValue('reader_header_actions')).toEqual([
      'reply',
      'archive',
      'reportSpam',
    ]);
  });
});

// Mailbox.svelte is too large to mount in jsdom, so check its header markup
// directly: one button per action, each wired to the same handler the "…"
// menu uses, with a tooltip and an accessible name.
describe('Mailbox reader header buttons', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
    'utf8',
  );
  const start = source.indexOf('{#each readerHeaderActions as action (action)}');
  const header = source.slice(start, source.indexOf('data-action-menu', start));

  it('renders a labelled, tooltipped button for every action', () => {
    expect(start).toBeGreaterThan(-1);
    for (const id of ALL) {
      const at = header.indexOf(`data-testid="reader-header-${id}"`);
      expect(at, id).toBeGreaterThan(-1);
      const button = header.slice(header.lastIndexOf('<button', at), header.indexOf('>', at));
      expect(button, id).toMatch(/aria-label=/);
      expect(button, id).toMatch(/data-tooltip=/);
    }
  });

  it('reuses the reader handlers that the "…" menu calls', () => {
    for (const handler of [
      'onclick={archiveSelected}',
      'onclick={reportSpamSelected}',
      'onclick={deleteSelected}',
      'toggleReadMessage($selectedMessage)',
      'moveReaderTo(folder.path)',
      'toggleStarMessage($selectedMessage)',
      'mailboxView?.replyAll?.($selectedMessage)',
      'mailboxView?.forwardMessage?.($selectedMessage)',
    ]) {
      expect(header).toContain(handler);
    }
  });

  it('keeps the same icons as the selection toolbar', () => {
    expect(header).toContain('<Archive ');
    expect(header).toContain('<Trash2 ');
    expect(header).toContain('<MailOpen ');
    expect(header).toContain('<MailIcon ');
    expect(header).toContain('<FolderInput ');
  });
});
