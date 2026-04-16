import { describe, expect, it } from 'vitest';
import {
  toUid,
  toKey,
  accountKey,
  coerceLabelList,
  hasFromValue,
  hasMeaningfulDraft,
  buildDraftPayload,
  parseResultList,
  isPgpContent,
  worklistFromHeaders,
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
});
