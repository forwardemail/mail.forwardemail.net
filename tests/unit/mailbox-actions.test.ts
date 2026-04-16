import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get, writable } from 'svelte/store';

// --- hoisted mocks --------------------------------------------------------

const hoisted = vi.hoisted(() => {
  const localStore = new Map<string, string>();
  return {
    localStore,
    localGet: vi.fn((key: string) => localStore.get(key) ?? null),
    localSet: vi.fn((key: string, value: string) => {
      localStore.set(key, value);
    }),
    accountsGetAll: vi.fn(() => []),
    accountsSetActive: vi.fn(() => true),
    remoteRequest: vi.fn(),
    queueMutation: vi.fn().mockResolvedValue({}),
    isOnline: vi.fn(() => true),
    warn: vi.fn(),
    invalidateFolderInMemCache: vi.fn(),
    addPendingFlagMutation: vi.fn(),
    updateFolderUnreadCounts: vi.fn(),
    messagesModify: vi.fn().mockResolvedValue(undefined),
    resetSyncWorkerReady: vi.fn(),
    clearMailServiceState: vi.fn(),
    resetForAccount: vi.fn(),
    clearFolderMessageCache: vi.fn(),
    applySettings: vi.fn(),
    createInboxUpdater: vi.fn(() => ({
      start: vi.fn(),
      destroy: vi.fn(),
    })),
    loadFolders: vi.fn().mockResolvedValue(undefined),
    loadMessages: vi.fn().mockResolvedValue(undefined),
    startInitialSync: vi.fn(),
    queueBodiesForFolder: vi.fn(),
    foldersToArray: vi.fn().mockResolvedValue([]),
    settingsGet: vi.fn().mockResolvedValue(null),
    settingsLabelsGet: vi.fn().mockResolvedValue(null),
    messagesToArray: vi.fn().mockResolvedValue([]),
    labelsToArray: vi.fn().mockResolvedValue([]),
    buildFolderList: vi.fn((f: unknown) => f),
    toastShow: vi.fn(),
  };
});

vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: (k: string) => hoisted.localGet(k),
    set: (k: string, v: string) => hoisted.localSet(k, v),
    remove: vi.fn(),
  },
  Session: { get: vi.fn(), set: vi.fn(), remove: vi.fn() },
  Accounts: {
    getAll: () => hoisted.accountsGetAll(),
    setActive: (email: string) => hoisted.accountsSetActive(email),
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => hoisted.remoteRequest(...a) },
}));

vi.mock('../../src/utils/auth', () => ({ getAuthHeader: vi.fn(() => '') }));

vi.mock('../../src/utils/mutation-queue', () => ({
  queueMutation: (...a: unknown[]) => hoisted.queueMutation(...a),
  initMutationQueue: vi.fn(),
  mutationQueueCount: writable(0),
  mutationQueueProcessing: writable(false),
  processMutationQueue: vi.fn(),
  getMutationQueueCount: vi.fn().mockResolvedValue(0),
  clearCompletedMutations: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/network-status', () => ({
  isOnline: (...a: unknown[]) => hoisted.isOnline(...a),
}));

vi.mock('../../src/utils/logger.ts', () => ({
  warn: (...a: unknown[]) => hoisted.warn(...a),
  log: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  isTauriDesktop: false,
  swReadyWithTimeout: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/utils/download', () => ({
  downloadFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/utils/sync-controller', () => ({
  startInitialSync: (...a: unknown[]) => hoisted.startInitialSync(...a),
  queueBodiesForFolder: (...a: unknown[]) => hoisted.queueBodiesForFolder(...a),
}));

vi.mock('../../src/utils/sync-worker-client.js', () => ({
  resetSyncWorkerReady: (...a: unknown[]) => hoisted.resetSyncWorkerReady(...a),
}));

vi.mock('../../src/utils/websocket-updater', () => ({
  createInboxUpdater: (...a: unknown[]) => hoisted.createInboxUpdater(...a),
}));

