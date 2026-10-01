import { describe, expect, it } from 'vitest';
import {
  toUid,
  toKey,
  accountKey,
  coerceLabelList,
  decodeLabelBuffer,
  hasServerLabels,
  hasFromValue,
  hasMeaningfulDraft,
  buildDraftPayload,
  parseResultList,
  isPgpContent,
  worklistFromHeaders,
  backfillBatchDone,
  nextBackfillDecision,
  BACKFILL_NO_PROGRESS_CAP,
} from '../../src/workers/sync-pure.ts';

describe('sync worker pure helpers', () => {
  describe('toUid', () => {
    it('coerces numeric strings', () => {
      expect(toUid('42')).toBe(42);
      expect(toUid(7)).toBe(7);
    });

    it('returns the original value for non-numeric strings', () => {
      expect(toUid('abc')).toBe('abc');
    });

    it('returns 0 for null/undefined', () => {
      expect(toUid(null)).toBe(0);
      expect(toUid(undefined)).toBe(0);
    });
  });

  describe('toKey + accountKey', () => {
    it('composes account/folder into a stable key', () => {
      expect(toKey('a@b.com', 'INBOX')).toBe('a@b.com::INBOX');
    });

    it('accountKey falls back to "default"', () => {
      expect(accountKey('')).toBe('default');
      expect(accountKey(null)).toBe('default');
      expect(accountKey('a@b.com')).toBe('a@b.com');
    });
  });

  describe('coerceLabelList', () => {
    it('normalizes arrays of label strings', () => {
      expect(coerceLabelList(['work', ' urgent ', ''])).toEqual(['work', 'urgent']);
    });

    it('splits comma-separated strings', () => {
      expect(coerceLabelList('work, urgent,  personal ')).toEqual(['work', 'urgent', 'personal']);
    });

    it('filters out empty brackets emitted by some server responses', () => {
      expect(coerceLabelList(['[]', 'work'])).toEqual(['work']);
    });

    it('returns [] for anything else', () => {
      expect(coerceLabelList(null)).toEqual([]);
      expect(coerceLabelList(42)).toEqual([]);
    });

    it('decodes the {type:"Buffer"} shape the list endpoint returns', () => {
      // Real sample from the folders/list response for labels ["testtt-123"].
      const buf = {
        type: 'Buffer',
        data: [139, 6, 128, 91, 34, 116, 101, 115, 116, 116, 116, 45, 49, 50, 51, 34, 93, 3],
      };
      expect(coerceLabelList(buf)).toEqual(['testtt-123']);
    });
  });

  describe('decodeLabelBuffer', () => {
    it('decodes a single-label buffer (real list-endpoint sample)', () => {
      expect(
        decodeLabelBuffer({
          type: 'Buffer',
          data: [139, 6, 128, 91, 34, 116, 101, 115, 116, 116, 116, 45, 49, 50, 51, 34, 93, 3],
        }),
      ).toEqual(['testtt-123']);
    });

    it('decodes a multi-label buffer (framed JSON array)', () => {
      // Bytes for: <framing>["a","b-2"]<framing>
      const json = '["a","b-2"]';
      const data = [139, 6, 128, ...Array.from(json).map((c) => c.charCodeAt(0)), 3];
      expect(decodeLabelBuffer({ type: 'Buffer', data })).toEqual(['a', 'b-2']);
    });

    it('returns null for non-buffer shapes so callers use normal handling', () => {
      expect(decodeLabelBuffer(['work'])).toBeNull();
      expect(decodeLabelBuffer('work')).toBeNull();
      expect(decodeLabelBuffer(null)).toBeNull();
      expect(decodeLabelBuffer({ type: 'Buffer' })).toBeNull();
    });

    it('returns [] for a malformed/unparseable buffer rather than garbage', () => {
      expect(decodeLabelBuffer({ type: 'Buffer', data: [1, 2, 3] })).toEqual([]);
    });
  });

  describe('hasFromValue', () => {
    it('is true for a non-empty trimmed string', () => {
      expect(hasFromValue('me@example.com')).toBe(true);
    });

    it('is false for empty / whitespace / non-string', () => {
      expect(hasFromValue('')).toBe(false);
      expect(hasFromValue('   ')).toBe(false);
      expect(hasFromValue(123)).toBe(false);
    });
  });

  describe('hasMeaningfulDraft', () => {
    it('is true if any address line is populated', () => {
      expect(hasMeaningfulDraft({ to: ['x@y'] })).toBe(true);
      expect(hasMeaningfulDraft({ cc: ['x@y'] })).toBe(true);
      expect(hasMeaningfulDraft({ bcc: ['x@y'] })).toBe(true);
    });

    it('is true for any non-empty subject or body', () => {
      expect(hasMeaningfulDraft({ subject: 'Hi' })).toBe(true);
      expect(hasMeaningfulDraft({ body: 'x' })).toBe(true);
    });

    it('is false for empty scaffolds', () => {
      expect(hasMeaningfulDraft({})).toBe(false);
      expect(hasMeaningfulDraft({ to: [], subject: '   ', body: '\n' })).toBe(false);
    });
  });

  describe('buildDraftPayload', () => {
    it('puts HTML in `html` by default and clears `text`', () => {
      const p = buildDraftPayload({ body: '<b>hi</b>' });
      expect(p.html).toBe('<b>hi</b>');
      expect(p.text).toBeUndefined();
    });

    it('puts body in `text` when plain-text mode is on', () => {
      const p = buildDraftPayload({ body: 'hi', isPlainText: true });
      expect(p.text).toBe('hi');
      expect(p.html).toBeUndefined();
    });

    it('falls back to account for from', () => {
      expect(buildDraftPayload({ account: 'me@example.com' }).from).toBe('me@example.com');
    });

    it('sets has_attachment based on attachments array', () => {
      expect(
        buildDraftPayload({ attachments: [{ name: 'a.pdf', contentType: 'application/pdf' }] })
          .has_attachment,
      ).toBe(true);
      expect(buildDraftPayload({}).has_attachment).toBe(false);
    });

    it('defaults folder to Drafts', () => {
      expect(buildDraftPayload({}).folder).toBe('Drafts');
    });

    it('keeps the headers of the message a draft replies to', () => {
      const p = buildDraftPayload({ inReplyTo: '<a@b>', references: '<a@b>', replyTo: 'r@b.c' });
      expect(p).toMatchObject({ inReplyTo: '<a@b>', references: '<a@b>', replyTo: 'r@b.c' });
    });
  });

  describe('hasServerLabels', () => {
    // a label removed on another device comes back as an empty list, which
    // has to replace the cached labels rather than be filled from them
    it('is true when the server sent a list, empty or not', () => {
      expect(hasServerLabels({ labels: [] })).toBe(true);
      expect(hasServerLabels({ labels: ['work'] })).toBe(true);
    });

    it('is false for the stored bytes older servers sent, or no labels', () => {
      expect(hasServerLabels({ labels: { type: 'Buffer', data: [91, 93] } })).toBe(false);
      expect(hasServerLabels({})).toBe(false);
      expect(hasServerLabels(null)).toBe(false);
    });
  });

  describe('parseResultList', () => {
    it('unwraps {Result:{List:[...]}}', () => {
      expect(parseResultList({ Result: { List: [1, 2, 3] } })).toEqual([1, 2, 3]);
    });

    it('unwraps {Result:[...]}', () => {
      expect(parseResultList({ Result: [1, 2] })).toEqual([1, 2]);
    });

    it('returns the argument if it is already an array', () => {
      expect(parseResultList([4, 5])).toEqual([4, 5]);
    });

    it('returns [] for null / missing', () => {
      expect(parseResultList(null)).toEqual([]);
      expect(parseResultList({})).toEqual([]);
    });
  });

  describe('isPgpContent', () => {
    it('detects inline PGP armor', () => {
      expect(isPgpContent('-----BEGIN PGP MESSAGE-----\nfoo\n-----END PGP MESSAGE-----')).toBe(
        true,
      );
    });

    it('detects PGP/MIME encrypted parts', () => {
      const raw =
        'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="xyz"';
      expect(isPgpContent(raw)).toBe(true);
    });

    it('returns false for plain text / non-strings', () => {
      expect(isPgpContent('just an email')).toBe(false);
      expect(isPgpContent('')).toBe(false);
      expect(isPgpContent(42)).toBe(false);
    });
  });

  describe('worklistFromHeaders', () => {
    it('queues bodies that are missing', () => {
      const headers = [{ id: 'a' }, { id: 'b' }];
      const bodies = [{ body: 'hi' }, null];
      expect(worklistFromHeaders(headers, bodies)).toEqual([{ id: 'b' }]);
    });

    it('queues bodies whose cache is stale-PGP', () => {
      const headers = [{ id: 'a' }];
      const bodies = [{ body: '-----BEGIN PGP MESSAGE-----\n...' }];
      expect(worklistFromHeaders(headers, bodies)).toEqual([{ id: 'a' }]);
    });

    it('queues messages with attachments but no cached attachments', () => {
      const headers = [{ id: 'a', has_attachment: true }];
      const bodies = [{ body: 'hi', attachments: [] }];
      expect(worklistFromHeaders(headers, bodies)).toEqual([{ id: 'a', has_attachment: true }]);
    });

    it('does not queue messages with cached body + no attachments', () => {
      const headers = [{ id: 'a' }];
      const bodies = [{ body: 'hi' }];
      expect(worklistFromHeaders(headers, bodies)).toEqual([]);
    });

    it('respects maxMessages', () => {
      const headers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
      const bodies = [null, null, null];
      expect(worklistFromHeaders(headers, bodies, 2)).toEqual([{ id: 'a' }, { id: 'b' }]);
    });
  });

  describe('backfillBatchDone', () => {
    it('is done when history is exhausted', () => {
      expect(backfillBatchDone({ exhausted: true, pagesProcessed: 5 })).toBe(true);
    });

    it('is done when zero pages were processed (first fetch threw → would loop)', () => {
      // The regression: a pre-network throw left pagesProcessed at 0 and
      // exhausted false, and the old code returned done:false → infinite,
      // network-less re-queue ("Syncing INBOX" forever).
      expect(backfillBatchDone({ exhausted: false, pagesProcessed: 0 })).toBe(true);
    });

    it('keeps going when a batch made progress and is not exhausted', () => {
      expect(backfillBatchDone({ exhausted: false, pagesProcessed: 3 })).toBe(false);
    });

    it('treats missing fields as a zero-progress (done) batch', () => {
      expect(backfillBatchDone()).toBe(true);
      expect(backfillBatchDone({})).toBe(true);
    });
  });

  describe('nextBackfillDecision', () => {
    it('does not re-queue when the worker reports done', () => {
      expect(nextBackfillDecision({ done: true, pagesProcessed: 0 }, 2)).toEqual({
        requeue: false,
        noProgressStreak: 0,
      });
    });

    it('does not re-queue on a null/undefined result', () => {
      expect(nextBackfillDecision(null, 0)).toEqual({ requeue: false, noProgressStreak: 0 });
      expect(nextBackfillDecision(undefined, 1)).toEqual({ requeue: false, noProgressStreak: 0 });
    });

    it('re-queues and resets the streak when a batch made progress', () => {
      expect(nextBackfillDecision({ done: false, pagesProcessed: 4 }, 2)).toEqual({
        requeue: true,
        noProgressStreak: 0,
      });
    });

    it('re-queues but counts consecutive zero-page batches', () => {
      expect(nextBackfillDecision({ done: false, pagesProcessed: 0 }, 0)).toEqual({
        requeue: true,
        noProgressStreak: 1,
      });
      expect(nextBackfillDecision({ done: false, pagesProcessed: 0 }, 1)).toEqual({
        requeue: true,
        noProgressStreak: 2,
      });
    });

    it('stops re-queuing once the no-progress streak hits the cap', () => {
      const atCap = nextBackfillDecision(
        { done: false, pagesProcessed: 0 },
        BACKFILL_NO_PROGRESS_CAP - 1,
      );
      expect(atCap.requeue).toBe(false);
      expect(atCap.noProgressStreak).toBe(0);
    });

    it('a worker stuck on {done:false, pagesProcessed:0} terminates within the cap', () => {
      // Simulate the controller loop against a misbehaving worker; it must stop.
      let streak = 0;
      let iterations = 0;
      for (; iterations < 50; iterations++) {
        const d = nextBackfillDecision({ done: false, pagesProcessed: 0 }, streak);
        streak = d.noProgressStreak;
        if (!d.requeue) break;
      }
      expect(iterations).toBeLessThan(BACKFILL_NO_PROGRESS_CAP);
    });
  });
});
