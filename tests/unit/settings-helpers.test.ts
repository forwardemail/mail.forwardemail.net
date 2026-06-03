import { describe, expect, it } from 'vitest';
import type { Label } from '../../src/types';
import type { SettingDefinition } from '../../src/stores/settingsRegistry';
import {
  describeLabelError,
  mapLabelSettingsToArray,
  labelsArrayToMap,
  extractSettingsFromAccount,
  buildAccountUpdatePayload,
  normalizeTasksSort,
  parseOverrideValue,
  buildRemoteSettingChange,
} from '../../src/stores/settings-helpers';

// The label functions read keyword/name/color/hidden/source, which don't all
// live on the imported Label type; assert against this structural shape and
// cast fixtures through `unknown` to keep the test type-clean.
interface LabelLike {
  keyword: string;
  name: string;
  color?: string;
  hidden: boolean;
  source: string;
}
const asLabels = (rows: Partial<LabelLike>[]): Label[] => rows as unknown as Label[];

describe('describeLabelError', () => {
  it('treats 401 (and statusCode 401) as an auth/sign-in problem', () => {
    expect(describeLabelError('create label', { status: 401 })).toMatch(/sign in with your alias/);
    expect(describeLabelError('delete label', { statusCode: 401 })).toMatch(
      /sign in with your alias/,
    );
  });

  it('treats an "authorization required" message as auth even without a status', () => {
    expect(describeLabelError('sync labels', new Error('Authorization required'))).toMatch(
      /sign in with your alias/,
    );
  });

  it('surfaces the server message for 400', () => {
    expect(describeLabelError('create label', { status: 400, message: 'bad name' })).toBe(
      "Couldn't create label: Unknown error",
    );
    // a real Error carries its message through
    const e = Object.assign(new Error('name too long'), { status: 400 });
    expect(describeLabelError('create label', e)).toBe("Couldn't create label: name too long");
  });

  it('reports 5xx as a retryable server error with the code', () => {
    expect(describeLabelError('update label', { status: 503 })).toBe(
      "Couldn't update label: server error (503). Try again.",
    );
  });

  it('falls back to "Unknown error" for non-Error throwables', () => {
    expect(describeLabelError('delete label', 'nope')).toBe("Couldn't delete label: Unknown error");
  });
});

describe('mapLabelSettingsToArray', () => {
  it('returns [] for empty/non-object input', () => {
    expect(mapLabelSettingsToArray()).toEqual([]);
    expect(mapLabelSettingsToArray({})).toEqual([]);
    // @ts-expect-error exercising the runtime guard
    expect(mapLabelSettingsToArray(null)).toEqual([]);
  });

  it('maps each keyword entry, applying name/source/hidden defaults', () => {
    const out = mapLabelSettingsToArray({
      work: { name: 'Work', color: '#f00', hidden: true, source: 'system' },
      bare: {},
    }) as unknown as LabelLike[];

    expect(out).toContainEqual({
      keyword: 'work',
      name: 'Work',
      color: '#f00',
      hidden: true,
      source: 'system',
    });
    // bare entry: name defaults to keyword, hidden -> false, source -> custom
    expect(out).toContainEqual({
      keyword: 'bare',
      name: 'bare',
      color: undefined,
      hidden: false,
      source: 'custom',
    });
  });
});

describe('labelsArrayToMap', () => {
  it('keys labels by keyword and applies the same defaults', () => {
    expect(labelsArrayToMap(asLabels([{ keyword: 'work', name: 'Work', color: '#f00' }]))).toEqual({
      work: { name: 'Work', color: '#f00', hidden: false, source: 'custom' },
    });
  });

  it('skips entries without a keyword', () => {
    expect(
      labelsArrayToMap(asLabels([{ name: 'no keyword' }, { keyword: 'ok', name: 'OK' }])),
    ).toEqual({ ok: { name: 'OK', color: undefined, hidden: false, source: 'custom' } });
  });

  it('round-trips with mapLabelSettingsToArray', () => {
    const map = {
      work: { name: 'Work', color: '#f00', hidden: true, source: 'system' },
      home: { name: 'Home', color: '#0f0', hidden: false, source: 'custom' },
    };
    const back = labelsArrayToMap(mapLabelSettingsToArray(map));
    expect(back).toEqual(map);
  });

  it('handles empty/undefined input', () => {
    expect(labelsArrayToMap()).toEqual({});
    expect(labelsArrayToMap([])).toEqual({});
  });
});

