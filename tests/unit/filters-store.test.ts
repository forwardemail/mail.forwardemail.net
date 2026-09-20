/**
 * The filters store owns exactly one Sieve script and must never rewrite one it
 * did not author — a script from the main site's editor or a ManageSieve client
 * holds rules this builder cannot reproduce, so overwriting it would silently
 * delete working mail rules.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

const hoisted = vi.hoisted(() => ({ remoteRequest: vi.fn() }));

vi.mock('../../src/utils/remote', () => ({
  Remote: { request: (...a: unknown[]) => hoisted.remoteRequest(...a) },
}));

const {
  loadFilters,
  saveFilters,
  deleteAllFilters,
  resetFilters,
  filterRules,
  filtersActive,
  filtersBlocked,
  filtersError,
  foreignScripts,
  managedScriptUnreadable,
} = await import('../../src/stores/filtersStore');
const { createRule, rulesToSieve, MANAGED_SCRIPT_NAME } =
  await import('../../src/utils/sieve-rules');

const managedRule = createRule({
  name: 'Newsletters',
  conditions: [{ field: 'from', op: 'contains', value: 'news@example.com' }],
  actions: { fileinto: 'Newsletters' },
});

beforeEach(() => {
  vi.clearAllMocks();
  resetFilters();
});

describe('loadFilters', () => {
  it('reads rules back out of the managed script', async () => {
    hoisted.remoteRequest
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: rulesToSieve([managedRule]) });

    await loadFilters();

    expect(get(filterRules)).toEqual([managedRule]);
    expect(get(filtersActive)).toBe(true);
    expect(get(managedScriptUnreadable)).toBe(false);
  });

  it('lists other scripts separately instead of adopting them', async () => {
    hoisted.remoteRequest.mockResolvedValueOnce([
      { id: 's9', name: 'my-own-sieve', is_active: true },
    ]);

    await loadFilters();

    expect(get(foreignScripts).map((s) => s.name)).toEqual(['my-own-sieve']);
    expect(get(filterRules)).toEqual([]);
    // Only the list call — no attempt to read a script we do not own.
    expect(hoisted.remoteRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses to show or overwrite a managed script that was hand-edited', async () => {
    hoisted.remoteRequest
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: 'require ["fileinto"];\nif true { fileinto "X"; }' });

    await loadFilters();

    expect(get(managedScriptUnreadable)).toBe(true);
    expect(get(filterRules)).toEqual([]);

    const ok = await saveFilters([managedRule]);
    expect(ok).toBe(false);
    expect(get(filtersError)).toMatch(/edited outside the app/i);
    // The save must not have been attempted.
    expect(hoisted.remoteRequest).toHaveBeenCalledTimes(2);
  });

  it('reports the IMAP precondition as a blocked reason, not a raw error', async () => {
    hoisted.remoteRequest.mockRejectedValueOnce(
      new Error('IMAP must be enabled to use Sieve scripts.'),
    );

    await loadFilters();

    expect(get(filtersBlocked)).toBe('imap');
    expect(get(filtersError)).toBe('');
  });

  it('reports the catch-all precondition as a blocked reason', async () => {
    hoisted.remoteRequest.mockRejectedValueOnce(
      new Error('Sieve scripts are not allowed for catch-all or wildcard aliases.'),
    );

    await loadFilters();

    expect(get(filtersBlocked)).toBe('catchall');
  });

  it('surfaces an unexpected failure as an error rather than swallowing it', async () => {
    hoisted.remoteRequest.mockRejectedValueOnce(new Error('503 upstream down'));

    await loadFilters();

    expect(get(filtersBlocked)).toBe('');
    expect(get(filtersError)).toMatch(/503/);
  });
});

describe('saveFilters', () => {
  it('creates the script on first save and activates it in the same call', async () => {
    hoisted.remoteRequest.mockResolvedValueOnce([]);
    await loadFilters();
    hoisted.remoteRequest.mockResolvedValueOnce({ id: 'new1', name: MANAGED_SCRIPT_NAME });

    const ok = await saveFilters([managedRule]);

    expect(ok).toBe(true);
    const [action, payload, opts] = hoisted.remoteRequest.mock.calls.at(-1)!;
    expect(action).toBe('SieveScriptCreate');
    expect(opts).toMatchObject({ method: 'POST' });
    // An inactive script looks saved but filters nothing.
    expect(payload).toMatchObject({ name: MANAGED_SCRIPT_NAME, activate: true });
    expect((payload as { content: string }).content).toContain('fileinto :create "Newsletters";');
    expect(get(filtersActive)).toBe(true);
  });

  it('updates in place once the script exists, keeping one script per account', async () => {
    hoisted.remoteRequest
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: rulesToSieve([managedRule]) });
    await loadFilters();
    hoisted.remoteRequest.mockResolvedValueOnce({ id: 's1' });

    await saveFilters([]);

    const [action, , opts] = hoisted.remoteRequest.mock.calls.at(-1)!;
    expect(action).toBe('SieveScriptUpdate');
    expect(opts).toMatchObject({ method: 'PUT', pathOverride: '/v1/sieve-scripts/s1' });
  });

  it('keeps the previous rules in the store when the save fails', async () => {
    hoisted.remoteRequest
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: rulesToSieve([managedRule]) });
    await loadFilters();
    hoisted.remoteRequest.mockRejectedValueOnce(new Error('nope'));

    const ok = await saveFilters([]);

    expect(ok).toBe(false);
    // A failed save that cleared the list would look like the rules were lost.
    expect(get(filterRules)).toEqual([managedRule]);
  });
});

describe('deleteAllFilters', () => {
  it('deletes the script and clears state', async () => {
    hoisted.remoteRequest
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: rulesToSieve([managedRule]) });
    await loadFilters();
    hoisted.remoteRequest.mockResolvedValueOnce({});

    const ok = await deleteAllFilters();

    expect(ok).toBe(true);
    expect(get(filterRules)).toEqual([]);
    expect(get(filtersActive)).toBe(false);
    const [action, , opts] = hoisted.remoteRequest.mock.calls.at(-1)!;
    expect(action).toBe('SieveScriptDelete');
    expect(opts).toMatchObject({ method: 'DELETE' });
  });

  it('is a no-op when no script was ever created', async () => {
    hoisted.remoteRequest.mockResolvedValueOnce([]);
    await loadFilters();
    hoisted.remoteRequest.mockClear();

    expect(await deleteAllFilters()).toBe(true);
    expect(hoisted.remoteRequest).not.toHaveBeenCalled();
  });
});
