/**
 * Filter rules <-> Sieve source.
 *
 * Filters run server-side at delivery time (the backend runs the script in its
 * Sieve engine during MX delivery), so they work with every client closed. The
 * webmail UI is a builder over that: it owns one script, generates the Sieve
 * for it, and reads its own rules back out on load.
 *
 * Round-tripping is the reason for the metadata line. Parsing arbitrary Sieve
 * back into a builder is a losing game, so the generator writes the rule set as
 * JSON in a leading comment and reads that back instead of re-parsing the
 * script body. A script without that marker was written somewhere else (the
 * main site's editor, a ManageSieve client) and is never rewritten by the
 * builder — the UI shows it read-only so the builder cannot silently destroy
 * hand-written rules.
 */

export type ConditionField = 'from' | 'to' | 'cc' | 'subject' | 'body' | 'any';
export type ConditionOp = 'contains' | 'is' | 'not_contains';
export type MatchMode = 'all' | 'any';

export interface FilterCondition {
  field: ConditionField;
  op: ConditionOp;
  value: string;
}

export interface FilterActions {
  /** Folder path to file the message into. */
  fileinto?: string;
  /** Label keyword to tag the message with. */
  label?: string;
  markRead?: boolean;
  star?: boolean;
  /** Address to forward a copy to. */
  redirect?: string;
  /** Drop the message without filing it anywhere. */
  delete?: boolean;
  /** Skip the remaining rules once this one matches. */
  stop?: boolean;
}

export interface FilterRule {
  id: string;
  name: string;
  enabled: boolean;
  match: MatchMode;
  conditions: FilterCondition[];
  actions: FilterActions;
}

/** Name of the single script the builder owns. */
export const MANAGED_SCRIPT_NAME = 'webmail-filters';

const METADATA_PREFIX = '# fe-filters-v1:';

const HEADER_FIELDS: Record<Exclude<ConditionField, 'body' | 'any'>, string> = {
  from: 'from',
  to: 'to',
  cc: 'cc',
  subject: 'subject',
};

export const CONDITION_FIELD_LABELS: Record<ConditionField, string> = {
  from: 'From',
  to: 'To',
  cc: 'Cc',
  subject: 'Subject',
  body: 'Body',
  any: 'Any recipient or sender',
};

export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  contains: 'contains',
  is: 'is exactly',
  not_contains: 'does not contain',
};

/**
 * Escape a string for a Sieve quoted-string literal (RFC 5228 section 2.4.2).
 * Only the backslash and the double quote are special.
 */
