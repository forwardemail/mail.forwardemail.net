/**
 * Explaining when Trash and Junk get emptied.
 *
 * The server keeps a per-mailbox retention window (milliseconds, exposed on
 * /v1/folders) and stamps each message with an expiry when it is moved in.
 * Trash and Junk default to 30 days.
 *
 * On top of that, an account that has not set an explicit retention also gets a
 * storage-based sweep: the window shrinks as the mailbox fills, down to a floor
 * of one day, so a nearly full account loses trashed mail much sooner than the
 * 30 days the folder claims. That is why users read the policy as "unclear" —
 * the real number is not the one configured anywhere.
 *
 * Mirrors the backend (helpers/get-database.js, app/models/mailboxes.js).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** The backend's default window for Trash and Junk when nothing is configured. */
export const DEFAULT_RETENTION_DAYS = 30;

export function msToDays(ms: number | null | undefined): number | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / DAY_MS);
}

/**
 * Days the storage-based sweep allows at a given usage percentage.
 *
 * Backend formula: `max(round(30 * (1 - percentUsed / 100)), 1)`. The floor of
 * one day is what stops a full mailbox from having its Trash wiped instantly.
 */
export function storageScaledRetentionDays(percentUsed: number): number {
  const pct = Number.isFinite(percentUsed) ? Math.min(Math.max(percentUsed, 0), 100) : 0;
  return Math.max(Math.round(DEFAULT_RETENTION_DAYS * (1 - pct / 100)), 1);
}

export function percentUsed(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((used / total) * 100);
}

export interface RetentionSummary {
  /** Configured window in days, or null when the folder does not expire mail. */
  configuredDays: number | null;
  /** Window the storage sweep would allow, when it applies. */
  scaledDays: number | null;
  /** What actually happens first. */
  effectiveDays: number | null;
  text: string;
}

/**
 * Human-readable retention for a folder.
 *
 * `storage` is optional: without it the summary reports the configured window
 * only, which is what an offline or not-yet-loaded account can honestly say.
 */
export function describeFolderRetention(
  folder: { retention?: number | null; specialUse?: string; path?: string } | null | undefined,
  storage?: { used?: number; total?: number },
): RetentionSummary {
  const configuredDays = msToDays(folder?.retention);

  if (!configuredDays) {
    return {
      configuredDays: null,
      scaledDays: null,
      effectiveDays: null,
      text: 'Messages here are kept until you delete them.',
    };
  }

  // The storage sweep only runs for accounts on the default window; an account
  // with an explicit retention is swept on that value alone.
  const onDefaultWindow = configuredDays === DEFAULT_RETENTION_DAYS;
  const used = storage?.used;
  const total = storage?.total;
  const haveStorage =
    typeof used === 'number' && typeof total === 'number' && total > 0 && used >= 0;

  if (!onDefaultWindow || !haveStorage) {
    return {
      configuredDays,
      scaledDays: null,
      effectiveDays: configuredDays,
      text: `Messages here are deleted automatically after ${configuredDays} ${
        configuredDays === 1 ? 'day' : 'days'
      }.`,
    };
  }

  const scaledDays = storageScaledRetentionDays(percentUsed(used, total));
  const effectiveDays = Math.min(configuredDays, scaledDays);

  if (scaledDays >= configuredDays) {
    return {
      configuredDays,
      scaledDays,
      effectiveDays,
      text: `Messages here are deleted automatically after ${configuredDays} days. If your storage fills up, they are removed sooner.`,
    };
  }

  return {
    configuredDays,
    scaledDays,
    effectiveDays,
    text: `Messages here are deleted automatically after about ${effectiveDays} ${
      effectiveDays === 1 ? 'day' : 'days'
    }. The limit is normally ${configuredDays} days but shortens as your storage fills up.`,
  };
}
