import {
  createRealtimeEventCoalescer,
  getRealtimeEventKey,
  PUSH_COALESCE_MS,
  REPEATABLE_CONTENT_TTL_MS,
  ONE_TIME_CONTENT_TTL_MS,
  SOCKET_HOLD_FOR_PUSH_MS,
  TRANSPORT_DEDUP_TTL_MS,
} from '../../src/utils/realtime-event-coalescer.js';

describe('realtime event transport coalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the backend notification_id as the authoritative cross-transport key', () => {
    expect(
      getRealtimeEventKey('newMessage', {
        notification_id: '123e4567-e89b-12d3-a456-426614174000',
        message: { uid: 42 },
      }),
    ).toBe('id:123e4567-e89b-12d3-a456-426614174000');
  });

  it('supports stable legacy identifiers during a mixed-version rollout', () => {
    expect(getRealtimeEventKey('newMessage', { message: { uid: 42 } })).toBe(
      'legacy:newMessage:42',
    );
    expect(getRealtimeEventKey('mailboxRenamed', { oldPath: 'Receipts', newPath: 'Archive' })).toBe(
      'legacy:mailboxRenamed:Receipts>Archive',
    );
  });

  it('scopes legacy keys by account so identical UIDs across mailboxes stay distinct', () => {
    // A UID is a per-mailbox counter and a mailbox path is "INBOX" everywhere,
    // so with several accounts connected at once these identities collide by
    // construction, not by coincidence.
    const a = getRealtimeEventKey('newMessage', {
      _account: 'alice@example.com',
      message: { uid: 42 },
    });
    const b = getRealtimeEventKey('newMessage', {
      _account: 'bob@example.com',
      message: { uid: 42 },
    });

    expect(a).not.toBe(b);
    expect(a).toContain('alice@example.com');
  });

  it('matches the WebSocket and push copies of one account event', () => {
    // Both transports carry `_account` by the time they reach the coalescer —
    // the manager tags WebSocket events, and push has it resolved from
    // alias_id — so cross-transport dedup still works after scoping.
    expect(
      getRealtimeEventKey('flagsUpdated', {
        _account: 'Alice@Example.com',
        mailbox: 'INBOX',
        uids: [5],
        flags: ['\\Seen'],
        action: 'add',
      }),
    ).toBe(
      getRealtimeEventKey('flagsUpdated', {
        _account: 'alice@example.com',
        mailbox: 'INBOX',
        uids: [5],
        flags: ['\\Seen'],
        action: 'add',
      }),
    );
  });

  it('delivers the same flag change for two accounts instead of deduping one away', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
    const flagChange = (account) => ({
      _account: account,
      mailbox: 'INBOX',
      uids: [5],
      flags: ['\\Seen'],
      action: 'add',
    });

    expect(coalescer.handleWebSocket('flagsUpdated', flagChange('alice@example.com'))).toBe(true);
    expect(coalescer.handleWebSocket('flagsUpdated', flagChange('bob@example.com'))).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(2);

    // The genuine repeat is still suppressed.
    expect(coalescer.handleWebSocket('flagsUpdated', flagChange('alice@example.com'))).toBe(false);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('processes WebSocket first and suppresses the matching push copy', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
    const payload = { event: 'newMessage', notification_id: 'event-1', message: { uid: 1 } };

    expect(coalescer.handleWebSocket('newMessage', payload)).toBe(true);
    expect(coalescer.handlePush(payload)).toBe(false);
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      'newMessage',
      payload,
      expect.objectContaining({ source: 'websocket', suppressVisual: false }),
    );
  });

  it('cancels a foreground push when the matching WebSocket event wins the race', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
    const pushPayload = {
      event: 'flagsUpdated',
      notification_id: 'event-2',
      mailbox: 'INBOX',
      uids: [2],
    };
    const webSocketPayload = {
      notification_id: 'event-2',
      mailbox: 'INBOX',
      uids: [2],
    };

    expect(coalescer.handlePush(pushPayload)).toBe(true);
    expect(onEvent).not.toHaveBeenCalled();

    expect(coalescer.handleWebSocket('flagsUpdated', webSocketPayload)).toBe(true);
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      'flagsUpdated',
      webSocketPayload,
      expect.objectContaining({ source: 'websocket' }),
    );
  });

  it('uses foreground push as a bounded fallback when no WebSocket event arrives', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
    const payload = { event: 'contactCreated', notification_id: 'event-3', uid: 'contact-1' };

    coalescer.handlePush(payload);
    vi.advanceTimersByTime(PUSH_COALESCE_MS - 1);
    expect(onEvent).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith('contactCreated', payload, {
      source: 'push',
      suppressVisual: false,
    });
  });

  it('queues hidden push with timer and does not suppress visual unless displayedBySystem', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => false });
    const payload = { event: 'newMessage', notification_id: 'event-4', message: { uid: 4 } };

    expect(coalescer.handlePush(payload)).toBe(true);
    // Not called immediately — waits for coalesce timer
    expect(onEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PUSH_COALESCE_MS);
    expect(onEvent).toHaveBeenCalledWith('newMessage', payload, {
      source: 'push',
      suppressVisual: false,
    });
  });

  it('preserves system-display suppression if a queued push becomes the fallback', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
    const payload = {
      event: 'newMessage',
      notification_id: 'event-5',
      displayedBySystem: true,
      message: { uid: 5 },
    };

    coalescer.handlePush(payload);
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).toHaveBeenCalledWith('newMessage', payload, {
      source: 'push',
      suppressVisual: true,
    });
  });

  it('collapses two producers of the same message even when their notification_ids differ', () => {
    // Same uid means the same message. Two sends with distinct per-send
    // notification_ids is exactly the duplicate-producer bug shape, so the
    // legacy identity key must collapse them.
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });

    coalescer.handlePush({
      event: 'newMessage',
      notification_id: 'event-6a',
      message: { uid: 6, subject: 'Same subject' },
    });
    coalescer.handlePush({
      event: 'newMessage',
      notification_id: 'event-6b',
      message: { uid: 6, subject: 'Same subject' },
    });
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('does not collapse genuinely distinct messages', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });

    coalescer.handlePush({
      event: 'newMessage',
      notification_id: 'event-7a',
      message: { uid: 7, subject: 'Same subject' },
    });
    coalescer.handlePush({
      event: 'newMessage',
      notification_id: 'event-7b',
      message: { uid: 8, subject: 'Same subject' },
    });
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('coalesces a WebSocket copy that lacks notification_id with a push that has one', () => {
    // Mixed-version deployments: the push carries notification_id but the
    // WebSocket copy does not (or vice versa). The shared legacy identity is
    // what lets them coalesce.
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });

    coalescer.handlePush({
      event: 'newMessage',
      notification_id: 'push-only-id',
      displayedBySystem: true,
      message: { uid: 9 },
    });
    coalescer.handleWebSocket('newMessage', { message: { uid: 9 } });
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      'newMessage',
      { message: { uid: 9 } },
      { source: 'websocket', suppressVisual: true },
    );
  });

  it('suppresses late provider retries until the bounded TTL expires', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => false });
    const payload = { event: 'mailboxCreated', notification_id: 'event-7', path: 'Archive' };

    expect(coalescer.handlePush(payload)).toBe(true);
    expect(coalescer.handlePush(payload)).toBe(false);
    // Let the coalesce timer fire so the first push is consumed and remembered
    vi.advanceTimersByTime(PUSH_COALESCE_MS);
    expect(onEvent).toHaveBeenCalledTimes(1);
    // TTL is measured from when remember() was called (at PUSH_COALESCE_MS)
    vi.advanceTimersByTime(TRANSPORT_DEDUP_TTL_MS - 1);
    expect(coalescer.handleWebSocket('mailboxCreated', payload)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(coalescer.handleWebSocket('mailboxCreated', payload)).toBe(true);
    expect(onEvent).toHaveBeenCalledTimes(2);
  });

  it('cancels pending fallback work and ignores new events after cleanup', () => {
    const onEvent = vi.fn();
    const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
    const payload = { event: 'newMessage', notification_id: 'event-8', message: { uid: 8 } };

    coalescer.handlePush(payload);
    coalescer.destroy();
    vi.advanceTimersByTime(PUSH_COALESCE_MS);

    expect(onEvent).not.toHaveBeenCalled();
    expect(coalescer.handleWebSocket('newMessage', payload)).toBe(false);
    expect(coalescer.handlePush(payload)).toBe(false);
  });

  describe('distinct server events that share a legacy identity', () => {
    // The server gives every send its own notification_id. A legacy identity
    // only names "this message's \\Seen flag" or "a move from INBOX to Trash",
    // so it must not swallow a later, different event that has its own id.
    const flagChange = (id, action) => ({
      notification_id: id,
      _account: 'alice@example.com',
      mailbox: 'inbox-id',
      uids: [5],
      flags: ['\\Seen'],
      action,
    });

    it('delivers read, unread and read again of one message', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });

      expect(coalescer.handleWebSocket('flagsUpdated', flagChange('n1', 'add'))).toBe(true);
      expect(coalescer.handleWebSocket('flagsUpdated', flagChange('n2', 'remove'))).toBe(true);
      expect(coalescer.handleWebSocket('flagsUpdated', flagChange('n3', 'add'))).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(3);
    });

    it('still merges the WebSocket and push copies of one flag change', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });

      coalescer.handleWebSocket('flagsUpdated', flagChange('n1', 'add'));
      coalescer.handlePush({ event: 'flagsUpdated', ...flagChange('n1', 'add') });
      vi.advanceTimersByTime(PUSH_COALESCE_MS);

      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('delivers every move between the same two folders', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
      // the payload the server sends for a MOVE
      const move = (id, uid) => ({
        notification_id: id,
        sourceMailbox: 'inbox-id',
        destinationMailbox: 'trash-id',
        destinationPath: 'Trash',
        sourceUid: [uid],
        destinationUid: [uid + 100],
      });

      expect(coalescer.handleWebSocket('messagesMoved', move('m1', 1))).toBe(true);
      expect(coalescer.handleWebSocket('messagesMoved', move('m2', 2))).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(2);

      // a second producer of the first move is still collapsed
      expect(coalescer.handleWebSocket('messagesMoved', move('m3', 1))).toBe(false);
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('delivers two edits of one calendar event', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent, isVisible: () => true });
      const edit = (id) => ({ notification_id: id, eventId: 'event-1', calendarId: 'cal-1' });

      expect(coalescer.handleWebSocket('calendarEventUpdated', edit('c1'))).toBe(true);
      expect(coalescer.handleWebSocket('calendarEventUpdated', edit('c2'))).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(2);
    });
  });

  describe('holding a socket event for a push the system may draw (macOS)', () => {
    const payload = {
      _account: 'user@example.com',
      notification_id: 'held-1',
      message: { uid: 7 },
    };
    const holdNewMessage = (eventName) => eventName === 'newMessage';

    it('consumes the socket copy without a visual when the push was shown by the system', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: holdNewMessage,
      });

      expect(coalescer.handleWebSocket('newMessage', payload)).toBe(true);
      expect(onEvent).not.toHaveBeenCalled();

      expect(
        coalescer.handlePush({ ...payload, event: 'newMessage', displayedBySystem: true }),
      ).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith('newMessage', payload, {
        source: 'websocket',
        suppressVisual: true,
      });

      vi.advanceTimersByTime(SOCKET_HOLD_FOR_PUSH_MS + PUSH_COALESCE_MS);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('keeps the visual when the push arrives but the system did not show it', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: holdNewMessage,
      });

      coalescer.handleWebSocket('newMessage', payload);
      coalescer.handlePush({ ...payload, event: 'newMessage' });

      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith('newMessage', payload, {
        source: 'websocket',
        suppressVisual: false,
      });
    });

    it('falls back to the socket copy when no push arrives in time', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: holdNewMessage,
      });

      coalescer.handleWebSocket('newMessage', payload);
      vi.advanceTimersByTime(SOCKET_HOLD_FOR_PUSH_MS - 1);
      expect(onEvent).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onEvent).toHaveBeenCalledWith('newMessage', payload, {
        source: 'websocket',
        suppressVisual: false,
      });

      // A late push is a duplicate by then.
      expect(coalescer.handlePush({ ...payload, event: 'newMessage' })).toBe(false);
      vi.advanceTimersByTime(PUSH_COALESCE_MS);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('ignores a duplicate socket copy while one is held', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: holdNewMessage,
      });

      expect(coalescer.handleWebSocket('newMessage', payload)).toBe(true);
      expect(coalescer.handleWebSocket('newMessage', payload)).toBe(false);
      vi.advanceTimersByTime(SOCKET_HOLD_FOR_PUSH_MS);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('does not hold events the caller does not ask to hold', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: holdNewMessage,
      });
      const flags = {
        _account: 'user@example.com',
        mailbox: 'INBOX',
        uids: [7],
        flags: ['\\Seen'],
        action: 'add',
      };

      coalescer.handleWebSocket('flagsUpdated', flags);
      expect(onEvent).toHaveBeenCalledWith('flagsUpdated', flags, {
        source: 'websocket',
        suppressVisual: false,
      });
    });

    it('treats a throwing hold check as no hold', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: () => {
          throw new Error('boom');
        },
      });

      coalescer.handleWebSocket('newMessage', payload);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('cancels held socket events on cleanup', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({
        onEvent,
        shouldHoldSocketEvent: holdNewMessage,
      });

      coalescer.handleWebSocket('newMessage', payload);
      coalescer.destroy();
      vi.advanceTimersByTime(SOCKET_HOLD_FOR_PUSH_MS);
      expect(onEvent).not.toHaveBeenCalled();
    });
  });

  describe('two server copies of one change', () => {
    // Older servers publish some events twice: each copy has its own
    // notification_id, the same content and the same server timestamp.
    const flags = (id, action, extra = {}) => ({
      notificationId: id,
      timestamp: 1000,
      _account: 'alice@example.com',
      mailbox: 'inbox-id',
      uids: [5],
      flags: ['\\Seen'],
      action,
      ...extra,
    });

    it('delivers a flag change once', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      expect(coalescer.handleWebSocket('flagsUpdated', flags('a', 'add'))).toBe(true);
      expect(coalescer.handleWebSocket('flagsUpdated', flags('b', 'add'))).toBe(false);
      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('drops the push copy of the dropped copy as well', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('flagsUpdated', flags('a', 'add'));
      coalescer.handleWebSocket('flagsUpdated', flags('b', 'add'));
      vi.advanceTimersByTime(REPEATABLE_CONTENT_TTL_MS + 1);
      coalescer.handlePush({ event: 'flagsUpdated', ...flags('b', 'add') });
      vi.advanceTimersByTime(PUSH_COALESCE_MS);

      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('delivers the same change again when it has its own timestamp', () => {
      // read, then unread here (no event back), then read again elsewhere
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('flagsUpdated', flags('a', 'add'));
      expect(
        coalescer.handleWebSocket('flagsUpdated', flags('b', 'add', { timestamp: 1500 })),
      ).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('treats nothing as a copy without a timestamp', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('flagsUpdated', flags('a', 'add', { timestamp: undefined }));
      coalescer.handleWebSocket('flagsUpdated', flags('b', 'add', { timestamp: undefined }));
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('delivers the same change again once the copy window has passed', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('flagsUpdated', flags('a', 'add'));
      vi.advanceTimersByTime(REPEATABLE_CONTENT_TTL_MS);
      expect(coalescer.handleWebSocket('flagsUpdated', flags('b', 'add'))).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('treats push lists sent as strings like the socket arrays', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('flagsUpdated', flags('a', 'add'));
      coalescer.handlePush({
        event: 'flagsUpdated',
        ...flags('b', 'add', { uids: '[5]', flags: '["\\\\Seen"]' }),
      });
      vi.advanceTimersByTime(PUSH_COALESCE_MS);

      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('delivers two label changes that do not name their labels', () => {
      // Older servers omit `labels`; two different changes then look alike.
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });
      const change = (id) => ({
        notificationId: id,
        mailbox: 'inbox-id',
        uids: [5],
        action: 'add',
      });

      coalescer.handleWebSocket('labelsUpdated', change('l1'));
      coalescer.handleWebSocket('labelsUpdated', change('l2'));
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('delivers a folder created, deleted and created again', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });
      const folder = (id, timestamp) => ({ notificationId: id, path: 'Receipts', timestamp });

      expect(coalescer.handleWebSocket('mailboxCreated', folder('c1', 1))).toBe(true);
      expect(coalescer.handleWebSocket('mailboxCreated', folder('c2', 1))).toBe(false);
      expect(coalescer.handleWebSocket('mailboxDeleted', folder('d1', 2))).toBe(true);
      expect(coalescer.handleWebSocket('mailboxCreated', folder('c3', 3))).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(3);
    });

    it('delivers a rename back and forth but not a copy of one rename', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });
      const rename = (id, oldPath, newPath, timestamp) => ({
        notificationId: id,
        oldPath,
        newPath,
        timestamp,
      });

      expect(coalescer.handleWebSocket('mailboxRenamed', rename('r1', 'A', 'B', 1))).toBe(true);
      expect(coalescer.handleWebSocket('mailboxRenamed', rename('r2', 'A', 'B', 1))).toBe(false);
      expect(coalescer.handleWebSocket('mailboxRenamed', rename('r3', 'B', 'A', 2))).toBe(true);
      expect(coalescer.handleWebSocket('mailboxRenamed', rename('r4', 'A', 'B', 3))).toBe(true);
    });

    it('collapses an expunge with string UIDs and its array copy', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('messagesExpunged', { mailbox: 'inbox-id', uids: [1, 2] });
      coalescer.handlePush({ event: 'messagesExpunged', mailbox: 'inbox-id', uids: '1,2' });
      vi.advanceTimersByTime(PUSH_COALESCE_MS);

      expect(onEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('UIDs are only unique within a mailbox', () => {
    it('gives the socket and push copies of a new message one identity', () => {
      // The socket names the mailbox by path, push by id; both carry the
      // message's folder path.
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('newMessage', {
        mailbox: 'INBOX',
        message: { uid: 7, folder_path: 'INBOX' },
      });
      coalescer.handlePush({
        event: 'newMessage',
        mailbox: '64b7f0c2e4b0a1a2b3c4d5e6',
        message: { uid: 7, folder_path: 'INBOX' },
      });
      vi.advanceTimersByTime(PUSH_COALESCE_MS);

      expect(onEvent).toHaveBeenCalledTimes(1);
    });

    it('delivers new messages with the same UID in two mailboxes', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });

      coalescer.handleWebSocket('newMessage', {
        notificationId: 'n1',
        mailbox: 'INBOX',
        message: { uid: 7 },
      });
      coalescer.handleWebSocket('newMessage', {
        notificationId: 'n2',
        mailbox: 'Sent',
        message: { uid: 7 },
      });

      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('delivers a reused UID after UIDVALIDITY changed', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });
      const expunge = (id, uidValidity) => ({
        notificationId: id,
        mailbox: 'folder-id',
        uidValidity,
        uids: [1],
      });

      coalescer.handleWebSocket('messagesExpunged', expunge('e1', 100));
      expect(coalescer.handleWebSocket('messagesExpunged', expunge('e2', 101))).toBe(true);
      expect(onEvent).toHaveBeenCalledTimes(2);
    });

    it('keeps a one-time content key only briefly when the event has a notification id', () => {
      const onEvent = vi.fn();
      const coalescer = createRealtimeEventCoalescer({ onEvent });
      const expunge = (id) => ({ notificationId: id, mailbox: 'folder-id', uids: [1] });

      coalescer.handleWebSocket('messagesExpunged', expunge('e1'));
      expect(coalescer.handleWebSocket('messagesExpunged', expunge('e2'))).toBe(false);
      vi.advanceTimersByTime(ONE_TIME_CONTENT_TTL_MS);
      expect(coalescer.handleWebSocket('messagesExpunged', expunge('e3'))).toBe(true);
    });
  });
});
