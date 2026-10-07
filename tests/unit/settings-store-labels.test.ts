import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const requests: Array<{ action: string; body: unknown }> = [];

vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: vi.fn(async (action: string, body: unknown) => {
      requests.push({ action, body });
      return {};
    }),
  },
}));

vi.mock('../../src/utils/db', () => ({
  db: {
    settingsLabels: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    settings: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
  },
  handleDatabaseError: vi.fn(async () => {}),
}));

import {
  createLabel,
  updateLabel,
  deleteLabel,
  settingsLabels,
} from '../../src/stores/settingsStore';

const lastLabelSettings = () =>
  (requests.at(-1)?.body as { settings: { label_settings: Record<string, unknown> } }).settings
    .label_settings;

describe('settingsStore label keywords', () => {
  beforeEach(() => {
    requests.length = 0;
    settingsLabels.set([]);
  });

  it('stores a new label under its lowercase keyword and keeps the typed name', async () => {
    const res = await createLabel({ name: 'Work', color: '#f00' });
    expect(res.success).toBe(true);
    expect(res.label).toMatchObject({ keyword: 'work', name: 'Work' });
    expect(Object.keys(lastLabelSettings())).toEqual(['work']);
    expect(lastLabelSettings().work).toMatchObject({ name: 'Work', color: '#f00' });
  });

  it('rejects a label that only differs by case from an existing one', async () => {
    settingsLabels.set([{ keyword: 'work', name: 'Work' }]);
    const res = await createLabel({ name: 'WORK' });
    expect(res).toMatchObject({ success: false, status: 409 });
    expect(requests).toHaveLength(0);
  });

  it('updates and deletes a legacy mixed-case label by its lowercase keyword', async () => {
    // A definition saved by an older client, before keywords were lowercased.
    settingsLabels.set([{ keyword: 'Work', name: 'Work' }]);

    const updated = await updateLabel('work', { name: 'Day Job' });
    expect(updated.success).toBe(true);
    expect(lastLabelSettings()).toEqual({
      work: { name: 'Day Job', color: undefined, hidden: false, source: 'custom' },
    });

    settingsLabels.set([{ keyword: 'Work', name: 'Work' }]);
    const deleted = await deleteLabel('work');
    expect(deleted.success).toBe(true);
    expect(lastLabelSettings()).toEqual({});
    expect(get(settingsLabels)).toEqual([]);
  });
});
