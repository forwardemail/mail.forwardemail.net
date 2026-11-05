/**
 * The metadata pass asks for changes since the folder's last MODSEQ. A server
 * that honors it lists only changes, so the pass pages to the end of them;
 * an older one lists the whole folder, and the pass must stop at the first
 * page with nothing new or it would walk every message.
 */
import { describe, expect, it } from 'vitest';
import { honoredSinceModseq, metadataPassDone } from '../../src/workers/sync-pure.ts';

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
