/**
 * The sync worker's metadata pass, driven through its message interface with
 * an in-memory database on the other end of the db port and a fake API.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Not used by the metadata pass; openpgp does not load under jsdom.
vi.mock('openpgp', () => ({}));

type Row = Record<string, unknown>;
const tables = new Map<string, Map<string, Row>>();
const table = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name) as Map<string, Row>;
};
const keyOf = (key: unknown) => JSON.stringify(key);
const rowKey = (name: string, row: Row) =>
  keyOf(name === 'syncManifests' ? [row.account, row.folder] : [row.account, row.id]);

// Answers the worker's db requests the way db.worker does.
function answer(action: string, name: string, payload: Record<string, unknown>) {
  const t = table(name);
  switch (action) {
    case 'get':
      return t.get(keyOf(payload.key));
    case 'put':
      t.set(rowKey(name, payload.record as Row), payload.record as Row);
      return undefined;
    case 'bulkGet':
      return (payload.keys as unknown[]).map((key) => t.get(keyOf(key)));
    case 'bulkPut':
      for (const row of payload.records as Row[]) t.set(rowKey(name, row), row);
      return undefined;
    case 'queryEquals':
      return [...t.values()].filter((row) => row[payload.index as string] === payload.value);
    default:
      return undefined;
  }
}

const posted: Row[] = [];
const requests: URL[] = [];
const server = [
  { id: '64b7f0c2e4b0a1a2b3c4d5e6', uid: 41, flags: ['\\Seen'], from: 'a@x.test', modseq: 7 },
  { id: '64b7f0c2e4b0a1a2b3c4d5e7', uid: 42, flags: [], from: 'b@x.test', modseq: 9 },
];

beforeAll(async () => {
  globalThis.fetch = vi.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    const body = url.searchParams.get('page') === '1' ? server : [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  (self as unknown as { postMessage: (msg: Row) => void }).postMessage = (msg) => {
    posted.push(msg);
  };

  await import('../../src/workers/sync.worker.ts');
  const { port1, port2 } = new MessageChannel();
  port2.onmessage = (event) => {
    const { id, action, table: name, payload } = event.data;
    port2.postMessage({ id, ok: true, result: answer(action, name, payload || {}) });
  };
  const onmessage = (self as unknown as { onmessage: (event: unknown) => void }).onmessage;
  onmessage({ data: { type: 'connectDbPort' }, ports: [port1] });
  onmessage({
    data: {
      type: 'init',
      config: { apiBase: 'https://api.example.com', account: 'me@x.test', authHeader: 'Basic x' },
    },
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('sync worker metadata pass', () => {
  it('records the highest UID, not NaN from the ObjectId, and asks for every message', async () => {
    const onmessage = (self as unknown as { onmessage: (event: unknown) => void }).onmessage;
    onmessage({
      data: {
        type: 'task',
        taskId: 't1',
        task: { type: 'metadata', account: 'me@x.test', folder: 'INBOX', pageSize: 2 },
      },
    });

    await vi.waitFor(() => expect(posted.some((m) => m.type === 'taskComplete')).toBe(true));
    const done = posted.find((m) => m.type === 'taskComplete');
    expect(done?.lastUID).toBe(42);
    const manifest = table('syncManifests').get(keyOf(['me@x.test', 'INBOX']));
    expect(manifest?.lastUID).toBe(42);
    expect(requests.every((url) => !url.searchParams.has('after_uid'))).toBe(true);
    // Every page of one pass asks for the same window: none here, as the pass
    // started without a saved modseq. The highest one is kept for the next.
    expect(requests.length).toBeGreaterThan(1);
    expect(requests.every((url) => !url.searchParams.has('since_modseq'))).toBe(true);
    expect(manifest?.lastModSeq).toBe(9);
    expect(table('messages').size).toBe(2);
  });
});
