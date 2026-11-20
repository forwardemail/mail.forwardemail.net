// The saved draft is read back with the MIME parser, which misreads its
// input under jsdom's second set of typed-array classes.
// @vitest-environment node
/**
 * Drafts for an account on a custom IMAP server are saved to its Drafts
 * folder, not through the Forward Email API. The engine is stood in for;
 * the draft service, the message builder and the backend are the real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PostalMime from 'postal-mime';

const h = vi.hoisted(() => ({
  drafts: new Map<string, Record<string, unknown>>(),
  remoteRequest: vi.fn(),
  sendSyncTask: vi.fn(),
}));

const ALICE = 'alice@example.org';
vi.mock('../../src/utils/storage', () => ({
  Local: { get: (key: string) => (key === 'email' ? 'alice@example.org' : null) },
  Accounts: {
    getAll: () => [
      {
        email: 'alice@example.org',
        kind: 'imap',
        imap: {
          host: 'imap.example.org',
          port: 993,
          security: 'tls',
          username: 'alice@example.org',
          password: 'incoming secret',
        },
      },
    ],
  },
}));
vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: false }));
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => h.remoteRequest(...a) },
}));
vi.mock('../../src/utils/auth', () => ({
  getAuthHeader: () => '',
  getAuthHeaderForAccount: () => '',
}));
vi.mock('../../src/utils/sync-worker-client', () => ({
  sendSyncTask: (...a: unknown[]) => h.sendSyncTask(...a),
}));
vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn(() => undefined),
}));
vi.mock('../../src/utils/demo-mode', () => ({ isDemoMode: () => false }));
vi.mock('../../src/utils/network-status', () => ({ isOnline: () => true }));
vi.mock('../../src/utils/db', () => ({
  db: {
    drafts: {
      put: vi.fn(async (d: Record<string, unknown>) => {
        h.drafts.set(String(d.id), d);
      }),
      get: vi.fn(async ([, id]: [string, string]) => h.drafts.get(id)),
      where: () => ({ equals: () => ({ toArray: async () => [...h.drafts.values()] }) }),
    },
  },
}));

import {
  saveDraft,
  saveDraftForComposeWindow,
  setDraftRelay,
  syncPendingDrafts,
} from '../../src/utils/draft-service.js';
import { MailEngineError, setMailEngineForTests } from '../../src/backends/imap-engine';
import { getMailBackend, resetMailBackendsForTests } from '../../src/backends';
import { ImapBackend } from '../../src/backends/imap';
import { imapMessageId } from '../../src/backends/imap-mapping';

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
let nextUid = 20;
const only = (cmd: string) => calls.filter((c) => c.cmd === cmd);
const decode = (b64: unknown) => Uint8Array.from(Buffer.from(String(b64), 'base64'));
const draftId = (uid: number) => imapMessageId({ uidValidity: 4, uid, folder: 'Drafts' });

beforeEach(() => {
  h.drafts.clear();
  h.remoteRequest.mockReset();
  h.sendSyncTask.mockReset();
  calls = [];
  nextUid = 20;
  resetMailBackendsForTests();
  setMailEngineForTests(async (cmd, args = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'mail_open') return 'imap-handle-1';
    if (cmd === 'imap_folders') {
      return [
        { path: 'INBOX', delimiter: '/', selectable: true },
        { path: 'Drafts', delimiter: '/', specialUse: 'drafts', selectable: true },
      ];
    }
    if (cmd === 'imap_append') return { uidValidity: 4, uid: (nextUid += 1) };
    return null;
  });
});

const draft = {
  id: 'draft_1',
  to: ['Bob <bob@example.net>'],
  bcc: ['quiet@example.net'],
  subject: 'Lunch on Thursday?',
  body: '<p>Noon at the usual place.</p>',
};

describe('saving a draft for an account on a custom IMAP server', () => {
  it('saves it to the Drafts folder as a draft, with everything typed so far', async () => {
    const saved = await saveDraft(draft);

    const [append] = only('imap_append');
    expect(append.args).toMatchObject({
      handle: 'imap-handle-1',
      folder: 'Drafts',
      flags: ['\\Draft', '\\Seen'],
    });
    const message = await PostalMime.parse(decode(append.args.message));
    expect(message.subject).toBe('Lunch on Thursday?');
    expect(message.from).toEqual({ name: '', address: ALICE });
    expect(message.to).toEqual([{ name: 'Bob', address: 'bob@example.net' }]);
    // A draft keeps its Bcc line; a sent message never carries one.
    expect(message.bcc).toEqual([{ name: '', address: 'quiet@example.net' }]);
    expect(message.html?.trim()).toBe('<p>Noon at the usual place.</p>');

    expect(saved).toMatchObject({ syncStatus: 'synced', serverId: draftId(21) });
    expect(h.remoteRequest).not.toHaveBeenCalled();
  });

  it('saves a draft that has nobody to go to yet', async () => {
    const saved = await saveDraft({ id: 'draft_2', subject: 'Notes to self', body: 'tbd' });
    expect(saved.syncStatus).toBe('synced');
    expect(only('imap_append')).toHaveLength(1);
  });

  it('replaces the copy saved before instead of piling up versions', async () => {
    await saveDraft(draft);
    const again = await saveDraft({ ...draft, subject: 'Lunch on Friday?' });

    expect(only('imap_append')).toHaveLength(2);
    // The first copy (uid 21) is removed once the second (uid 22) is saved.
    expect(only('imap_delete').map((c) => c.args)).toEqual([
      { handle: 'imap-handle-1', folder: 'Drafts', uid: 21 },
    ]);
    expect(again.serverId).toBe(draftId(22));
    // Each save is found again by its own Message-ID.
    const ids = await Promise.all(
      only('imap_append').map(
        async (c) => (await PostalMime.parse(decode(c.args.message))).messageId,
      ),
    );
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('sends drafts left unsaved from this window, not through the sync worker', async () => {
    h.drafts.set('draft_9', {
      id: 'draft_9',
      account: ALICE,
      subject: 'Written offline',
      body: 'hello',
      to: [],
      syncStatus: 'pending',
    });
    h.drafts.set('draft_empty', { id: 'draft_empty', account: ALICE, syncStatus: 'pending' });

    await syncPendingDrafts();

    expect(h.sendSyncTask).not.toHaveBeenCalled();
    expect(only('imap_append')).toHaveLength(1);
    expect(h.drafts.get('draft_9')).toMatchObject({ syncStatus: 'synced', serverId: draftId(21) });
  });

  it('keeps the draft on this device, marked unsaved, when the server cannot be reached', async () => {
    setMailEngineForTests(async (cmd) => {
      if (cmd === 'mail_open')
        throw Object.assign(new Error('Could not connect'), { kind: 'network' });
      return null;
    });

    const saved = await saveDraft(draft);

    expect(saved).toMatchObject({ syncStatus: 'pending', lastError: 'Could not connect' });
    expect(h.drafts.get('draft_1')?.subject).toBe('Lunch on Thursday?');
  });
});

// The Rust engine answers the main window only. A compose window writes the
// draft to the database both windows share and asks the main window to save
// it. Here one process plays both: the relay calls the main window's side.
describe('saving a draft from a separate compose window', () => {
  const engineCallsFromCompose: string[] = [];
  let inMainWindow = false;
  const asMainWindow = async <T>(work: () => Promise<T>): Promise<T> => {
    inMainWindow = true;
    try {
      return await work();
    } finally {
      inMainWindow = false;
    }
  };
  const removed: Array<[string, string]> = [];

  beforeEach(() => {
    engineCallsFromCompose.length = 0;
    removed.length = 0;
    const engine = async (cmd: string, args: Record<string, unknown> = {}) => {
      if (!inMainWindow) {
        engineCallsFromCompose.push(cmd);
        throw new MailEngineError('forbidden', 'Only the main window may use the mail engine');
      }
      calls.push({ cmd, args });
      if (cmd === 'mail_open') return 'imap-handle-1';
      if (cmd === 'imap_folders') {
        return [
          { path: 'INBOX', delimiter: '/', selectable: true },
          { path: 'Drafts', delimiter: '/', specialUse: 'drafts', selectable: true },
        ];
      }
      if (cmd === 'imap_append') return { uidValidity: 4, uid: (nextUid += 1) };
      return null;
    };
    setMailEngineForTests(engine);
    setDraftRelay({
      accounts: ['Alice@Example.org'],
      save: (account: string, id: string) =>
        asMainWindow(async () => {
          await saveDraftForComposeWindow(account, id);
        }),
      remove: (account: string, id: string) => removed.push([account, id]),
    });
  });
  afterEach(() => setDraftRelay(null));

  it('reaches the server through the main window, and learns the saved id', async () => {
    const saved = await saveDraft(draft);

    expect(engineCallsFromCompose).toEqual([]);
    const [append] = only('imap_append');
    expect(append.args).toMatchObject({ folder: 'Drafts', flags: ['\\Draft', '\\Seen'] });
    const message = await PostalMime.parse(decode(append.args.message));
    expect(message.subject).toBe('Lunch on Thursday?');
    expect(saved).toMatchObject({ syncStatus: 'synced', serverId: draftId(21) });
  });

  it('replaces its earlier copy on the next save', async () => {
    await saveDraft(draft);
    // The composer passes back what it has; the id may only be in the database.
    const again = await saveDraft({ ...draft, subject: 'Lunch on Friday?' });

    expect(only('imap_delete').map((c) => c.args)).toEqual([
      { handle: 'imap-handle-1', folder: 'Drafts', uid: 21 },
    ]);
    expect(again.serverId).toBe(draftId(22));
  });

  it('says why when the server refused it, and keeps the draft', async () => {
    setDraftRelay({
      accounts: [ALICE],
      save: async (account: string, id: string) => {
        // What the main window stores before it answers with the error.
        h.drafts.set(id, { ...h.drafts.get(id), syncStatus: 'pending', lastError: 'Over quota' });
        throw new Error('Over quota');
      },
      remove: () => {},
    });
    const saved = await saveDraft(draft);
    expect(saved).toMatchObject({ syncStatus: 'pending', lastError: 'Over quota' });
    expect(saved.serverId).toBeFalsy();
    expect(h.drafts.get('draft_1')?.subject).toBe('Lunch on Thursday?');
  });

  it('leaves the stored draft alone when the main window never answers', async () => {
    setDraftRelay({
      accounts: [ALICE],
      save: async (_account: string, id: string) => {
        // The main window saved it after all, just too late to say so.
        h.drafts.set(id, { ...h.drafts.get(id), syncStatus: 'synced', serverId: draftId(21) });
        throw Object.assign(new Error('The main window did not answer.'), { unanswered: true });
      },
      remove: () => {},
    });
    const saved = await saveDraft(draft);
    expect(saved).toMatchObject({
      syncStatus: 'pending',
      lastError: 'The main window did not answer.',
    });
    // Overwriting the row here would lose the id, and the next save would
    // leave a second copy on the server.
    expect(h.drafts.get('draft_1')).toMatchObject({ syncStatus: 'synced', serverId: draftId(21) });
  });

  it('is not used for an account the main window did not name', async () => {
    setDraftRelay({ accounts: ['someone@example.net'], save: vi.fn(), remove: vi.fn() });
    await asMainWindow(() => saveDraft(draft));
    expect(only('imap_append')).toHaveLength(1);
  });
});

describe('what the main window will remove for a compose window', () => {
  const backend = () => getMailBackend(ALICE) as ImapBackend;
  const inbox = imapMessageId({ uidValidity: 9, uid: 7, folder: 'INBOX' });

  it('removes a draft', async () => {
    await backend().removeDraft(draftId(21));
    expect(only('imap_delete').map((c) => c.args)).toEqual([
      { handle: 'imap-handle-1', folder: 'Drafts', uid: 21 },
    ]);
  });

  it('refuses a message outside the Drafts folder', async () => {
    await expect(backend().removeDraft(inbox)).rejects.toThrow('That message is not a draft');
    expect(only('imap_delete')).toEqual([]);
  });

  it('does not remove an "earlier copy" that is not in the Drafts folder', async () => {
    h.drafts.set('draft_1', { id: 'draft_1', account: ALICE, serverId: inbox });
    const saved = await saveDraft(draft);
    expect(saved.syncStatus).toBe('synced');
    expect(only('imap_delete')).toEqual([]);
  });
});