export function escapeSieveString(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

const quoted = (value: string) => `"${escapeSieveString(value)}"`;

/** Fields a condition can test, expanded for the "any" pseudo-field. */
function headersFor(field: ConditionField): string[] {
  if (field === 'any') return ['from', 'to', 'cc'];
  const header = HEADER_FIELDS[field as keyof typeof HEADER_FIELDS];
  return header ? [header] : [];
}

function conditionTest(condition: FilterCondition): string | null {
  const value = (condition.value || '').trim();
  if (!value) return null;

  const matchType = condition.op === 'is' ? ':is' : ':contains';

  if (condition.field === 'body') {
    // :text asks the engine for the decoded text body rather than raw MIME.
    const test = `body :text ${matchType} ${quoted(value)}`;
    return condition.op === 'not_contains' ? `not ${test}` : test;
  }

  const headers = headersFor(condition.field);
  if (!headers.length) return null;
  const headerList =
    headers.length === 1 ? quoted(headers[0]) : `[${headers.map(quoted).join(', ')}]`;
  const test = `header ${matchType} ${headerList} ${quoted(value)}`;
  return condition.op === 'not_contains' ? `not ${test}` : test;
}

/**
 * Sieve extensions a rule set needs, as a sorted require list.
 *
 * Derived from the statements actionLines actually emits rather than from the
 * rule fields, so the two cannot drift. A rule that deletes, for example, keeps
 * its folder in the model for when the user unchecks delete, but emits no
 * fileinto and so must not require it.
 */
export function requiredCapabilities(rules: FilterRule[]): string[] {
  const caps = new Set<string>();
  for (const rule of rules || []) {
    if (!rule.enabled || isRuleEmpty(rule)) continue;
    if ((rule.conditions || []).some((c) => c.field === 'body' && (c.value || '').trim())) {
      caps.add('body');
    }
    for (const line of actionLines(rule.actions || {})) {
      if (line.includes('fileinto')) caps.add('fileinto');
      // :create belongs to the mailbox extension (RFC 5490), not fileinto.
      if (line.includes(':create')) caps.add('mailbox');
      if (line.includes('addflag')) caps.add('imap4flags');
    }
  }
  return [...caps].sort();
}

function actionLines(actions: FilterActions): string[] {
  const lines: string[] = [];

  // Flags come first so they are set on the copy that fileinto files away.
  // These are raw IMAP flag values; quoted() escapes the leading backslash
  // into the "\\Seen" a Sieve string literal needs.
  const flags: string[] = [];
  if (actions.markRead) flags.push('\\Seen');
  if (actions.star) flags.push('\\Flagged');
  if (actions.label) flags.push(actions.label);
  if (flags.length) {
    const list = flags.map(quoted).join(', ');
    lines.push(`  addflag ${flags.length === 1 ? list : `[${list}]`};`);
  }

  if (actions.redirect) lines.push(`  redirect ${quoted(actions.redirect)};`);

  if (actions.delete) {
    // discard alone still leaves the implicit keep in some readings, so be
    // explicit: drop the message and stop processing.
    lines.push('  discard;');
    lines.push('  stop;');
    return lines;
  }

  // :create so filing into a folder the user has not made yet does not fail
  // the whole script at delivery time.
  if (actions.fileinto) lines.push(`  fileinto :create ${quoted(actions.fileinto)};`);

  if (actions.stop) lines.push('  stop;');
  return lines;
}

/** True when the rule would do nothing (no test, or no action). */
export function isRuleEmpty(rule: FilterRule): boolean {
  const hasCondition = rule.conditions.some((c) => (c.value || '').trim());
  const a = rule.actions || {};
  const hasAction = Boolean(
    a.fileinto || a.label || a.markRead || a.star || a.redirect || a.delete,
  );
  return !hasCondition || !hasAction;
}

/**
 * Render a rule set as a complete Sieve script, with the rule JSON in a leading
 * comment so the builder can read its own rules back.
 */
export function rulesToSieve(rules: FilterRule[]): string {
  const usable = (rules || []).filter((r) => !isRuleEmpty(r));
  const caps = requiredCapabilities(usable);

  const lines: string[] = [
    '# Filters managed by the Forward Email webmail app.',
    '# Edits made here are replaced the next time the app saves.',
    // JSON.stringify never emits a raw newline, so this stays one comment line.
    `${METADATA_PREFIX}${JSON.stringify(rules || [])}`,
    '',
  ];

  if (caps.length) {
    lines.push(`require [${caps.map(quoted).join(', ')}];`, '');
  }

  for (const rule of usable) {
    if (!rule.enabled) {
      lines.push(`# ${rule.name || 'Untitled rule'} (disabled)`, '');
      continue;
    }
    const tests = rule.conditions
      .map((c) => conditionTest(c))
      .filter((t): t is string => Boolean(t));
    if (!tests.length) continue;

    const body = actionLines(rule.actions);
    if (!body.length) continue;

    lines.push(`# ${rule.name || 'Untitled rule'}`);
    if (tests.length === 1) {
      lines.push(`if ${tests[0]} {`);
    } else {
      const combinator = rule.match === 'any' ? 'anyof' : 'allof';
      lines.push(`if ${combinator} (${tests.join(', ')}) {`);
    }
    lines.push(...body, '}', '');
  }

  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}

/**
 * Read a rule set back out of a script the builder wrote.
 *
 * Returns null when the script has no metadata line, which means something
 * else wrote it. Callers must treat that as read-only rather than overwriting.
 */
export function sieveToRules(script: string): FilterRule[] | null {
  if (!script) return null;
  const line = script.split('\n').find((l) => l.trimStart().startsWith(METADATA_PREFIX));
  if (!line) return null;
  try {
    const json = line.trimStart().slice(METADATA_PREFIX.length);
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((r) => r && typeof r === 'object') as FilterRule[];
  } catch {
    // A corrupted marker is the same situation as a foreign script: we cannot
    // prove the body matches our model, so we must not rewrite it.
    return null;
  }
}

/** True when this script is one the builder owns and may rewrite. */
export function isManagedScript(script: string): boolean {
  return sieveToRules(script) !== null;
}

let idCounter = 0;

export function createRule(partial: Partial<FilterRule> = {}): FilterRule {
  idCounter += 1;
  return {
    id: partial.id || `rule-${Date.now().toString(36)}-${idCounter}`,
    name: partial.name || '',
    enabled: partial.enabled !== false,
    match: partial.match || 'all',
    conditions: partial.conditions?.length
      ? partial.conditions
      : [{ field: 'from', op: 'contains', value: '' }],
    actions: partial.actions || {},
  };
}

/** One-line plain-English summary of a rule, for the list view. */
export function describeRule(rule: FilterRule): string {
  const conditions = (rule.conditions || [])
    .filter((c) => (c.value || '').trim())
    .map((c) => `${CONDITION_FIELD_LABELS[c.field]} ${CONDITION_OP_LABELS[c.op]} "${c.value}"`);
  const joiner = rule.match === 'any' ? ' or ' : ' and ';
  const when = conditions.length ? conditions.join(joiner) : 'Anything';

  const a = rule.actions || {};
  const actions: string[] = [];
  if (a.fileinto) actions.push(`move to ${a.fileinto}`);
  if (a.label) actions.push(`label ${a.label}`);
  if (a.markRead) actions.push('mark read');
  if (a.star) actions.push('star');
  if (a.redirect) actions.push(`forward to ${a.redirect}`);
  if (a.delete) actions.push('delete');
  if (a.stop) actions.push('stop processing');

  return `${when} → ${actions.length ? actions.join(', ') : 'do nothing'}`;
}
