/**
 * The metadata pass asks for changes since the folder's last MODSEQ. A server
 * that honors it lists only changes, so the pass pages to the end of them;
 * an older one lists the whole folder, and the pass must stop at the first
 * page with nothing new or it would walk every message.
 */
import { describe, expect, it } from 'vitest';
import {
  advanceModseq,
  honoredSinceModseq,
  isFolderToken,
  metadataPassDone,
} from '../../src/workers/sync-pure.ts';

describe('honoredSinceModseq', () => {
  it('is true when every row changed after the MODSEQ asked for', () => {
    expect(honoredSinceModseq(40, [{ modseq: 41 }, { modseq: '57' }])).toBe(true);
    expect(honoredSinceModseq('40', [{ modseq: 41 }])).toBe(true);
  });

  it('is false for an older server that listed the folder anyway', () => {
    expect(honoredSinceModseq(40, [{ modseq: 90 }, { modseq: 12 }])).toBe(false);
    expect(honoredSinceModseq(40, [{ modseq: 40 }])).toBe(false);
  });

  it('is false without a MODSEQ to compare, or rows without one', () => {
    expect(honoredSinceModseq(null, [{ modseq: 3 }])).toBe(false);
    expect(honoredSinceModseq(undefined, [{ modseq: 3 }])).toBe(false);
    expect(honoredSinceModseq('abc', [{ modseq: 3 }])).toBe(false);
    expect(honoredSinceModseq(40, [{ modseq: 41 }, {}])).toBe(false);
  });
});

// An IMAP folder's token is "<uidValidity>:<change counter>". Gmail's
// counters are past what a JavaScript number holds exactly.
describe('honoredSinceModseq for an IMAP folder token', () => {
  it('is true when every row is ahead of the token in the same folder generation', () => {
    expect(honoredSinceModseq('7:400', [{ modseq: '7:412' }, { modseq: '7:412' }])).toBe(true);
  });

  it('tells apart counters a number would round to the same value', () => {
    // Both are 90060115205545360 as numbers.
    expect(honoredSinceModseq('7:90060115205545359', [{ modseq: '7:90060115205545361' }])).toBe(
      true,
    );
    expect(honoredSinceModseq('7:90060115205545361', [{ modseq: '7:90060115205545359' }])).toBe(
      false,
    );
  });

  it('is false when the folder was rebuilt, so its rows are a full listing', () => {
    expect(honoredSinceModseq('7:400', [{ modseq: '8:3' }])).toBe(false);
  });

  it('is false for rows at the token, with none, or with a plain number', () => {
    expect(honoredSinceModseq('7:400', [{ modseq: '7:400' }])).toBe(false);
    expect(honoredSinceModseq('7:400', [{ modseq: '7:412' }, {}])).toBe(false);
    expect(honoredSinceModseq('7:400', [{ modseq: 412 }])).toBe(false);
  });

  it('knows a folder token from a server MODSEQ', () => {
    expect(isFolderToken('7:400')).toBe(true);
    expect(isFolderToken('400')).toBe(false);
    expect(isFolderToken(400)).toBe(false);
    expect(isFolderToken(null)).toBe(false);
  });
});

describe('what a pass saves as read up to', () => {
  const run = (saved: unknown, rows: unknown[]) =>
    rows.reduce(
      (state: { saved: unknown; passToken: string | null }, modseq) => advanceModseq(state, modseq),
      { saved, passToken: null },
    ).saved;

  it('keeps the highest server MODSEQ', () => {
    expect(run(40, [41, '57', 44])).toBe(57);
    expect(run(null, ['12'])).toBe(12);
    expect(run(40, [undefined, null, ''])).toBe(40);
  });

  // Page 1 was read at 412. A flag on one of its messages changed before page
  // 2 was read at 415. Saving 415 would never ask for that change again.
  it('keeps the first folder token of the pass, not the last', () => {
    expect(run('7:400', ['7:412', '7:412', '7:415', '7:415'])).toBe('7:412');
  });

  it('replaces an older token, and one from before the folder was rebuilt', () => {
    expect(run('7:400', ['7:412'])).toBe('7:412');
    expect(run('6:9000', ['7:3'])).toBe('7:3');
    expect(run(null, ['7:3'])).toBe('7:3');
  });

  it('leaves the saved token alone when the pass read no rows', () => {
    expect(run('7:400', [])).toBe('7:400');
  });
});

describe('metadataPassDone', () => {
  it('pages through a full page of changes the WebSocket already applied', () => {
    expect(metadataPassDone({ filtered: true, rows: 50, limit: 50, inserted: 0, updated: 0 })).toBe(
      false,
    );
  });

  it('ends a filtered pass on a short page', () => {
    expect(metadataPassDone({ filtered: true, rows: 12, limit: 50, inserted: 3, updated: 9 })).toBe(
      true,
    );
  });

  it('ends an unfiltered pass at the first page with nothing new', () => {
    expect(
      metadataPassDone({ filtered: false, rows: 50, limit: 50, inserted: 0, updated: 0 }),
    ).toBe(true);
    expect(
      metadataPassDone({ filtered: false, rows: 50, limit: 50, inserted: 0, updated: 2 }),
    ).toBe(false);
  });
});
