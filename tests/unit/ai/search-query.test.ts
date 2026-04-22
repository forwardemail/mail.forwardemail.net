/**
 * Search DSL tests.
 *
 * The DSL is the contract between the model and the mailbox: the model emits
 * JSON conforming to SearchQuery, we compile it to the operator string the
 * existing search bar understands. Every accepted shape and every rejected
 * shape below encodes a decision — loosening any of them silently expands
 * what the model can smuggle through.
 */

import { describe, expect, it } from 'vitest';
import {
  validateSearchQuery,
  parseSearchQueryJSON,
  dslToQueryString,
  SearchQueryValidationError,
} from '../../../src/ai/dsl/search-query';

describe('validateSearchQuery', () => {
  it('accepts an empty object', () => {
    expect(validateSearchQuery({})).toEqual({});
  });

  it('accepts a full query and returns a fresh object', () => {
    const input = {
      filters: {
        from: ['alice@acme.com'],
        to: ['bob@acme.com'],
        cc: ['carol@acme.com'],
        subject_contains: ['invoice'],
        labels_any: ['support'],
        labels_all: ['urgent', 'billing'],
        folder: 'inbox',
        has_attachment: true,
        is_unread: true,
        is_flagged: false,
        after: '2026-01-01',
        before: '2026-02-01',
        thread_id: 'thread-123',
      },
      text_query: 'refund',
      sort: 'date_desc',
      limit: 50,
      offset: 0,
      _intent: 'unread from Alice since January',
      _confidence: 0.9,
    };
    expect(validateSearchQuery(input)).toEqual(input);
  });

  it('rejects non-objects', () => {
    expect(() => validateSearchQuery(null)).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery([])).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery('string')).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery(42)).toThrow(SearchQueryValidationError);
  });

  it('rejects unknown top-level fields', () => {
    expect(() => validateSearchQuery({ evil: 1 })).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery({ include_deleted: true })).toThrow(
      SearchQueryValidationError,
    );
  });

  it('rejects unknown filter fields', () => {
    expect(() => validateSearchQuery({ filters: { raw_sql: 'DROP TABLE' } })).toThrow(
      SearchQueryValidationError,
    );
  });

  it('rejects wrong types on string-array filters', () => {
    expect(() => validateSearchQuery({ filters: { from: 'alice@acme.com' } })).toThrow(
      SearchQueryValidationError,
    );
    expect(() => validateSearchQuery({ filters: { from: [1, 2] } })).toThrow(
      SearchQueryValidationError,
    );
    expect(() => validateSearchQuery({ filters: { labels_any: [null] } })).toThrow(
      SearchQueryValidationError,
    );
  });

  it('rejects wrong types on boolean filters', () => {
    expect(() => validateSearchQuery({ filters: { is_unread: 'true' } })).toThrow(
      SearchQueryValidationError,
    );
    expect(() => validateSearchQuery({ filters: { has_attachment: 1 } })).toThrow(
      SearchQueryValidationError,
    );
  });

  it('rejects malformed dates', () => {
    expect(() => validateSearchQuery({ filters: { after: 'not-a-date' } })).toThrow(
      SearchQueryValidationError,
    );
    expect(() => validateSearchQuery({ filters: { before: '' } })).toThrow(
      SearchQueryValidationError,
    );
    expect(() => validateSearchQuery({ filters: { after: 123 } })).toThrow(
      SearchQueryValidationError,
    );
  });

  it('rejects invalid sort values', () => {
    expect(() => validateSearchQuery({ sort: 'newest' })).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery({ sort: '' })).toThrow(SearchQueryValidationError);
  });

  it('rejects non-integer and negative limit/offset', () => {
    expect(() => validateSearchQuery({ limit: 1.5 })).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery({ limit: -1 })).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery({ offset: '10' })).toThrow(SearchQueryValidationError);
  });

  it('rejects _confidence outside [0, 1]', () => {
    expect(() => validateSearchQuery({ _confidence: 1.1 })).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery({ _confidence: -0.1 })).toThrow(SearchQueryValidationError);
    expect(() => validateSearchQuery({ _confidence: 'high' })).toThrow(SearchQueryValidationError);
  });

  it('does not copy unvalidated fields through (prototype pollution defense)', () => {
    const input = { filters: { from: ['alice@acme.com'] }, __proto__: { polluted: true } };
    const out = validateSearchQuery(input);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out as any).polluted).toBeUndefined();
  });

  it('rejects null filters', () => {
    expect(() => validateSearchQuery({ filters: null })).toThrow(SearchQueryValidationError);
  });

  it('surfaces the violating path on error', () => {
    try {
      validateSearchQuery({ filters: { from: 1 } });
    } catch (err) {
      expect((err as SearchQueryValidationError).path).toBe('filters.from');
    }
  });
});

