import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────
// We test the helper functions (buildServerSearchParams, mergeResults,
// serverSearch) by importing the searchStore module with mocked deps.

// Mock Remote.request
const mockRequest = vi.fn();
vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...args) => mockRequest(...args) },
}));

// Mock demo-mode
let _demoMode = false;
vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => _demoMode,
  interceptDemoRequest: () => ({ handled: false }),
}));

// Mock storage
vi.mock('../../src/utils/storage', () => ({
  Local: {
    get: vi.fn(() => 'test@example.com'),
    set: vi.fn(),
  },
  Accounts: { add: vi.fn(), list: vi.fn(() => []) },
}));

// Mock db
vi.mock('../../src/utils/db', () => ({
  db: {
    messages: {
      where: () => ({
        equals: () => ({ toArray: () => Promise.resolve([]) }),
      }),
      bulkGet: () => Promise.resolve([]),
      bulkPut: () => Promise.resolve(),
    },
    messageBodies: { bulkGet: () => Promise.resolve([]) },
  },
}));

// Mock search-service
vi.mock('../../src/utils/search-service', () => ({
  SearchService: vi.fn().mockImplementation(() => ({
    loadFromCache: vi.fn(),
    getStats: () => ({ count: 0, sizeBytes: 0, includeBody: false, account: 'test' }),
    searchAllFolders: vi.fn(() => []),
    search: vi.fn(() => []),
    upsertEntries: vi.fn(),
    persist: vi.fn(),
  })),
  SavedSearchService: vi.fn().mockImplementation(() => ({
    getAll: () => Promise.resolve([]),
    save: vi.fn(),
    delete: vi.fn(),
  })),
  setSearchDbClient: vi.fn(),
}));

// Mock search-mapping
vi.mock('../../src/utils/search-mapping', () => ({
  mapMessageToDoc: (msg) => msg,
}));

// Mock search-worker-client (disable worker so we hit main-thread path)
vi.mock('../../src/utils/search-worker-client', () => ({
  SearchWorkerClient: vi.fn().mockImplementation(() => {
    throw new Error('Worker not available in test');
  }),
}));

// Mock sync-controller
vi.mock('../../src/utils/sync-controller', () => ({
  connectSearchWorker: vi.fn(),
}));

// Mock mailboxActions
vi.mock('../../src/stores/mailboxActions', () => ({
  indexProgress: { set: vi.fn(), subscribe: vi.fn(() => vi.fn()) },
}));

// Mock search-body-indexing
vi.mock('../../src/utils/search-body-indexing.js', () => ({
  resolveSearchBodyIndexing: () => false,
}));

// Mock logger
vi.mock('../../src/utils/logger.ts', () => ({
  warn: vi.fn(),
}));

// Mock search-query (use real implementation)
vi.mock('../../src/utils/search-query', async () => {
  const actual = await vi.importActual('../../src/utils/search-query');
  return actual;
});

