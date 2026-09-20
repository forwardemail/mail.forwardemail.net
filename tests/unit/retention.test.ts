/**
 * The retention copy has to match what the server actually does, or it tells
 * users their trashed mail is safe for 30 days when the storage sweep will take
 * it in 3. Mirrors helpers/get-database.js and app/models/mailboxes.js.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETENTION_DAYS,
  describeFolderRetention,
  msToDays,
  percentUsed,
  storageScaledRetentionDays,
} from '../../src/utils/retention';

const DAY = 24 * 60 * 60 * 1000;
const GB = 1024 ** 3;

describe('storageScaledRetentionDays', () => {
  it('matches the backend formula across the range', () => {
    expect(storageScaledRetentionDays(0)).toBe(30);
    expect(storageScaledRetentionDays(50)).toBe(15);
    expect(storageScaledRetentionDays(90)).toBe(3);
  });

  it('never drops below one day, so a full mailbox is not wiped instantly', () => {
    expect(storageScaledRetentionDays(100)).toBe(1);
    expect(storageScaledRetentionDays(99.9)).toBe(1);
  });

  it('clamps nonsense input instead of producing a negative window', () => {
    expect(storageScaledRetentionDays(150)).toBe(1);
    expect(storageScaledRetentionDays(-10)).toBe(30);
    expect(storageScaledRetentionDays(Number.NaN)).toBe(30);
  });
});

describe('msToDays', () => {
  it('converts the server millisecond window', () => {
    expect(msToDays(30 * DAY)).toBe(30);
    expect(msToDays(DAY)).toBe(1);
  });

  it('treats zero and nullish as no expiry', () => {
    expect(msToDays(0)).toBeNull();
    expect(msToDays(null)).toBeNull();
    expect(msToDays(undefined)).toBeNull();
  });
});

describe('percentUsed', () => {
  it('guards against a zero or missing quota rather than dividing by it', () => {
    expect(percentUsed(5 * GB, 0)).toBe(0);
    expect(percentUsed(5 * GB, 10 * GB)).toBe(50);
  });
});

describe('describeFolderRetention', () => {
  it('says mail is kept when the folder has no retention window', () => {
    const out = describeFolderRetention({ retention: 0, path: 'INBOX' });
    expect(out.effectiveDays).toBeNull();
    expect(out.text).toMatch(/kept until you delete them/i);
  });

  it('reports the configured window when storage is unknown', () => {
    const out = describeFolderRetention({ retention: 30 * DAY, path: 'Trash' });
    expect(out.effectiveDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(out.text).toBe('Messages here are deleted automatically after 30 days.');
  });

  it('warns that a default window shortens as storage fills', () => {
    const out = describeFolderRetention(
      { retention: 30 * DAY, path: 'Trash' },
      { used: 1 * GB, total: 10 * GB },
    );
    // 10% used still scales to 27 days, which is under 30, so it reports the
    // shorter real number rather than the nominal one.
    expect(out.scaledDays).toBe(27);
    expect(out.effectiveDays).toBe(27);
    expect(out.text).toMatch(/about 27 days/);
    expect(out.text).toMatch(/normally 30 days/);
  });

  it('reports the sweep window when storage pressure makes it much shorter', () => {
    const out = describeFolderRetention(
      { retention: 30 * DAY, path: 'Trash' },
      { used: 9 * GB, total: 10 * GB },
    );
    expect(out.effectiveDays).toBe(3);
    expect(out.text).toMatch(/about 3 days/);
  });

  it('uses the singular at the one-day floor', () => {
    const out = describeFolderRetention(
      { retention: 30 * DAY, path: 'Trash' },
      { used: 10 * GB, total: 10 * GB },
    );
    expect(out.effectiveDays).toBe(1);
    expect(out.text).toMatch(/about 1 day\b/);
  });

  it('does not apply the storage sweep to an explicitly configured window', () => {
    // An alias with its own retention is swept on that value alone, so
    // mentioning storage there would be wrong.
    const out = describeFolderRetention(
      { retention: 7 * DAY, path: 'Trash' },
      { used: 9 * GB, total: 10 * GB },
    );
    expect(out.scaledDays).toBeNull();
    expect(out.effectiveDays).toBe(7);
    expect(out.text).toBe('Messages here are deleted automatically after 7 days.');
  });

  it('ignores a zero quota rather than claiming a one-day window', () => {
    const out = describeFolderRetention(
      { retention: 30 * DAY, path: 'Trash' },
      { used: 0, total: 0 },
    );
    expect(out.effectiveDays).toBe(30);
  });
});
