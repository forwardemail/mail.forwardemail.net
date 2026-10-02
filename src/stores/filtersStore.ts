/**
 * Filters: a builder over the account's Sieve scripts.
 *
 * The rules live server-side and run at delivery time, so nothing here has to
 * be open for a filter to fire. The store owns exactly one script (named
 * MANAGED_SCRIPT_NAME) and never rewrites any other, because a script written
 * in the main site's editor or over ManageSieve holds rules this builder
 * cannot reproduce.
 *
 * The server is the source of truth. Every load reads the script back, saves
 * first check that nobody changed it since it was loaded (another device, the
 * main site), and a successful save is read back rather than trusting what was
 * sent. Each request is bound to the account it started for, so a slow
 * response can never land under an account the user has since switched to.
 */
import { get, writable, type Writable } from 'svelte/store';
import { Remote } from '../utils/remote';
import { Local } from '../utils/storage';
import { getAuthHeaderForAccount } from '../utils/auth';
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
/** The managed script's content as last read from the server ('' = no script). */
let loadedContent: string | null = null;
/** Bumped by every load and reset, so only the newest load may write the stores. */
let loadGeneration = 0;
/** The account the store's contents (or the load in flight) belong to. */
let stateAccount = '';
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

/** Auth for one account, so a request keeps its account across a switch. */
function requestOptionsFor(account: string): { authHeader?: string } {
  const authHeader = getAuthHeaderForAccount(account);
  return authHeader ? { authHeader } : {};
}

interface ServerState {
  scripts: SieveScriptSummary[];
  managed: SieveScriptSummary | null;
  /** The managed script's content, '' when there is no managed script. */
  content: string;
}

/**
 * Read the script list and the managed script's content from the server.
 * Returns null when `isCurrent` says the result is no longer wanted.
 */
async function fetchServerState(
  account: string,
  isCurrent: () => boolean = () => true,
): Promise<ServerState | null> {
  const auth = requestOptionsFor(account);
  const res = await Remote.request('SieveScripts', {}, { ...auth, method: 'GET' });
  if (!isCurrent()) return null;
  const scripts = asArray<SieveScriptSummary>(res);
  const managed = scripts.find((s) => s.name === MANAGED_SCRIPT_NAME) || null;
  if (!managed) return { scripts, managed, content: '' };

  // The list response omits content, so fetch the script itself for rules.
  const detail = (await Remote.request(
    'SieveScript',
    {},
    {
      ...auth,
      method: 'GET',
      pathOverride: `/v1/sieve-scripts/${encodeURIComponent(managed.id)}`,
    },
  )) as { content?: string };
  return { scripts, managed, content: detail?.content || '' };
}

const CHANGED_ELSEWHERE =
  'Filters were changed on another device or on the website, so they have been reloaded. Make your changes again and save.';

export async function loadFilters(): Promise<void> {
  const account = Local.get('email') || '';
  const generation = ++loadGeneration;
  if (stateAccount !== account) {
    // Never show one account's rules while another account's are loading.
    managedScriptId = null;
    loadedContent = null;
    filterRules.set([]);
    foreignScripts.set([]);
    filtersActive.set(false);
    managedScriptUnreadable.set(false);
  }
  stateAccount = account;
  filtersLoading.set(true);
  filtersError.set('');
  filtersBlocked.set('');
  try {
    const isCurrent = () => generation === loadGeneration;
    const state = await fetchServerState(account, isCurrent);
    // A newer load (or an account switch) started meanwhile: let it win.
    if (!state || !isCurrent()) return;
    const { scripts, managed, content } = state;

    foreignScripts.set(scripts.filter((s) => s.name !== MANAGED_SCRIPT_NAME));
    managedScriptId = managed?.id || null;
    loadedContent = content;
    filtersActive.set(Boolean(managed?.is_active));

    if (!managed) {
      filterRules.set([]);
      managedScriptUnreadable.set(false);
      return;
    }

    const rules = sieveToRules(content);
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
    if (generation !== loadGeneration) return;
    const reason = blockedReason(err);
    filtersBlocked.set(reason);
    if (!reason) filtersError.set(errorMessage(err));
    loadedContent = null;
    filterRules.set([]);
    foreignScripts.set([]);
  } finally {
    if (generation === loadGeneration) filtersLoading.set(false);
  }
}

/**
 * True when the server's managed script is no longer the one we loaded: edited,
 * deleted or created somewhere else. Writing over it would throw those changes
 * away, so callers reload instead.
 */
async function changedSinceLoad(account: string): Promise<boolean> {
  if (loadedContent === null) return true;
  const state = await fetchServerState(account);
  if (!state) return true;
  if ((state.managed?.id || null) !== managedScriptId) return true;
  return state.content !== loadedContent;
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

  const account = Local.get('email') || '';
  filtersSaving.set(true);
  filtersError.set('');
  filtersWarnings.set([]);
  const content = rulesToSieve(rules);

  try {
    if (await changedSinceLoad(account)) {
      await loadFilters();
      filtersError.set(CHANGED_ELSEWHERE);
      return false;
    }

    const auth = requestOptionsFor(account);
    let saved: SieveScriptSummary;
    if (managedScriptId) {
      saved = (await Remote.request(
        'SieveScriptUpdate',
        { content, activate: true },
        {
          ...auth,
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
        { ...auth, method: 'POST' },
      )) as SieveScriptSummary;
      managedScriptId = saved?.id || null;
    }

    const warnings = (saved?.security_warnings || [])
      .map((w) => w?.message || '')
      .filter((m): m is string => Boolean(m));
    // Show what the server stored, not what we sent.
    await loadFilters();
    filtersWarnings.set(warnings);
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
  const account = Local.get('email') || '';
  filtersSaving.set(true);
  filtersError.set('');
  try {
    if (await changedSinceLoad(account)) {
      await loadFilters();
      filtersError.set(CHANGED_ELSEWHERE);
      return false;
    }
    await Remote.request(
      'SieveScriptDelete',
      {},
      {
        ...requestOptionsFor(account),
        method: 'DELETE',
        pathOverride: `/v1/sieve-scripts/${encodeURIComponent(managedScriptId)}`,
      },
    );
    managedScriptId = null;
    loadedContent = '';
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
  // The view may already have started loading the new account (it reacts to
  // the account change before the switch gets here). That state is correct,
  // so only clear what belongs to another account.
  const active = Local.get('email') || '';
  if (stateAccount && stateAccount === active) return;
  stateAccount = '';
  // Drops any load still in flight for the previous account.
  loadGeneration += 1;
  managedScriptId = null;
  loadedContent = null;
  filtersLoading.set(false);
  filterRules.set([]);
  foreignScripts.set([]);
  filtersActive.set(false);
  filtersError.set('');
  filtersBlocked.set('');
  filtersWarnings.set([]);
  managedScriptUnreadable.set(false);
}
