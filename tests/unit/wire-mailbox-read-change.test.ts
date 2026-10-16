/**
 * Read changes and next-page prefetch in src/svelte/Mailbox.svelte.
 *
 * The component is not mounted in unit tests, so sendReadChange is lifted out
 * of the source and run with its collaborators stubbed. It has no type
 * annotations, so the text runs as plain JavaScript.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flagChangeBody } from '../../src/utils/message-changes';

const source = readFileSync(path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'), 'utf8');

// The text of the arrow function assigned to `const <name> =`, from `async`
// to its closing brace.
const arrowFunctionSource = (name: string) => {
  const marker = `const ${name} = `;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`${name} not found in Mailbox.svelte`);
  const bodyStart = source.indexOf('=> {', start) + 3;
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start + marker.length, i + 1);
    }
  }
  throw new Error(`${name} has no closing brace`);
};

const ALICE = 'alice@example.com';
const ALICE_AUTH = `Basic ${Buffer.from(`${ALICE}:alice-alias-pass`).toString('base64')}`;

const deps = {
  request: vi.fn(),
  supersede: vi.fn(),
  recoverReadChange: vi.fn(),
  settleUnreadChange: vi.fn(),
  updateFolderUnreadCounts: vi.fn(),
  invalidateFolderInMemCache: vi.fn(),
  modify: vi.fn(),
};

const buildSendReadChange = () => {
  const scope = {
    getMessageApiId: (msg: { id?: string }) => msg?.id ?? null,
    supersedeQueuedMutations: deps.supersede,
    Remote: { request: deps.request },
    flagChangeBody,
    getAuthHeaderForAccount: (account: string) => (account === ALICE ? ALICE_AUTH : ''),
    recoverReadChange: deps.recoverReadChange,
    db: {
      messages: { where: () => ({ equals: () => ({ modify: deps.modify }) }) },
    },
    isActiveAccount: (account: string) => account === ALICE,
    mailboxStore: {
      actions: {
        settleUnreadChange: deps.settleUnreadChange,
        updateFolderUnreadCounts: deps.updateFolderUnreadCounts,
        invalidateFolderInMemCache: deps.invalidateFolderInMemCache,
      },
    },
    get: () => 'INBOX',
    selectedFolder: {},
    console: { warn: vi.fn() },
  };
  const names = Object.keys(scope);
  const make = new Function(...names, `return (${arrowFunctionSource('sendReadChange')});`);
  return make(...names.map((n) => scope[n as keyof typeof scope]));
};

const previous = {
  id: '66f1c0ffee5ad1e000a1b2c3',
  subject: 'Quarterly invoice',
  folder: 'INBOX',
  is_unread: true,
  flags: [],
};
const updated = { ...previous, is_unread: false, flags: ['\\Seen'] };

const httpError = (status: number, message = `HTTP ${status}`) =>
  Object.assign(new Error(message), { status });

beforeEach(() => {
  for (const fn of Object.values(deps)) fn.mockReset();
  deps.request.mockResolvedValue({});
  deps.supersede.mockResolvedValue([]);
  deps.recoverReadChange.mockResolvedValue(undefined);
  deps.modify.mockResolvedValue(1);
});

describe('sendReadChange in Mailbox.svelte', () => {
  it('settles the unread badge for the account once the server has the change', async () => {
    const sendReadChange = buildSendReadChange();

    const result = await sendReadChange({ previous, updated, account: ALICE, label: 'markRead' });

    expect(result).toEqual({ ok: true });
    expect(deps.request.mock.calls[0][2].authHeader).toBe(ALICE_AUTH);
    expect(deps.settleUnreadChange).toHaveBeenCalledWith('66f1c0ffee5ad1e000a1b2c3', ALICE);
  });

  it('settles when the server no longer has the message', async () => {
    deps.request.mockRejectedValueOnce(httpError(404, 'Message does not exist'));
    const sendReadChange = buildSendReadChange();

    await sendReadChange({ previous, updated, account: ALICE, label: 'markRead' });

    expect(deps.settleUnreadChange).toHaveBeenCalledWith('66f1c0ffee5ad1e000a1b2c3', ALICE);
  });

  it('keeps counting the change while it waits to be sent again', async () => {
    deps.request.mockRejectedValueOnce(httpError(503));
    const sendReadChange = buildSendReadChange();

    const result = await sendReadChange({ previous, updated, account: ALICE, label: 'markRead' });

    expect(result).toEqual({ failed: true });
    expect(deps.recoverReadChange).toHaveBeenCalledTimes(1);
    expect(deps.settleUnreadChange).not.toHaveBeenCalled();
  });
});

describe('message page requests from Mailbox.svelte', () => {
  // Without these the worker writes the server's older copy over a row that
  // was just deleted, or whose flag change has not reached the server yet.
  it('every messagePage request passes the pending deletes and flag changes', () => {
    const calls = [...source.matchAll(/sendSyncRequest\('messagePage', \{/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const open = (call.index ?? 0) + call[0].length - 1;
      let depth = 0;
      let end = open;
      for (let i = open; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}' && --depth === 0) {
          end = i;
          break;
        }
      }
      const payload = source.slice(open, end + 1);
      expect(payload).toContain('pendingDeleteIds: getPendingDeleteIds()');
      expect(payload).toContain('pendingFlagMutations: getPendingFlagMutations()');
    }
    expect(source).toMatch(
      /import \{ getPendingDeleteIds, getPendingFlagMutations \} from '\.\.\/stores\/mailboxStore';/,
    );
  });
});
