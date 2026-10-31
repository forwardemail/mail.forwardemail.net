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
import { flagChangeBody, labelChangeBody } from '../utils/message-changes';
import { canonicalizeLabelKeyword } from '../utils/labels';
import {
  extractFromField,
  extractRecipientsField,
  getMessageApiId,
} from '../utils/sync-helpers';
import {
  MANAGED_SCRIPT_NAME,
  createRule,
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
  if (Array.isArray(list)) return list;
  const data = (res as { data?: T[] })?.data;
  if (Array.isArray(data)) return data;
  const messages = (res as { messages?: T[] })?.messages;
  return Array.isArray(messages) ? messages : [];
}

const EXISTING_PAGE_SIZE = 100;

type ExistingMessage = Record<string, unknown>;

function valuesForCondition(message: ExistingMessage, field: string): string[] {
  if (field === 'from') return [extractFromField(message as never)];
  if (field === 'to' || field === 'cc') {
    return [extractRecipientsField(message as never, field)];
  }
  if (field === 'subject') return [String(message.subject ?? message.Subject ?? '')];
  if (field === 'any') {
    return [
      extractFromField(message as never),
      extractRecipientsField(message as never, 'to'),
      extractRecipientsField(message as never, 'cc'),
    ];
  }
  return [];
}

function conditionKey(condition: FilterRule['conditions'][number]): string {
  return `${condition.field}\u0000${condition.op}\u0000${condition.value.trim().toLowerCase()}`;
}

async function fetchExistingBodyMatches(
  value: string,
  auth: { authHeader?: string },
): Promise<Set<string>> {
  const matches = new Set<string>();
  for (let page = 1; ; page += 1) {
    const response = await Remote.request(
      'MessageList',
      {
        page,
        limit: EXISTING_PAGE_SIZE,
        raw: false,
        attachments: false,
        body: value,
      },
      { ...auth, method: 'GET', pathOverride: '/v1/messages' },
    );
    const messages = asArray<ExistingMessage>(response);
    let newRows = 0;
    for (const message of messages) {
      const apiId = getMessageApiId(message as never);
      if (apiId != null && !matches.has(String(apiId))) {
        matches.add(String(apiId));
        newRows += 1;
      }
    }
    if (messages.length < EXISTING_PAGE_SIZE || !newRows) break;
  }
  return matches;
}

function matchesExistingRule(
  message: ExistingMessage,
  rule: FilterRule,
  bodyMatches: Map<string, Set<string>>,
): boolean {
  const conditions = (rule.conditions || []).filter((condition) => condition.value?.trim());
  if (!conditions.length) return false;
  const apiId = getMessageApiId(message as never);

  const matches = conditions.map((condition) => {
    if (condition.field === 'body') {
      return apiId != null && bodyMatches.get(conditionKey(condition))?.has(String(apiId)) === true;
    }
    const needle = condition.value.trim().toLowerCase();
    const values = valuesForCondition(message, condition.field).map((value) => value.toLowerCase());
    const found = values.some((value) =>
      condition.op === 'is' ? value === needle : value.includes(needle),
    );
    return condition.op === 'not_contains' ? !found : found;
  });

  return rule.match === 'any' ? matches.some(Boolean) : matches.every(Boolean);
}

function updateForExistingMessage(
  message: ExistingMessage,
  rule: FilterRule,
): Record<string, unknown> | null {
  const actions = rule.actions || {};
  const update: Record<string, unknown> = {};
  const flags = Array.isArray(message.flags)
    ? message.flags.filter((flag): flag is string => typeof flag === 'string')
    : [];
  const flagsToAdd: string[] = [];

  if (actions.markRead && !flags.some((flag) => flag.toLowerCase() === '\\seen')) {
    flagsToAdd.push('\\Seen');
  }
  if (
    actions.star &&
    !Boolean(message.is_starred || message.is_flagged) &&
    !flags.some((flag) => flag.toLowerCase() === '\\flagged')
  ) {
    flagsToAdd.push('\\Flagged');
  }
  if (flagsToAdd.length) {
    Object.assign(update, flagChangeBody([...flags, ...flagsToAdd], { add: flagsToAdd }));
  }

  const label = canonicalizeLabelKeyword(actions.label);
  if (label) {
    const rawLabels = Array.isArray(message.labels)
      ? message.labels
      : Array.isArray(message.Labels)
        ? message.Labels
        : [];
    const labels = rawLabels
      .map((value) => canonicalizeLabelKeyword(value))
      .filter(Boolean);
    if (!labels.includes(label)) {
      Object.assign(update, labelChangeBody([...labels, label], labels));
    }
  }

  const targetFolder = actions.fileinto;
  const currentFolder = String(message.folder ?? message.folder_path ?? '').toLowerCase();
  if (targetFolder && currentFolder !== targetFolder.toLowerCase()) {
    update.folder = targetFolder;
  }

  return Object.keys(update).length ? update : null;
}

export interface ApplyExistingFilterResult {
  matched: number;
  updated: number;
  failed: number;
  error?: string;
}

