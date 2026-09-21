/**
 * Search in demo mode.
 *
 * Demo messages exist only inside demo-mode.js: they are never indexed for
 * local search and never written to IndexedDB, so the demo interceptor has to
 * answer the /v1/messages search request itself. Before this, every demo
 * search came back empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activateDemoMode,
  deactivateDemoMode,
  interceptDemoRequest,
} from '../../src/utils/demo-mode';

type Hit = { id: string; subject: string; folder?: string; from?: { address?: string } };

const list = (params: Record<string, unknown>) => {
  const res = interceptDemoRequest(
    'MessageList',
    { limit: 200, page: 1, raw: false, attachments: false, lightweight: true, ...params },
    { method: 'GET', pathOverride: '/v1/messages' },
  );
  expect(res.handled).toBe(true);
  return res.result as Hit[];
};

beforeEach(() => activateDemoMode());
afterEach(() => deactivateDemoMode());

describe('demo-mode message search', () => {
  it('matches free text across every folder and reports the folder of each hit', () => {
    const hits = list({ search: 'DNS verification' });
    expect(hits.map((h) => h.subject)).toEqual(['DNS verification reminder']);
    expect(hits[0].folder).toBe('Archive');
  });

  it('respects the folder the search was scoped to', () => {
    expect(list({ search: 'DNS verification', folder: 'INBOX' })).toEqual([]);
    expect(list({ search: 'invoice', folder: 'INBOX' }).map((h) => h.subject)).toEqual([
      'Invoice #2024-0892',
    ]);
  });

  it('maps the from: operator to the sender', () => {
    const hits = list({ from: 'alice' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.from?.address === 'alice@example.com')).toBe(true);
  });

  it('requires every word of the query to match', () => {
    expect(list({ search: 'invoice hiking' })).toEqual([]);
  });

  it('still pages a folder when no search param is present', () => {
    const page = list({ folder: 'INBOX' });
    expect(page.length).toBeGreaterThan(1);
    expect(page.some((h) => h.subject === 'Welcome to Forward Email!')).toBe(true);
  });
});
