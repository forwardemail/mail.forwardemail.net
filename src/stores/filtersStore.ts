/**
 * Filters: a builder over the account's Sieve scripts.
 *
 * The rules live server-side and run at delivery time, so nothing here has to
 * be open for a filter to fire. The store owns exactly one script (named
 * MANAGED_SCRIPT_NAME) and never rewrites any other, because a script written
 * in the main site's editor or over ManageSieve holds rules this builder
 * cannot reproduce.
 */
import { get, writable, type Writable } from 'svelte/store';
import { Remote } from '../utils/remote';
import {
  MANAGED_SCRIPT_NAME,
  rulesToSieve,
  sieveToRules,
  type FilterRule,
} from '../utils/sieve-rules';

export interface SieveScriptSummary {
  id: string;
  name: string;
  description?: string;
  is_active?: boolean;
  is_valid?: boolean;
  required_capabilities?: string[];
  security_warnings?: { type?: string; message?: string }[];
  updated_at?: string;
}

/** Why filters cannot be used on this alias at all, if so. */
export type FiltersBlockedReason = '' | 'imap' | 'catchall';

export const filterRules: Writable<FilterRule[]> = writable([]);
export const filtersLoading: Writable<boolean> = writable(false);
export const filtersSaving: Writable<boolean> = writable(false);
export const filtersError: Writable<string> = writable('');
/** True when the managed script exists and is the active one. */
export const filtersActive: Writable<boolean> = writable(false);
/** Scripts this builder does not own, surfaced read-only so they aren't a mystery. */
export const foreignScripts: Writable<SieveScriptSummary[]> = writable([]);
export const filtersBlocked: Writable<FiltersBlockedReason> = writable('');
/** Security warnings the server attached to the last save. */
export const filtersWarnings: Writable<string[]> = writable([]);

let managedScriptId: string | null = null;
/**
 * Set when the managed script's content could not be parsed back into rules.
 * Saving is refused in that state rather than overwriting rules we cannot show.
 */
export const managedScriptUnreadable: Writable<boolean> = writable(false);

const errorMessage = (err: unknown): string => {
  const raw =
    (err as { message?: string })?.message ||
    (err as { error?: string })?.error ||
    'Something went wrong';
  return String(raw);
};

/** Map the two hard preconditions the API enforces onto a reason code. */
function blockedReason(err: unknown): FiltersBlockedReason {
  const message = errorMessage(err).toLowerCase();
  if (message.includes('imap must be enabled')) return 'imap';
  if (message.includes('catch-all') || message.includes('wildcard')) return 'catchall';
  return '';
}

function asArray<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const list = (res as { Result?: { List?: T[] } })?.Result?.List;
  return Array.isArray(list) ? list : [];
}

export async function loadFilters(): Promise<void> {
  filtersLoading.set(true);
  filtersError.set('');
  filtersBlocked.set('');
  try {
    const res = await Remote.request('SieveScripts', {}, { method: 'GET' });
    const scripts = asArray<SieveScriptSummary>(res);

    const managed = scripts.find((s) => s.name === MANAGED_SCRIPT_NAME) || null;
    foreignScripts.set(scripts.filter((s) => s.name !== MANAGED_SCRIPT_NAME));
    managedScriptId = managed?.id || null;
    filtersActive.set(Boolean(managed?.is_active));

    if (!managed) {
      filterRules.set([]);
      managedScriptUnreadable.set(false);
      return;
    }

    // The list response omits content, so fetch the script itself for rules.
    const detail = (await Remote.request(
      'SieveScript',
      {},
      { method: 'GET', pathOverride: `/v1/sieve-scripts/${encodeURIComponent(managed.id)}` },
    )) as { content?: string };

    const rules = sieveToRules(detail?.content || '');
    if (rules === null) {
      // Our own script name, but content we did not write (hand-edited, or
      // written by an older format). Show nothing and refuse to save over it.
      managedScriptUnreadable.set(true);
      filterRules.set([]);
      return;
    }
    managedScriptUnreadable.set(false);
    filterRules.set(rules);
  } catch (err) {
    const reason = blockedReason(err);
    filtersBlocked.set(reason);
    if (!reason) filtersError.set(errorMessage(err));
    filterRules.set([]);
    foreignScripts.set([]);
  } finally {
    filtersLoading.set(false);
  }
}

/**
 * Write the rule set back and make it the active script.
 *
 * Activation is part of saving on purpose: a saved-but-inactive script looks
 * identical in the UI and silently filters nothing.
 */
export async function saveFilters(rules: FilterRule[]): Promise<boolean> {
  if (get(managedScriptUnreadable)) {
    filtersError.set(
      'This account has a filter script that was edited outside the app. Delete or rename it before saving filters here.',
    );
    return false;
  }

  filtersSaving.set(true);
  filtersError.set('');
  filtersWarnings.set([]);
  const content = rulesToSieve(rules);

  try {
    let saved: SieveScriptSummary;
    if (managedScriptId) {
      saved = (await Remote.request(
        'SieveScriptUpdate',
        { content, activate: true },
        {
          method: 'PUT',
          pathOverride: `/v1/sieve-scripts/${encodeURIComponent(managedScriptId)}`,
        },
      )) as SieveScriptSummary;
    } else {
      saved = (await Remote.request(
        'SieveScriptCreate',
        {
          name: MANAGED_SCRIPT_NAME,
          description: 'Filters created in the Forward Email app',
          content,
          activate: true,
        },
        { method: 'POST' },
      )) as SieveScriptSummary;
      managedScriptId = saved?.id || null;
    }

    filterRules.set(rules);
    filtersActive.set(true);
    filtersWarnings.set(
      (saved?.security_warnings || [])
        .map((w) => w?.message || '')
        .filter((m): m is string => Boolean(m)),
    );
    return true;
  } catch (err) {
    const reason = blockedReason(err);
    filtersBlocked.set(reason);
    filtersError.set(reason ? '' : errorMessage(err));
    return false;
  } finally {
    filtersSaving.set(false);
  }
}

/** Drop every filter and remove the script entirely. */
export async function deleteAllFilters(): Promise<boolean> {
  if (!managedScriptId) {
    filterRules.set([]);
    return true;
  }
  filtersSaving.set(true);
  filtersError.set('');
  try {
    await Remote.request(
      'SieveScriptDelete',
      {},
      {
        method: 'DELETE',
        pathOverride: `/v1/sieve-scripts/${encodeURIComponent(managedScriptId)}`,
      },
    );
    managedScriptId = null;
    filterRules.set([]);
    filtersActive.set(false);
    managedScriptUnreadable.set(false);
    return true;
  } catch (err) {
    filtersError.set(errorMessage(err));
    return false;
  } finally {
    filtersSaving.set(false);
  }
}

/** Reset store state when the active account changes. */
export function resetFilters(): void {
  managedScriptId = null;
  filterRules.set([]);
  foreignScripts.set([]);
  filtersActive.set(false);
  filtersError.set('');
  filtersBlocked.set('');
  filtersWarnings.set([]);
  managedScriptUnreadable.set(false);
}