/** Apply the supported, reversible actions of a rule to messages already on the server. */
export async function applyFilterToExisting(
  rule: FilterRule,
  requestedAccount?: string,
): Promise<ApplyExistingFilterResult> {
  const unsupportedBodyCondition = (rule.conditions || []).some(
    (condition) =>
      condition.field === 'body' && condition.value?.trim() && condition.op !== 'contains',
  );
  if (unsupportedBodyCondition) {
    return {
      matched: 0,
      updated: 0,
      failed: 0,
      error: 'Existing-message filters currently support From, To, Cc, and Subject conditions.',
    };
  }
  if (rule.actions?.delete || rule.actions?.redirect) {
    return {
      matched: 0,
      updated: 0,
      failed: 0,
      error: 'Delete and forwarding actions apply to new mail only.',
    };
  }

  const account = requestedAccount || Local.get('email') || '';
  const auth = requestOptionsFor(account);
  const seen = new Set<string>();
  const updates: { apiId: string | number; body: Record<string, unknown> }[] = [];
  let matched = 0;
  let updated = 0;
  let failed = 0;

  try {
    const bodyMatches = new Map<string, Set<string>>();
    const bodyConditions = (rule.conditions || []).filter(
      (condition) => condition.field === 'body' && condition.value?.trim(),
    );
    for (const condition of bodyConditions) {
      const key = conditionKey(condition);
      if (!bodyMatches.has(key)) {
        bodyMatches.set(key, await fetchExistingBodyMatches(condition.value.trim(), auth));
      }
    }

    for (let page = 1; ; page += 1) {
      const response = await Remote.request(
        'MessageList',
        {
          page,
          limit: EXISTING_PAGE_SIZE,
          raw: false,
          attachments: false,
        },
        { ...auth, method: 'GET', pathOverride: '/v1/messages' },
      );
      const messages = asArray<ExistingMessage>(response);
      if (!messages.length) break;

      const pageMatches: ExistingMessage[] = [];
      let newRows = 0;
      for (const message of messages) {
        const apiId = getMessageApiId(message as never);
        if (apiId == null || seen.has(String(apiId))) continue;
        seen.add(String(apiId));
        newRows += 1;
        if (matchesExistingRule(message, rule, bodyMatches)) pageMatches.push(message);
      }
      if (!newRows) break;

      matched += pageMatches.length;
      for (const message of pageMatches) {
        const apiId = getMessageApiId(message as never);
        const body = updateForExistingMessage(message, rule);
        if (apiId != null && body) updates.push({ apiId, body });
      }

      if (messages.length < EXISTING_PAGE_SIZE) break;
    }

    // Finish scanning before moving anything. Moving a message out of the
    // current page could shift later pages on APIs that return Inbox-first.
    const CONCURRENCY = 6;
    for (let offset = 0; offset < updates.length; offset += CONCURRENCY) {
      const chunk = updates.slice(offset, offset + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(({ apiId, body }) =>
          Remote.request('MessageUpdate', body, {
            ...auth,
            method: 'PUT',
            pathOverride: `/v1/messages/${encodeURIComponent(apiId)}`,
          }),
        ),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') updated += 1;
        else failed += 1;
      }
    }
  } catch (err) {
    return {
      matched,
      updated,
      failed,
      error: errorMessage(err),
    };
  }

  return { matched, updated, failed };
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

export type BlockSenderResult = { ok: true; already: boolean } | { ok: false; message: string };

/** The two conditions that match an address in From, with or without a display name. */
export function blockConditions(address: string): FilterRule['conditions'] {
  return [
    // "Name <bob@example.com>". The brackets keep notbob@example.com out.
    { field: 'from', op: 'contains', value: `<${address}>` },
    // A bare "bob@example.com" header
    { field: 'from', op: 'is', value: address },
  ];
}

function isBlockRuleFor(rule: FilterRule, address: string): boolean {
  const wanted = blockConditions(address);
  return (
    rule.enabled &&
    rule.match === 'any' &&
    wanted.every((w) =>
      rule.conditions.some(
        (c) => c.field === w.field && c.op === w.op && c.value.toLowerCase() === w.value,
      ),
    )
  );
}

/**
 * File future mail from `address` into the junk folder, as a rule at the top
 * of the managed filters.
 *
 * Built only from the existing condition types, so an older app version that
 * opens and saves the filters keeps the rule intact. Refuses, rather than
 * guessing, when saving would replace something the user did not ask to
 * change: an edited managed script, or another script that is the active one
 * (only one Sieve script runs, and saving activates ours).
 */
export async function blockSender(address: string, junkFolder: string): Promise<BlockSenderResult> {
  const target = String(address || '')
    .trim()
    .toLowerCase();
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(target)) {
    return { ok: false, message: 'This sender has no address that can be blocked.' };
  }
  if (!junkFolder) return { ok: false, message: 'No junk folder is set up for this account.' };

  await loadFilters();
  const blocked = get(filtersBlocked);
  if (blocked === 'imap') {
    return { ok: false, message: 'Filters need IMAP turned on for this alias.' };
  }
  if (blocked === 'catchall') {
    return { ok: false, message: 'Filters are not available when signed in with a catch-all.' };
  }
  const loadError = get(filtersError);
  if (loadError) return { ok: false, message: loadError };
  if (get(managedScriptUnreadable)) {
    return {
      ok: false,
      message:
        'This account has a filter script that was edited outside the app, so blocking cannot be added to it.',
    };
  }
  const activeForeign = get(foreignScripts).find((s) => s.is_active);
  if (activeForeign) {
    return {
      ok: false,
      message: `Your filter script "${activeForeign.name}" is active. Blocking here would turn it off, so add the rule to that script instead.`,
    };
  }

  const rules = get(filterRules);
  if (rules.some((rule) => isBlockRuleFor(rule, target))) return { ok: true, already: true };

  const rule = createRule({
    name: `Block ${target}`,
    match: 'any',
    conditions: blockConditions(target),
    actions: { fileinto: junkFolder, stop: true },
  });
  const saved = await saveFilters([rule, ...rules]);
  if (!saved) {
    return { ok: false, message: get(filtersError) || 'Could not save the filter.' };
  }
  return { ok: true, already: false };
}