describe('parseSearchQueryJSON', () => {
  it('parses and validates JSON', () => {
    const raw = '{"filters":{"from":["alice@acme.com"]},"text_query":"invoice"}';
    expect(parseSearchQueryJSON(raw)).toEqual({
      filters: { from: ['alice@acme.com'] },
      text_query: 'invoice',
    });
  });

  it('throws SyntaxError on malformed JSON', () => {
    expect(() => parseSearchQueryJSON('{broken')).toThrow(SyntaxError);
  });

  it('throws SearchQueryValidationError on bad shape', () => {
    expect(() => parseSearchQueryJSON('{"filters":{"bogus":1}}')).toThrow(
      SearchQueryValidationError,
    );
  });
});

describe('dslToQueryString', () => {
  it('returns empty string for empty query', () => {
    expect(dslToQueryString({})).toBe('');
  });

  it('emits from/to/cc/subject operators', () => {
    expect(
      dslToQueryString({
        filters: {
          from: ['alice@acme.com'],
          to: ['bob@acme.com'],
          cc: ['carol@acme.com'],
          subject_contains: ['invoice'],
        },
      }),
    ).toBe('from:alice@acme.com to:bob@acme.com cc:carol@acme.com subject:invoice');
  });

  it('emits is:/has:/in: flags', () => {
    expect(
      dslToQueryString({
        filters: {
          folder: 'inbox',
          is_unread: true,
          is_flagged: true,
          has_attachment: true,
        },
      }),
    ).toBe('in:inbox is:unread is:starred has:attachment');
  });

  it('distinguishes is:unread from is:read', () => {
    expect(dslToQueryString({ filters: { is_unread: false } })).toBe('is:read');
    expect(dslToQueryString({ filters: { is_unread: true } })).toBe('is:unread');
  });

  it('emits labels as label: operators (labels_any only; labels_all left to post-filter)', () => {
    expect(dslToQueryString({ filters: { labels_any: ['support', 'urgent'] } })).toBe(
      'label:support label:urgent',
    );
  });

  it('formats after/before as YYYY-MM-DD', () => {
    expect(dslToQueryString({ filters: { after: '2026-01-15T12:00:00Z' } })).toBe(
      'after:2026-01-15',
    );
    expect(dslToQueryString({ filters: { before: '2026-02-01' } })).toBe('before:2026-02-01');
  });

  it('quotes values containing whitespace', () => {
    expect(dslToQueryString({ filters: { subject_contains: ['quarterly review'] } })).toBe(
      'subject:"quarterly review"',
    );
  });

  it('escapes embedded double quotes', () => {
    expect(dslToQueryString({ filters: { subject_contains: ['say "hi"'] } })).toBe(
      'subject:"say \\"hi\\""',
    );
  });

  it('appends text_query at the end', () => {
    expect(
      dslToQueryString({
        filters: { from: ['alice@acme.com'] },
        text_query: 'refund policy',
      }),
    ).toBe('from:alice@acme.com "refund policy"');
  });
});