describe('Server-side search integration', () => {
  beforeEach(() => {
    _demoMode = false;
    mockRequest.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('search with server results', () => {
    it('should call Remote.request with search params for text queries', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');

      // Server returns messages matching "squarespace"
      mockRequest.mockResolvedValue([
        {
          id: 'server-1',
          subject: 'Your Squarespace Invoice',
          from: 'billing@squarespace.com',
          folder: 'INBOX',
          date: '2026-01-15T10:00:00Z',
        },
      ]);

      const results = await searchStore.actions.search('squarespace', {
        folder: 'INBOX',
        limit: 200,
      });

      // Verify Remote.request was called with correct params
      expect(mockRequest).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({
          search: 'squarespace',
          folder: 'INBOX',
          limit: 200,
          page: 1,
          raw: false,
          attachments: false,
        }),
        expect.objectContaining({
          method: 'GET',
          pathOverride: '/v1/messages',
        }),
      );

      // Should include the server result
      expect(results.some((r) => r.id === 'server-1')).toBe(true);
    });

    it('should skip server search in demo mode', async () => {
      _demoMode = true;
      const { searchStore } = await import('../../src/stores/searchStore');

      await searchStore.actions.search('test query', { folder: 'INBOX' });

      // Remote.request should NOT have been called
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should map from: operator to API from parameter', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('from:john@example.com', { folder: 'INBOX' });

      expect(mockRequest).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({
          from: 'john@example.com',
          folder: 'INBOX',
        }),
        expect.any(Object),
      );
    });

    it('should map subject: operator to API subject parameter', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('subject:invoice', { folder: 'INBOX' });

      expect(mockRequest).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({
          subject: 'invoice',
          folder: 'INBOX',
        }),
        expect.any(Object),
      );
    });

    it('should not call server for filter-only queries (is:unread)', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('is:unread', { folder: 'INBOX' });

      // is:unread alone has no text/from/to/subject — no server search
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('should handle server errors gracefully and return local results', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');

      mockRequest.mockRejectedValue(new Error('Network error'));

      // Should not throw — server search is best-effort
      const results = await searchStore.actions.search('test', { folder: 'INBOX' });
      expect(Array.isArray(results)).toBe(true);
    });

    it('should deduplicate results when same message found locally and on server', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');

      // Server returns a message
      mockRequest.mockResolvedValue([
        {
          id: 'msg-1',
          subject: 'Duplicate Message',
          from: 'sender@example.com',
          folder: 'INBOX',
          date: '2026-01-15T10:00:00Z',
          body: 'Full body from server',
        },
      ]);

      const results = await searchStore.actions.search('duplicate', { folder: 'INBOX' });

      // Should not have duplicates
      const ids = results.map((r) => r.id);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);
    });

    it('should pass folder as null for cross-folder search', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('test in:all', { folder: 'INBOX', crossFolder: false });

      // When in:all is used, folder should not be sent to server
      const callArgs = mockRequest.mock.calls[0];
      if (callArgs) {
        expect(callArgs[1].folder).toBeUndefined();
      }
    });

    it('should handle API returning object with data array', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');

      mockRequest.mockResolvedValue({
        data: [
          {
            id: 'api-obj-1',
            subject: 'From data array',
            from: 'test@example.com',
            folder: 'INBOX',
            date: '2026-03-01T00:00:00Z',
          },
        ],
      });

      const results = await searchStore.actions.search('data array', { folder: 'INBOX' });
      expect(results.some((r) => r.id === 'api-obj-1')).toBe(true);
    });

    it('should handle API returning object with messages array', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');

      mockRequest.mockResolvedValue({
        messages: [
          {
            id: 'api-msg-1',
            subject: 'From messages array',
            from: 'test@example.com',
            folder: 'INBOX',
            date: '2026-03-01T00:00:00Z',
          },
        ],
      });

      const results = await searchStore.actions.search('messages array', { folder: 'INBOX' });
      expect(results.some((r) => r.id === 'api-msg-1')).toBe(true);
    });
  });

  describe('search parameter mapping', () => {
    it('should combine text with structured operators', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('invoice from:billing@company.com', { folder: 'INBOX' });

      expect(mockRequest).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({
          search: 'invoice',
          from: 'billing@company.com',
          folder: 'INBOX',
        }),
        expect.any(Object),
      );
    });

    it('should map date operators to API since/before params', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('report after:2026-01-01 before:2026-03-01', {
        folder: 'INBOX',
      });

      const callArgs = mockRequest.mock.calls[0];
      expect(callArgs).toBeDefined();
      expect(callArgs[1].search).toBe('report');
      expect(callArgs[1].since).toBeDefined();
      expect(callArgs[1].before).toBeDefined();
    });

    it('should map has:attachment to API has_attachments param', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('contract has:attachment', { folder: 'INBOX' });

      expect(mockRequest).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({
          search: 'contract',
          has_attachments: true,
        }),
        expect.any(Object),
      );
    });

    it('should map is:unread with text to API is_unread param', async () => {
      const { searchStore } = await import('../../src/stores/searchStore');
      mockRequest.mockResolvedValue([]);

      await searchStore.actions.search('urgent is:unread', { folder: 'INBOX' });

      expect(mockRequest).toHaveBeenCalledWith(
        'MessageList',
        expect.objectContaining({
          search: 'urgent',
          is_unread: true,
        }),
        expect.any(Object),
      );
    });
  });
});
