/**
 * Request bodies for changing a message's flags and labels
 * (PUT /v1/messages/:id).
 *
 * The flags and labels this client has for a message can be out of date:
 * another client (Thunderbird, a phone, another tab) may have changed the
 * message since. Sending only the whole list overwrote that change, so a
 * message read in Thunderbird went back to unread when it was starred here.
 *
 * What changed is sent as well (flags_add and flags_remove, labels_add and
 * labels_remove), and the server applies only that on top of what it has.
 * Servers without those fields use the whole list, as before.
 *
 * No folder is sent with these changes. The server takes a folder as a move,
 * and the folder this client has can be out of date too: a message moved to
 * Archive in Thunderbird went back to the Inbox when it was read here.
 */

export interface FlagChangeBody {
  flags: string[];
  flags_add?: string[];
  flags_remove?: string[];
}

export interface LabelChangeBody {
  labels: string[];
  labels_add?: string[];
  labels_remove?: string[];
}

const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

// as canonicalizeLabelKeyword in labels.js, and as the server stores labels
const keyword = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

/**
 * @param flags - the message's flags after the change
 * @param change - what changed
 */
export function flagChangeBody(
  flags: unknown,
  { add = [], remove = [] }: { add?: string[]; remove?: string[] } = {},
): FlagChangeBody {
  const body: FlagChangeBody = { flags: list(flags) };
  if (list(add).length > 0) body.flags_add = list(add);
  if (list(remove).length > 0) body.flags_remove = list(remove);
  return body;
}

/**
 * Flags added and nothing else changed (\Answered on the message a reply
 * answered). Without the message's flags only the addition is sent: a server
 * without flags_add then changes nothing, where a guessed whole list would
 * replace every flag the message has.
 *
 * @param flags - the message's flags after the change, or null if unknown
 * @param add - the flags added
 */
export function addFlagsBody(flags: unknown, add: string[]): Partial<FlagChangeBody> {
  if (Array.isArray(flags)) return flagChangeBody(flags, { add });
  return list(add).length > 0 ? { flags_add: list(add) } : {};
}

/**
 * @param labels - the message's labels after the change
 * @param previous - its labels before; without them only the whole list is
 *   sent (a change queued by an older release)
 */
export function labelChangeBody(labels: unknown, previous?: unknown): LabelChangeBody {
  const body: LabelChangeBody = { labels: list(labels) };
  if (!Array.isArray(previous)) return body;

  const before = new Set(previous.map(keyword).filter(Boolean));
  const after = new Set(list(labels).map(keyword).filter(Boolean));
  const add = [...after].filter((label) => !before.has(label));
  const remove = [...before].filter((label) => !after.has(label));
  if (add.length > 0) body.labels_add = add;
  if (remove.length > 0) body.labels_remove = remove;
  return body;
}

/**
 * The flags a queued read or star toggle sets. The queued payload keeps the
 * state from before the toggle (so a change that keeps failing can be undone
 * locally): an unread message was marked read, a starred one was unstarred.
 */
export function queuedToggleBody(
  type: 'toggleRead' | 'toggleStar',
  payload: { isUnread?: boolean; isStarred?: boolean; flags?: string[] } = {},
): FlagChangeBody {
  const flag = type === 'toggleRead' ? '\\Seen' : '\\Flagged';
  const set = type === 'toggleRead' ? Boolean(payload.isUnread) : !payload.isStarred;
  const others = list(payload.flags).filter((f) => f !== flag);
  return set
    ? flagChangeBody([...others, flag], { add: [flag] })
    : flagChangeBody(others, { remove: [flag] });
}
