import {
  createRealtimeEventCoalescer,
  getRealtimeEventKey,
  PUSH_COALESCE_MS,
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
});