describe('extractSettingsFromAccount', () => {
  it('reads nested settings.mail and aliases.defaults', () => {
    const out = extractSettingsFromAccount({
      settings: {
        mail: { archive_folder: 'Archive', sent_folder: 'Sent', drafts_folder: 'Drafts' },
        aliases: { defaults: { signature: 'hi' } },
        labels: asLabels([{ keyword: 'x', name: 'X' }]),
      },
    });
    expect(out.mail).toEqual({
      archive_folder: 'Archive',
      sent_folder: 'Sent',
      drafts_folder: 'Drafts',
    });
    expect(out.aliases.defaults).toEqual({ signature: 'hi' });
    expect(out.labels).toHaveLength(1);
  });

  it('falls back to flat mail_* fields when nested mail is absent', () => {
    const out = extractSettingsFromAccount({
      mail_archive_folder: 'A',
      mail_sent_folder: 'S',
      mail_drafts_folder: 'D',
    });
    expect(out.mail).toEqual({ archive_folder: 'A', sent_folder: 'S', drafts_folder: 'D' });
  });

  it('derives labels from label_settings map when no labels array is present', () => {
    const out = extractSettingsFromAccount({
      label_settings: { work: { name: 'Work' } },
    }) as unknown as { labels: LabelLike[] };
    expect(out.labels).toContainEqual({
      keyword: 'work',
      name: 'Work',
      color: undefined,
      hidden: false,
      source: 'custom',
    });
  });

  it('defaults to null folders / empty aliases for an empty response', () => {
    const out = extractSettingsFromAccount();
    expect(out.mail).toEqual({ archive_folder: null, sent_folder: null, drafts_folder: null });
    expect(out.aliases.defaults).toEqual({});
    expect(out.labels).toEqual([]);
  });
});

describe('buildAccountUpdatePayload', () => {
  it('includes only the mail keys that are explicitly set', () => {
    expect(buildAccountUpdatePayload({ mail: { archive_folder: 'Archive' } })).toEqual({
      settings: { mail: { archive_folder: 'Archive' } },
    });
    // null is a real value (clear the folder) and must be kept
    expect(buildAccountUpdatePayload({ mail: { sent_folder: null } })).toEqual({
      settings: { mail: { sent_folder: null } },
    });
  });

  it('serializes labels into a label_settings map', () => {
    expect(buildAccountUpdatePayload({ labels: asLabels([{ keyword: 'x', name: 'X' }]) })).toEqual({
      settings: {
        label_settings: { x: { name: 'X', color: undefined, hidden: false, source: 'custom' } },
      },
    });
  });

  it('includes alias defaults', () => {
    expect(buildAccountUpdatePayload({ aliases: { defaults: { sig: '1' } } })).toEqual({
      settings: { aliases: { defaults: { sig: '1' } } },
    });
  });

  it('returns {} when there is nothing to change', () => {
    expect(buildAccountUpdatePayload()).toEqual({});
    expect(buildAccountUpdatePayload({})).toEqual({});
    // a mail object with no defined keys produces no settings
    expect(buildAccountUpdatePayload({ mail: {} })).toEqual({});
  });
});

describe('normalizeTasksSort', () => {
  it('accepts the valid keys', () => {
    expect(normalizeTasksSort('due')).toBe('due');
    expect(normalizeTasksSort('title')).toBe('title');
    expect(normalizeTasksSort('created')).toBe('created');
  });

  it('is case-insensitive', () => {
    expect(normalizeTasksSort('TITLE')).toBe('title');
  });

  it('defaults to "due" for anything unrecognized or empty', () => {
    expect(normalizeTasksSort('whatever')).toBe('due');
    expect(normalizeTasksSort('')).toBe('due');
    expect(normalizeTasksSort(null)).toBe('due');
    expect(normalizeTasksSort(undefined)).toBe('due');
  });
});

describe('parseOverrideValue', () => {
  it('parses truthy string forms', () => {
    expect(parseOverrideValue('true')).toBe(true);
    expect(parseOverrideValue('1')).toBe(true);
    expect(parseOverrideValue(true)).toBe(true);
    expect(parseOverrideValue(1)).toBe(true);
  });

  it('parses falsy string forms', () => {
    expect(parseOverrideValue('false')).toBe(false);
    expect(parseOverrideValue('0')).toBe(false);
  });

  it('returns the fallback for null/undefined/unrecognized', () => {
    expect(parseOverrideValue(null)).toBe(false);
    expect(parseOverrideValue(undefined)).toBe(false);
    expect(parseOverrideValue('maybe')).toBe(false);
    expect(parseOverrideValue(null, true)).toBe(true);
    expect(parseOverrideValue('maybe', true)).toBe(true);
  });
});

describe('buildRemoteSettingChange', () => {
  const def = (remotePath?: string[]): SettingDefinition =>
    ({ remotePath }) as unknown as SettingDefinition;

  it('nests the value under the remotePath', () => {
    expect(buildRemoteSettingChange(def(['mail', 'archive_folder']), 'Archive')).toEqual({
      mail: { archive_folder: 'Archive' },
    });
  });

  it('handles a single-element path', () => {
    expect(buildRemoteSettingChange(def(['theme']), 'dark')).toEqual({ theme: 'dark' });
  });

  it('returns {} when the definition has no remotePath', () => {
    expect(buildRemoteSettingChange(def(), 'x')).toEqual({});
    expect(buildRemoteSettingChange(def([]), 'x')).toEqual({});
  });
});