vi.mock('../../src/utils/search-body-indexing.js', () => ({
  resolveSearchBodyIndexing: vi.fn(() => false),
}));

vi.mock('../../src/utils/threading', () => ({
  parseReferences: vi.fn(() => []),
  normalizeSubject: vi.fn((s: string) => s),
}));

vi.mock('../../src/utils/sync-helpers', () => ({
  getMessageApiId: vi.fn((m: { id?: string; apiId?: string }) => m?.apiId ?? m?.id ?? null),
}));

vi.mock('../../src/utils/i18n', () => ({
  i18n: { getFormattingLocale: () => 'en-US' },
}));

vi.mock('../../src/utils/labels.js', () => ({
  LABEL_PALETTE: ['#fff'],
}));

vi.mock('../../src/utils/address.ts', () => ({
  normalizeEmail: (s: string) => String(s || '').toLowerCase(),
  dedupeAddresses: (arr: string[]) => Array.from(new Set(arr)),
  extractAddressList: (msg: Record<string, unknown>, field: string) => {
    const v = msg[field];
    if (!v) return [];
    if (Array.isArray(v)) return v as string[];
    return [v as string];
  },
}));

vi.mock('../../src/utils/label-validation.ts', () => ({
  validateLabelName: vi.fn(() => ({ ok: true })),
}));

vi.mock('../../src/config', () => ({
  config: { apiBase: 'https://api.test' },
}));

// Dexie import shim — we just need Dexie.minKey/maxKey symbols.
vi.mock('dexie', () => {
  class Dexie {
    static minKey = -Infinity;
    static maxKey = Infinity;
  }
  return { default: Dexie };
});

// mailboxStore — comprehensive fake.
vi.mock('../../src/stores/mailboxStore', () => {
  const state = {
    folders: writable<unknown[]>([]),
    messages: writable<Array<Record<string, unknown>>>([]),
    loading: writable(false),
    error: writable<string | null>(null),
    selectedFolder: writable<string | null>(null),
    selectedMessage: writable<Record<string, unknown> | null>(null),
    messageBody: writable(''),
    attachments: writable<unknown[]>([]),
    page: writable(1),
    query: writable(''),
    searchResults: writable<unknown[]>([]),
    searchActive: writable(false),
    messageLoading: writable(false),
    hasNextPage: writable(false),
    unreadOnly: writable(false),
    hasAttachmentsOnly: writable(false),
    starredOnly: writable(false),
    selectedConversationIds: writable<string[]>([]),
    filterByLabel: writable<string[]>([]),
  };
  return {
    mailboxStore: {
      state,
      actions: {
        loadFolders: (...a: unknown[]) => hoisted.loadFolders(...a),
        loadMessages: (...a: unknown[]) => hoisted.loadMessages(...a),
        addPendingFlagMutation: (...a: unknown[]) => hoisted.addPendingFlagMutation(...a),
        updateFolderUnreadCounts: (...a: unknown[]) => hoisted.updateFolderUnreadCounts(...a),
        invalidateFolderInMemCache: (...a: unknown[]) => hoisted.invalidateFolderInMemCache(...a),
        resetForAccount: (...a: unknown[]) => hoisted.resetForAccount(...a),
        clearFolderMessageCache: (...a: unknown[]) => hoisted.clearFolderMessageCache(...a),
        buildFolderList: (...a: unknown[]) => hoisted.buildFolderList(...a),
        archiveMessage: vi.fn().mockResolvedValue(undefined),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
        move: vi.fn().mockResolvedValue(undefined),
      },
    },
  };
});

