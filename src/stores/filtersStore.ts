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
import { canonicalizeLabelKeyword } from '../utils/labels';
import { extractAddressList, normalizeEmail, recipientsToList } from '../utils/address';
import { decodeMimeHeader } from '../utils/mime-utils';
import { lightweightListSupported, noteLightweightListResponse } from '../utils/api-capabilities';
import {
  extractFromField,
  extractRecipientsField,
  getMessageApiId,
  normalizeMessageForCache,
} from '../utils/sync-helpers';
import {
  MANAGED_SCRIPT_NAME,
  createRule,
  exactConditionAddress,
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

/*
 * Applying a rule to mail already in the Inbox.
 *
 * Sieve only sees new mail, so this scans the Inbox page by page and runs the
 * rule's reversible actions through the mailbox's own actions. Those update
 * the open list and the local cache and queue a change that could not be sent,
 * the same as when the user marks or moves a message by hand.
 *
 * Only the Inbox is scanned. Sieve runs at delivery, which is the Inbox, so
 * this matches what the rule would have done; scanning every folder would also
 * move Sent, Drafts, Trash and Junk mail.
 */
const EXISTING_PAGE_SIZE = 100;
const EXISTING_FOLDER = 'INBOX';
/** Messages changed at once, so a large Inbox does not flood the server. */
const EXISTING_CONCURRENCY = 4;

type ExistingMessage = Record<string, unknown>;

/**
 * The mailbox actions a rule runs through. Passed in by the caller so this
 * store does not import the mailbox store.
 */
export interface ExistingMessageActions {
  markRead: (message: ExistingMessage) => Promise<unknown>;
  star: (message: ExistingMessage) => Promise<unknown>;
  addLabel: (message: ExistingMessage, label: string) => Promise<unknown>;
  move: (messages: ExistingMessage[], folder: string) => Promise<unknown>;
}

export interface ApplyExistingProgress {
  /** Inbox messages checked so far. */
  scanned: number;
  /** Of those, how many the rule matches. */
  matched: number;
  /** Matching messages changed so far (ones that already matched the rule's actions are not counted). */
  updated: number;
}

export interface ApplyExistingFilterResult extends ApplyExistingProgress {
  cancelled: boolean;
  error?: string;
}

export interface ApplyExistingOptions {
  account: string;
  actions: ExistingMessageActions;
  signal?: AbortSignal;
  onProgress?: (progress: ApplyExistingProgress) => void;
}

/**
 * Why a rule cannot be applied to existing mail, or '' when it can. Deleting
 * and forwarding old mail cannot be undone, and the server's body search has
 * no "is exactly" or "does not contain".
 */
export function existingFilterUnsupportedReason(rule: FilterRule | null | undefined): string {
  if (!rule) return '';
  if (rule.enabled === false) return 'Turn this filter on first.';
  if (rule.actions?.delete || rule.actions?.redirect) {
    return 'Delete and forward apply to new mail only.';
  }
  const conditions = (rule.conditions || []).filter((c) => c.value?.trim());
  if (conditions.some((c) => c.field === 'body' && c.op !== 'contains')) {
    return 'For existing mail, a Body condition can only use "contains".';
  }
  if (!conditions.length) return 'Add a condition first.';
  const a = rule.actions || {};
  if (!a.fileinto && !a.label && !a.markRead && !a.star) {
    return 'Choose a folder, label, mark read or star first.';
  }
  return '';
}

const ADDRESS_FIELDS: Record<string, string[]> = {
  from: ['from'],
  to: ['to'],
  cc: ['cc'],
  any: ['from', 'to', 'cc'],
};

function displayValue(message: ExistingMessage, field: string): string {
  return field === 'from'
    ? extractFromField(message as never)
    : extractRecipientsField(message as never, field);
}

/** Bare, lowercased addresses in one header of a server row. */
function addressesIn(message: ExistingMessage, field: string): string[] {
  const parsed = extractAddressList(message as never, field);
  const list = parsed.length ? parsed : recipientsToList(displayValue(message, field));
  return list.map((entry) => normalizeEmail(entry)).filter(Boolean);
}

/** Same comparison the Sieve script makes for this condition. */
function conditionMatches(
  message: ExistingMessage,
  condition: FilterRule['conditions'][number],
  bodyMatches: Set<string> | undefined,
): boolean {
  const apiId = getMessageApiId(message as never);
  if (condition.field === 'body') {
    return apiId != null && Boolean(bodyMatches?.has(String(apiId)));
  }

  const needle = condition.value.trim().toLowerCase();
  const address = exactConditionAddress(condition);
  if (address) {
    return (ADDRESS_FIELDS[condition.field] || []).some((field) =>
      addressesIn(message, field).includes(address),
    );
  }

  const values =
    condition.field === 'subject'
      ? [decodeMimeHeader(String(message.subject ?? message.Subject ?? ''))]
      : (ADDRESS_FIELDS[condition.field] || []).map((field) => displayValue(message, field));
  const found = values.some((value) => {
    const lower = value.toLowerCase();
    return condition.op === 'is' ? lower.trim() === needle : lower.includes(needle);
  });
  return condition.op === 'not_contains' ? !found : found;
}

function ruleMatches(
  message: ExistingMessage,
  conditions: FilterRule['conditions'],
  match: FilterRule['match'],
  bodyMatches: Map<string, Set<string>>,
): boolean {
  const results = conditions.map((condition) =>
    conditionMatches(message, condition, bodyMatches.get(condition.value.trim().toLowerCase())),
  );
  return match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

const cancelledError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

const isAbort = (err: unknown, signal?: AbortSignal) =>
  Boolean(signal?.aborted) || (err as { name?: string })?.name === 'AbortError';

/** One Inbox page, lightweight when the server keeps addresses on those. */
async function fetchInboxPage(
  page: number,
  auth: { authHeader?: string },
  signal: AbortSignal | undefined,
  extra: Record<string, unknown> = {},
): Promise<ExistingMessage[]> {
  const request = (lightweight: boolean) =>
    Remote.request(
      'MessageList',
      {
        folder: EXISTING_FOLDER,
        page,
        limit: EXISTING_PAGE_SIZE,
        raw: false,
        attachments: false,
        ...(lightweight ? { lightweight: true, include_body: 0 } : {}),
        ...extra,
      },
      { ...auth, method: 'GET', pathOverride: '/v1/messages', timeout: 60_000, signal },
    );
  const lightweight = lightweightListSupported();
  let messages = asArray<ExistingMessage>(await request(lightweight));
  // A server that strips addresses from lightweight rows would make every
  // From/To/Cc condition miss, so ask again for the full rows.
  if (lightweight && noteLightweightListResponse(messages)) {
    messages = asArray<ExistingMessage>(await request(false));
  }
  return messages;
}

/** Ids of Inbox messages whose body contains the value (server-side search). */
async function inboxBodyMatches(
  value: string,
  auth: { authHeader?: string },
  signal: AbortSignal | undefined,
): Promise<Set<string>> {
  const matches = new Set<string>();
  for (let page = 1; ; page += 1) {
    if (signal?.aborted) throw cancelledError();
    const messages = await fetchInboxPage(page, auth, signal, { body: value });
    let added = 0;
    for (const message of messages) {
      const apiId = getMessageApiId(message as never);
      if (apiId != null && !matches.has(String(apiId))) {
        matches.add(String(apiId));
        added += 1;
      }
    }
    if (messages.length < EXISTING_PAGE_SIZE || !added) break;
  }
  return matches;
}

/**
 * Run a rule's folder, label, read and star actions on matching Inbox mail.
 *
 * Reports progress as it goes and stops between messages when the signal
 * aborts; what was already changed stays changed. Must run for the active
 * account, because the mailbox actions act on it.
 */
export async function applyFilterToExisting(
  rule: FilterRule,
  { account, actions, signal, onProgress }: ApplyExistingOptions,
): Promise<ApplyExistingFilterResult> {
  const progress: ApplyExistingProgress = { scanned: 0, matched: 0, updated: 0 };
  const finish = (extra: Partial<ApplyExistingFilterResult> = {}): ApplyExistingFilterResult => ({
    ...progress,
    cancelled: false,
    ...extra,
  });

  const reason = existingFilterUnsupportedReason(rule);
  if (reason) return finish({ error: reason });

  const activeAccount = () => (Local.get('email') || '') === account;
  if (!account || !activeAccount()) {
    return finish({ error: 'Switch to this account to apply the filter to its mail.' });
  }

  const auth = requestOptionsFor(account);
  const conditions = rule.conditions.filter((c) => c.value?.trim());
  const ruleActions = rule.actions || {};
  const label = canonicalizeLabelKeyword(ruleActions.label);
  const target = ruleActions.fileinto || '';
  const report = () => onProgress?.({ ...progress });

  try {
    const bodyMatches = new Map<string, Set<string>>();
    for (const condition of conditions) {
      const key = condition.value.trim().toLowerCase();
      if (condition.field === 'body' && !bodyMatches.has(key)) {
        bodyMatches.set(key, await inboxBodyMatches(condition.value.trim(), auth, signal));
      }
    }

    // Scan everything before changing anything: moving messages out of the
    // Inbox while paging through it would shift later pages and skip mail.
    const seen = new Set<string>();
    const matched: ExistingMessage[] = [];
    for (let page = 1; ; page += 1) {
      if (signal?.aborted) throw cancelledError();
      const messages = await fetchInboxPage(page, auth, signal);
      let added = 0;
      for (const message of messages) {
        const apiId = getMessageApiId(message as never);
        if (apiId == null || seen.has(String(apiId))) continue;
        seen.add(String(apiId));
        added += 1;
        if (ruleMatches(message, conditions, rule.match, bodyMatches)) {
          matched.push(normalizeMessageForCache(message as never, EXISTING_FOLDER, account));
        }
      }
      progress.scanned = seen.size;
      progress.matched = matched.length;
      report();
      if (messages.length < EXISTING_PAGE_SIZE || !added) break;
    }

    const isSeen = (m: ExistingMessage) =>
      m.is_unread === false ||
      (Array.isArray(m.flags) && m.flags.some((f) => String(f).toLowerCase() === '\\seen'));
    const isStarred = (m: ExistingMessage) =>
      Boolean(m.is_starred) ||
      (Array.isArray(m.flags) && m.flags.some((f) => String(f).toLowerCase() === '\\flagged'));

    // Checked before every change: the mailbox actions act on whichever
    // account is active when they run.
    const switched = new Error('You switched accounts, so the rest was not changed.');
    const stillThisAccount = () => {
      if (signal?.aborted) throw cancelledError();
      if (!activeAccount()) throw switched;
    };

    for (let offset = 0; offset < matched.length; offset += EXISTING_CONCURRENCY) {
      stillThisAccount();
      const chunk = matched.slice(offset, offset + EXISTING_CONCURRENCY);
      const changed = new Set<ExistingMessage>();
      await Promise.all(
        chunk.map(async (message) => {
          // Each action only sets, never toggles, so a message already read or
          // starred is left as it is. The row is updated to match, so the move
          // below carries the new state (a message marked read here is not
          // counted as unread in its new folder).
          if (ruleActions.markRead && !isSeen(message)) {
            stillThisAccount();
            await actions.markRead(message);
            const flags = Array.isArray(message.flags) ? (message.flags as string[]) : [];
            Object.assign(message, { is_unread: false, flags: [...flags, '\\Seen'] });
            changed.add(message);
          }
          if (ruleActions.star && !isStarred(message)) {
            stillThisAccount();
            await actions.star(message);
            const flags = Array.isArray(message.flags) ? (message.flags as string[]) : [];
            Object.assign(message, { is_starred: true, flags: [...flags, '\\Flagged'] });
            changed.add(message);
          }
          const labels = Array.isArray(message.labels) ? (message.labels as string[]) : [];
          if (label && !labels.map((l) => canonicalizeLabelKeyword(l)).includes(label)) {
            stillThisAccount();
            await actions.addLabel(message, label);
            message.labels = [...labels, label];
            changed.add(message);
          }
        }),
      );
      if (target) {
        stillThisAccount();
        // A move that fails is queued and retried, like a move made by hand.
        await actions.move(chunk, target);
        for (const message of chunk) changed.add(message);
      }
      progress.updated += changed.size;
      report();
    }
  } catch (err) {
    if (isAbort(err, signal)) return finish({ cancelled: true });
    return finish({ error: errorMessage(err) });
  }

  return finish();
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
