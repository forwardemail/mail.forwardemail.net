/**
 * How the sync worker talks to the db worker over its MessagePort: the folder
 * list is replaced in one transaction, and a request the db worker never
 * answers fails after a deadline instead of hanging the worker.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('openpgp', () => ({}));

type Row = Record<string, unknown>;
const ACCOUNT = 'me@x.test';

const posted: Row[] = [];
const dbMessages: Row[] = [];
let answerDb = true;
let dbPort: MessagePort;

const onmessage = () => (self as unknown as { onmessage: (event: unknown) => void }).onmessage;

const serverFolderList = [
  { id: 'f1', path: 'INBOX', name: 'INBOX', unseen_count: 3, total: 120 },
  { id: 'f2', path: 'Sent Mail', name: 'Sent Mail', unseen_count: 0, total: 48 },
  { id: 'f3', path: 'Projects/2026', name: '2026', unseen_count: 1, total: 9 },
];

let requestSeq = 0;
function sendRequest(action: string, payload: Row) {
  const requestId = `r${++requestSeq}`;
  onmessage()({ data: { type: 'request', requestId, action, payload } });
  return requestId;
}

const resultFor = (requestId: string) =>
  posted.find(
    (m) => m.requestId === requestId && (m.type === 'requestComplete' || m.type === 'requestError'),
  );

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  globalThis.fetch = vi.fn(
    async () => new Response(JSON.stringify(serverFolderList), { status: 200 }),
  ) as unknown as typeof fetch;
  (self as unknown as { postMessage: (msg: Row) => void }).postMessage = (msg) => {
    posted.push(msg);
  };

  await import('../../src/workers/sync.worker.ts');
  const { port1, port2 } = new MessageChannel();
  dbPort = port2;
  port2.onmessage = (event) => {
    dbMessages.push(event.data);
    if (!answerDb) return;
    port2.postMessage({ id: event.data.id, ok: true, result: [] });
  };
  onmessage()({ data: { type: 'connectDbPort' }, ports: [port1] });
  onmessage()({
    data: {
      type: 'init',
      config: { apiBase: 'https://api.example.com', account: ACCOUNT, authHeader: 'Basic x' },
    },
  });
});

beforeEach(() => {
  answerDb = true;
  dbMessages.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sync worker folder write', () => {
  it('replaces the account folders with a single transaction message', async () => {
    const requestId = sendRequest('folders', { account: ACCOUNT });
    await vi.waitFor(() => expect(resultFor(requestId)).toBeTruthy());

    expect(resultFor(requestId)?.type).toBe('requestComplete');
    expect(dbMessages).toHaveLength(1);
    const [msg] = dbMessages;
    expect(msg.action).toBe('transaction');
    const payload = msg.payload as {
      mode: string;
      tables: string[];
      operations: Array<{ action: string; table: string; payload: Row }>;
    };
    expect(payload.mode).toBe('rw');
    expect(payload.tables).toEqual(['folders']);
    expect(payload.operations.map((op) => op.action)).toEqual(['queryEqualsDelete', 'bulkPut']);
    expect(payload.operations[0].payload).toEqual({ index: 'account', value: ACCOUNT });
    const records = payload.operations[1].payload.records as Row[];
    expect(records.map((r) => r.path)).toEqual(['INBOX', 'Sent Mail', 'Projects/2026']);
    expect(records.every((r) => r.account === ACCOUNT)).toBe(true);
  });
});

describe('sync worker db request deadline', () => {
  it('fails a request the db worker never answers after 60 seconds', async () => {
    answerDb = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const requestId = sendRequest('folders', { account: ACCOUNT });

    // Let the fetch settle so the worker reaches the database write.
    await vi.waitFor(() => expect(dbMessages).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(resultFor(requestId)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1_500);
    const result = resultFor(requestId);
    expect(result?.type).toBe('requestError');
    expect(String(result?.error)).toMatch(/timed out/);

    // A late answer for the abandoned request is ignored rather than throwing.
    dbPort.postMessage({ id: (dbMessages[0] as { id: number }).id, ok: true, result: [] });
  });
});