vi.mock('../../src/stores/searchStore', () => ({
  searchStore: {
    actions: {
      setIncludeBody: vi.fn().mockResolvedValue(undefined),
      rebuildFromCache: vi.fn().mockResolvedValue(undefined),
      resetSearchConnection: vi.fn(),
      ensureInitialized: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('../../src/stores/mailService', () => ({
  clearMailServiceState: (...a: unknown[]) => hoisted.clearMailServiceState(...a),
}));

vi.mock('../../src/stores/tabStore', () => ({
  resetTabs: vi.fn(),
}));

vi.mock('../../src/stores/settingsRegistry', () => ({
  normalizeLayoutMode: (m: string) => m ?? 'list',
}));

vi.mock('../../src/utils/search-body-indexing.js', () => ({
  resolveSearchBodyIndexing: () => false,
}));

vi.mock('../../src/stores/settingsStore', () => {
  const stubReadable = writable('default');
  return {
    syncSettings: vi.fn().mockResolvedValue(undefined),
    clearSettings: vi.fn(),
    applySettings: (...a: unknown[]) => hoisted.applySettings(...a),
    createLabel: vi.fn().mockResolvedValue({}),
    updateLabel: vi.fn().mockResolvedValue({}),
    deleteLabel: vi.fn().mockResolvedValue({}),
    settingsActions: { setBodyIndexing: vi.fn() },
    bodyIndexing: writable(false),
    loadProfileName: vi.fn(),
    loadProfileImage: vi.fn(),
    settingsLabels: writable<unknown[]>([]),
    fetchAccountData: vi.fn().mockResolvedValue({}),
    effectiveLayoutMode: stubReadable,
    setSettingValue: vi.fn().mockResolvedValue(undefined),
  };
});

// db mock — provides a chainable query builder.
vi.mock('../../src/utils/db', () => {
  const chain = {
    where: vi.fn().mockReturnThis(),
    equals: vi.fn().mockReturnThis(),
    between: vi.fn().mockReturnThis(),
    reverse: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    modify: (...a: unknown[]) => hoisted.messagesModify(...a),
    toArray: () => hoisted.messagesToArray(),
    get: vi.fn(),
    put: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    db: {
      messages: {
        where: () => ({
          equals: () => ({
            modify: (...a: unknown[]) => hoisted.messagesModify(...a),
            toArray: () => hoisted.messagesToArray(),
          }),
          between: () => ({
            reverse: () => ({
              limit: () => ({
                toArray: () => hoisted.messagesToArray(),
              }),
            }),
          }),
        }),
      },
      messageBodies: {
        get: vi.fn().mockResolvedValue(null),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      folders: {
        where: () => ({
          equals: () => ({ toArray: () => hoisted.foldersToArray() }),
        }),
      },
      settings: { get: () => hoisted.settingsGet() },
      settingsLabels: { get: () => hoisted.settingsLabelsGet() },
      labels: {
        where: () => ({ equals: () => ({ toArray: () => hoisted.labelsToArray() }) }),
      },
      drafts: chain,
    },
  };
});

// --- import the module under test -----------------------------------------

import {
  computeReplyTargets,
  toggleRead,
  toggleStar,
  switchAccount,
  addReplyPrefix,
  addForwardPrefix,
  stripQuoteCollapseMarkup,
  currentAccount,
  accountMenuOpen,
} from '../../src/stores/mailboxActions.ts';
import { mailboxStore } from '../../src/stores/mailboxStore';

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.localStore.clear();
  hoisted.localStore.set('email', 'user@example.com');
  hoisted.isOnline.mockReturnValue(true);
  hoisted.accountsGetAll.mockReturnValue([]);
  hoisted.accountsSetActive.mockReturnValue(true);
  mailboxStore.state.messages.set([]);
  mailboxStore.state.folders.set([]);
  mailboxStore.state.selectedMessage.set(null);
  currentAccount.set('user@example.com');
});

describe('computeReplyTargets', () => {
  it('picks the sender for simple reply', () => {
    const msg = { from: ['alice@example.com'], to: ['user@example.com'] };
    const out = computeReplyTargets(msg);
    expect(out.to).toEqual(['alice@example.com']);
    expect(out.cc).toEqual([]);
  });

  it('replies to TO recipients when message was sent by the user', () => {
    const msg = {
      from: ['user@example.com'],
      to: ['bob@example.com', 'carol@example.com'],
    };
    const out = computeReplyTargets(msg);
    expect(out.to).toEqual(['bob@example.com']);
  });

  it('reply-all includes non-self CC and TO', () => {
    const msg = {
      from: ['alice@example.com'],
      to: ['user@example.com', 'dave@example.com'],
      cc: ['eve@example.com', 'user@example.com'],
    };
    const out = computeReplyTargets(msg, { replyAll: true });
    expect(out.to).toEqual(['alice@example.com', 'dave@example.com']);
    expect(out.cc).toEqual(['eve@example.com']);
  });

  it('honors reply-to over from when present', () => {
    const msg = {
      from: ['noreply@example.com'],
      replyTo: ['contact@example.com'],
      to: ['user@example.com'],
    };
    const out = computeReplyTargets(msg);
    expect(out.to).toEqual(['contact@example.com']);
  });
});

describe('toggleRead', () => {
  it('performs optimistic update and hits the server when online', async () => {
    const msg = {
      id: '1',
      apiId: 'srv-1',
      is_unread: true,
      flags: [],
      folder: 'INBOX',
    };
    mailboxStore.state.messages.set([msg]);
    hoisted.remoteRequest.mockResolvedValueOnce({});

    await toggleRead(msg);

    // Optimistic flip: unread → read
    const updated = get(mailboxStore.state.messages);
    expect(updated[0].is_unread).toBe(false);
    expect(updated[0].flags as string[]).toContain('\\Seen');

    // Hits the API with the right path
    expect(hoisted.remoteRequest).toHaveBeenCalledTimes(1);
    const [, , opts] = hoisted.remoteRequest.mock.calls[0];
    expect(opts.method).toBe('PUT');
    expect(opts.pathOverride).toContain('srv-1');

    // Did not need to queue
    expect(hoisted.queueMutation).not.toHaveBeenCalled();
  });

  it('queues the mutation when offline', async () => {
    hoisted.isOnline.mockReturnValue(false);
    const msg = {
      id: '2',
      apiId: 'srv-2',
      is_unread: false,
      flags: ['\\Seen'],
      folder: 'INBOX',
    };
    mailboxStore.state.messages.set([msg]);

    await toggleRead(msg);

    expect(hoisted.remoteRequest).not.toHaveBeenCalled();
    expect(hoisted.queueMutation).toHaveBeenCalledTimes(1);
    const [type, payload] = hoisted.queueMutation.mock.calls[0];
    expect(type).toBe('toggleRead');
    expect(payload.messageId).toBe('srv-2');
  });

  it('falls back to the queue when the server call fails', async () => {
    const msg = { id: '3', apiId: 'srv-3', is_unread: true, flags: [], folder: 'INBOX' };
    mailboxStore.state.messages.set([msg]);
    hoisted.remoteRequest.mockRejectedValueOnce(new Error('5xx'));

    await toggleRead(msg);

    expect(hoisted.queueMutation).toHaveBeenCalledTimes(1);
    expect(hoisted.queueMutation.mock.calls[0][0]).toBe('toggleRead');
  });

  it('reverts the optimistic update if the message has no api id', async () => {
    const msg = { id: 'bad', is_unread: true, flags: [], folder: 'INBOX' };
    mailboxStore.state.messages.set([msg]);

    // sync-helpers mock returns null when apiId/id missing — force that.
    const { getMessageApiId } = await import('../../src/utils/sync-helpers');
    (getMessageApiId as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(null);

    await toggleRead(msg);

    expect(hoisted.remoteRequest).not.toHaveBeenCalled();
    expect(hoisted.queueMutation).not.toHaveBeenCalled();
    // message should be restored to its original state
    expect(get(mailboxStore.state.messages)[0].is_unread).toBe(true);
  });

  it('is a no-op when msg.id is missing', async () => {
    await toggleRead({} as never);
    expect(hoisted.remoteRequest).not.toHaveBeenCalled();
    expect(hoisted.queueMutation).not.toHaveBeenCalled();
  });
});

describe('toggleStar', () => {
  it('toggles the \\Flagged flag optimistically', async () => {
    const msg = {
      id: '1',
      apiId: 'srv-1',
      is_starred: false,
      flags: [],
      folder: 'INBOX',
    };
    mailboxStore.state.messages.set([msg]);
    hoisted.remoteRequest.mockResolvedValueOnce({});

    await toggleStar(msg);

    const updated = get(mailboxStore.state.messages)[0];
    expect(updated.is_starred).toBe(true);
    expect(updated.flags as string[]).toContain('\\Flagged');
  });

  it('propagates the change to selectedMessage when it matches', async () => {
    const msg = {
      id: '1',
      apiId: 'srv-1',
      is_starred: false,
      flags: [],
      folder: 'INBOX',
    };
    mailboxStore.state.messages.set([msg]);
    mailboxStore.state.selectedMessage.set(msg);
    hoisted.remoteRequest.mockResolvedValueOnce({});

    await toggleStar(msg);

    const sel = get(mailboxStore.state.selectedMessage);
    expect(sel?.is_starred).toBe(true);
  });
});

describe('switchAccount leading-edge debounce', () => {
  // Each test waits past the 300ms cooldown window so module-level debounce
  // state doesn't leak between tests.
  const flushCooldown = () => new Promise((resolve) => setTimeout(resolve, 310));

  it('is a no-op when switching to the already-active account', async () => {
    await switchAccount({ email: 'user@example.com' });
    expect(hoisted.accountsSetActive).not.toHaveBeenCalled();
    await flushCooldown();
  });

  it('executes immediately on the leading edge', async () => {
    hoisted.localStore.set('email', 'user@example.com');
    currentAccount.set('user@example.com');
    hoisted.accountsSetActive.mockReturnValueOnce(true);

    switchAccount({ email: 'other-1@example.com' });
    // setActive is called synchronously (leading edge, before the first await).
    expect(hoisted.accountsSetActive).toHaveBeenCalledWith('other-1@example.com');
    await flushCooldown();
  });

  it('closes the account menu as part of the switch', async () => {
    currentAccount.set('user@example.com');
    accountMenuOpen.set(true);
    hoisted.accountsSetActive.mockReturnValue(true);

    switchAccount({ email: 'other-2@example.com' });
    await vi.waitFor(() => expect(get(accountMenuOpen)).toBe(false));
    await flushCooldown();
  });
});

describe('reply / forward helpers', () => {
  it('addReplyPrefix adds and dedupes Re:', () => {
    expect(addReplyPrefix('Hi')).toBe('Re: Hi');
    expect(addReplyPrefix('Re: Hi')).toBe('Re: Hi');
    expect(addReplyPrefix('RE: Hi')).toBe('RE: Hi');
    expect(addReplyPrefix('')).toBe('Re: ');
  });

  it('addForwardPrefix adds and dedupes Fwd:', () => {
    expect(addForwardPrefix('Hi')).toBe('Fwd: Hi');
    expect(addForwardPrefix('Fwd: Hi')).toBe('Fwd: Hi');
  });

  it('stripQuoteCollapseMarkup removes fe-quote wrappers', () => {
    const html =
      '<div class="fe-quote-wrapper"><button class="fe-quote-toggle">x</button>' +
      '<div class="fe-quote-content"><p>Hello</p></div></div>';
    const out = stripQuoteCollapseMarkup(html);
    expect(out).not.toContain('fe-quote');
    expect(out).toContain('<p>Hello</p>');
  });

  it('stripQuoteCollapseMarkup is a no-op when no markup present', () => {
    const html = '<p>Plain body</p>';
    expect(stripQuoteCollapseMarkup(html)).toBe(html);
  });
});
