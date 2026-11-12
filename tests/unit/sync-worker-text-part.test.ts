// @vitest-environment node
/**
 * The sender's own plain-text part, through the real sync worker and
 * postal-mime. postal-mime makes text from the HTML when a message has none,
 * so the text part is only reported when the MIME tree really carries one;
 * the reader's "plain text when available" format depends on it.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).self = globalThis;
});

const posted: Row[] = [];
const onmessage = () => (self as unknown as { onmessage: (event: unknown) => void }).onmessage;

let seq = 0;
async function parse(raw: string) {
  const taskId = `t${++seq}`;
  onmessage()({ data: { type: 'task', taskId, task: { type: 'parseRaw', raw } } });
  await vi.waitFor(
    () =>
      expect(
        posted.find(
          (m) => m.taskId === taskId && (m.type === 'taskComplete' || m.type === 'taskError'),
        ),
      ).toBeTruthy(),
    { timeout: 15_000 },
  );
  const done = posted.find((m) => m.taskId === taskId && m.type === 'taskComplete') as Row;
  return (done?.summary || done?.result || done) as Row;
}

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  (self as unknown as { postMessage: (msg: Row) => void }).postMessage = (msg) => {
    posted.push(msg);
  };
  await import('../../src/workers/sync.worker.ts');
  onmessage()({
    data: {
      type: 'init',
      config: { apiBase: 'https://api.example.com', account: 'me@x.test', authHeader: 'Basic x' },
    },
  });
});

const alternative = [
  'Content-Type: multipart/alternative; boundary="b"',
  '',
  '--b',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The plain version, written by the sender.',
  '--b',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>The <b>formatted</b> version.</p>',
  '--b--',
  '',
].join('\r\n');

describe('sync worker: the text part of a message', () => {
  it('is the plain-text alternative the sender included', async () => {
    const result = await parse(alternative);
    expect(result.success).toBe(true);
    expect(String(result.textPart).trim()).toBe('The plain version, written by the sender.');
    expect(result.body).toContain('<b>formatted</b>');
  });

  it('is empty for an HTML-only message, even though a text version is made from it', async () => {
    const result = await parse('Content-Type: text/html\r\n\r\n<p>Only <i>HTML</i> here.</p>');
    expect(result.success).toBe(true);
    expect(result.textPart).toBe('');
    // textContent (for search and previews) still has the words.
    expect(String(result.textContent)).toContain('Only');
  });

  it('is the body of a plain-text message', async () => {
    const result = await parse('Content-Type: text/plain\r\n\r\nJust words.');
    expect(String(result.textPart).trim()).toBe('Just words.');
  });

  it('ignores a text file attached to an HTML message', async () => {
    const raw = [
      'Content-Type: multipart/mixed; boundary="m"',
      '',
      '--m',
      'Content-Type: text/html',
      '',
      '<p>See the notes.</p>',
      '--m',
      'Content-Type: text/plain; name="notes.txt"',
      'Content-Disposition: attachment; filename="notes.txt"',
      '',
      'attached notes',
      '--m--',
      '',
    ].join('\r\n');
    const result = await parse(raw);
    expect(result.textPart).toBe('');
  });
});
