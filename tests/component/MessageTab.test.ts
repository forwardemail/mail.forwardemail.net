/**
 * Desktop message tab: reading and archiving must go through the shared
 * mailbox actions. The tab used to send its own PUT requests, which updated
 * the server but not the IndexedDB cache or the messages store, so the
 * sidebar unread counts never changed after reading or archiving in a tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { writable } from 'svelte/store';

const mocks = vi.hoisted(() => ({
  toggleRead: vi.fn(async () => undefined),
  archiveMessage: vi.fn(async () => ({ success: true })),
  deleteMessage: vi.fn(async () => ({ success: true })),
  closeTab: vi.fn(),
  loadMessageDetail: vi.fn(async () => undefined),
  demo: false,
  settings: {} as Record<string, unknown>,
}));

vi.mock('../../src/utils/demo-mode', () => ({
  isDemoMode: () => mocks.demo,
  isDemoBlockedError: (err: { demoBlocked?: boolean } | null) => Boolean(err?.demoBlocked),
}));

vi.mock('../../src/stores/mailboxActions', () => ({
  toggleRead: mocks.toggleRead,
  archiveMessage: mocks.archiveMessage,
  deleteMessage: mocks.deleteMessage,
  getForwardAttachments: vi.fn(async () => []),
  verifySignedMessage: vi.fn(async () => null),
  buildReplyQuotedBody: vi.fn(() => ''),
  buildForwardQuotedBody: vi.fn(() => ''),
  addReplyPrefix: vi.fn((s: string) => s),
  addForwardPrefix: vi.fn((s: string) => s),
  stripQuoteCollapseMarkup: vi.fn((s: string) => s),
}));
vi.mock('../../src/stores/mailService', () => ({
  mailService: { loadMessageDetail: mocks.loadMessageDetail, downloadAttachment: vi.fn() },
}));
vi.mock('../../src/stores/tabStore', () => ({ closeTab: mocks.closeTab }));
vi.mock('../../src/stores/settingsStore', () => ({
  getEffectiveSettingValue: vi.fn((id: string) => mocks.settings[id] ?? null),
  localSettingsVersion: writable(0),
}));
vi.mock('../../src/utils/compose-window', () => ({ openComposeWindow: vi.fn() }));
vi.mock('../../src/utils/storage.js', () => ({ Local: { get: vi.fn(() => null) } }));
vi.mock('../../src/utils/storage', () => ({ Local: { get: vi.fn(() => null) } }));
vi.mock('../../src/svelte/components/EmailIframe.svelte', async () => {
  const Stub = (await import('./stubs/Empty.svelte')).default;
  return { default: Stub };
});

const MessageTab = (await import('./stubs/MessageTabHost.svelte')).default;

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    subject: 'Quarterly numbers',
    from: 'Ann <ann@example.com>',
    to: 'me@example.com',
    date: '2026-09-09T12:00:00Z',
    folder: 'INBOX',
    is_unread: true,
    flags: [],
    ...overrides,
  };
}

function renderTab(message: ReturnType<typeof makeMessage>) {
  return render(MessageTab, {
    props: {
      tabId: 'tab-1',
      messageId: message.id,
      accountEmail: 'me@example.com',
      folder: 'INBOX',
      initialMessage: message as never,
    },
  });
}

function findIconButton(container: HTMLElement, iconClass: string): HTMLButtonElement {
  const svg = container.querySelector(`svg.${iconClass}`);
  const button = svg?.closest('button');
  if (!button) throw new Error(`No button with icon ${iconClass}`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.demo = false;
  mocks.settings = {};
  mocks.archiveMessage.mockResolvedValue({ success: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('MessageTab store integration', () => {
  it('marks an unread message read through toggleRead on open', async () => {
    renderTab(makeMessage());
    await waitFor(() => expect(mocks.toggleRead).toHaveBeenCalledTimes(1));
    const arg = mocks.toggleRead.mock.calls[0][0] as {
      id: string;
      is_unread: boolean;
      folder: string;
    };
    expect(arg.id).toBe('msg-1');
    expect(arg.is_unread).toBe(true);
    expect(arg.folder).toBe('INBOX');
  });

  it('does not call toggleRead for a message that is already read', async () => {
    renderTab(makeMessage({ is_unread: false }));
    await waitFor(() => expect(mocks.loadMessageDetail).toHaveBeenCalled());
    expect(mocks.toggleRead).not.toHaveBeenCalled();
  });

  it('leaves the message unread when Mark as read is set to never', async () => {
    mocks.settings.mark_read_delay = -1;
    renderTab(makeMessage());
    await waitFor(() => expect(mocks.loadMessageDetail).toHaveBeenCalled());
    expect(mocks.toggleRead).not.toHaveBeenCalled();
  });

  it('marks the message read only once the tab has been open for the delay', async () => {
    vi.useFakeTimers();
    mocks.settings.mark_read_delay = 5000;
    renderTab(makeMessage());
    await vi.advanceTimersByTimeAsync(4900);
    expect(mocks.toggleRead).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.toggleRead).toHaveBeenCalledTimes(1);
  });

  it('does not mark the message read when the tab closes before the delay', async () => {
    vi.useFakeTimers();
    mocks.settings.mark_read_delay = 5000;
    const { unmount } = renderTab(makeMessage());
    await vi.advanceTimersByTimeAsync(1000);
    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.toggleRead).not.toHaveBeenCalled();
  });

  it('fills in the tab folder when the message row has none', async () => {
    renderTab(makeMessage({ folder: undefined }));
    await waitFor(() => expect(mocks.toggleRead).toHaveBeenCalledTimes(1));
    expect((mocks.toggleRead.mock.calls[0][0] as { folder: string }).folder).toBe('INBOX');
  });

  it('archives through archiveMessage and closes the tab on success', async () => {
    const { container } = renderTab(makeMessage({ is_unread: false }));
    await fireEvent.click(findIconButton(container, 'lucide-archive'));
    await waitFor(() => expect(mocks.closeTab).toHaveBeenCalledWith('tab-1'));
    expect(mocks.archiveMessage).toHaveBeenCalledTimes(1);
    expect((mocks.archiveMessage.mock.calls[0][0] as { id: string }).id).toBe('msg-1');
  });

  it('closes the tab before the archive request has answered', async () => {
    // archiveMessage is optimistic and queues a retry itself, so the tab does
    // not wait a round trip.
    mocks.archiveMessage.mockReturnValue(new Promise(() => {}));
    const { container } = renderTab(makeMessage({ is_unread: false }));
    await fireEvent.click(findIconButton(container, 'lucide-archive'));
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
  });

  it('keeps the tab open when the demo blocks the archive', async () => {
    // Only the demo blocks an action, so only there does the tab wait for it.
    mocks.demo = true;
    mocks.archiveMessage.mockResolvedValue({ success: false, blocked: true });
    const { container } = renderTab(makeMessage({ is_unread: false }));
    await fireEvent.click(findIconButton(container, 'lucide-archive'));
    await waitFor(() => expect(mocks.archiveMessage).toHaveBeenCalledTimes(1));
    expect(mocks.closeTab).not.toHaveBeenCalled();
  });

  it('deletes through deleteMessage', async () => {
    const { container } = renderTab(makeMessage({ is_unread: false }));
    await fireEvent.click(findIconButton(container, 'lucide-trash-2'));
    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
    expect(mocks.deleteMessage).toHaveBeenCalledTimes(1);
  });
});
