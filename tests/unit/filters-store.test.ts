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
  hoisted.remoteRequest.mockReset();
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

/**
 * A minimal /v1/sieve-scripts server: one list, scripts by id. The store reads
 * back after every write, so a fixed sequence of mocked responses would encode
 * the call order rather than the behaviour.
 */
function fakeServer(initial: { id: string; name: string; content: string }[] = []) {
  const scripts = new Map(initial.map((x) => [x.id, { ...x, is_active: true }]));
  let nextId = 1;
  const calls: { action: string; auth?: string }[] = [];
  hoisted.remoteRequest.mockImplementation(
    async (action: string, payload: Record<string, unknown>, opts: Record<string, unknown>) => {
      calls.push({ action, auth: opts?.authHeader as string | undefined });
      const id = decodeURIComponent(
        String(opts?.pathOverride || '')
          .split('/')
          .pop() || '',
      );
      switch (action) {
        case 'SieveScripts':
          return [...scripts.values()].map(({ content: _c, ...rest }) => rest);
        case 'SieveScript':
          return scripts.get(id);
        case 'SieveScriptCreate': {
          const created = {
            id: `new${nextId++}`,
            name: String(payload.name),
            content: String(payload.content),
            is_active: true,
          };
          scripts.set(created.id, created);
          return created;
        }
        case 'SieveScriptUpdate': {
          const cur = scripts.get(id);
          if (!cur) throw Object.assign(new Error('Not found'), { status: 404 });
          cur.content = String(payload.content);
          return cur;
        }
        case 'SieveScriptDelete':
          scripts.delete(id);
          return {};
        default:
          throw new Error(`unexpected ${action}`);
      }
    },
  );
  return { scripts, calls };
}

describe('saveFilters', () => {
  it('creates the script on first save and activates it in the same call', async () => {
    const server = fakeServer();
    await loadFilters();

    const ok = await saveFilters([managedRule]);

    expect(ok).toBe(true);
    const create = hoisted.remoteRequest.mock.calls.find(([a]) => a === 'SieveScriptCreate')!;
    // An inactive script looks saved but filters nothing.
    expect(create[1]).toMatchObject({ name: MANAGED_SCRIPT_NAME, activate: true });
    expect((create[1] as { content: string }).content).toContain('fileinto :create "Newsletters";');
    expect(create[2]).toMatchObject({ method: 'POST' });
    expect([...server.scripts.values()]).toHaveLength(1);
    expect(get(filtersActive)).toBe(true);
    expect(get(filterRules)).toEqual([managedRule]);
  });

  it('updates in place once the script exists, keeping one script per account', async () => {
    const server = fakeServer([
      { id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) },
    ]);
    await loadFilters();

    expect(await saveFilters([])).toBe(true);

    const update = hoisted.remoteRequest.mock.calls.find(([a]) => a === 'SieveScriptUpdate')!;
    expect(update[2]).toMatchObject({ method: 'PUT', pathOverride: '/v1/sieve-scripts/s1' });
    expect([...server.scripts.keys()]).toEqual(['s1']);
  });

  it('shows what the server stored after saving, not what was sent', async () => {
    const server = fakeServer([
      { id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) },
    ]);
    await loadFilters();
    const renamed = { ...managedRule, name: 'Renamed' };

    await saveFilters([renamed]);

    // The last calls are the read-back of the script just written.
    expect(server.calls.slice(-2).map((c) => c.action)).toEqual(['SieveScripts', 'SieveScript']);
    expect(get(filterRules)).toEqual([renamed]);
  });

  it('refuses to overwrite filters changed elsewhere since they were loaded', async () => {
    const server = fakeServer([
      { id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) },
    ]);
    await loadFilters();
    // Another device saves a different rule set meanwhile.
    const theirs = createRule({
      name: 'From another device',
      conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
      actions: { label: 'billing' },
    });
    server.scripts.get('s1')!.content = rulesToSieve([theirs]);

    const ok = await saveFilters([]);

    expect(ok).toBe(false);
    expect(hoisted.remoteRequest.mock.calls.some(([a]) => a === 'SieveScriptUpdate')).toBe(false);
    // Reloaded, so the screen now mirrors the server.
    expect(get(filterRules)).toEqual([theirs]);
    expect(get(filtersError)).toMatch(/changed on another device/i);
  });

  it('does not recreate a script that was deleted elsewhere', async () => {
    const server = fakeServer([
      { id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) },
    ]);
    await loadFilters();
    server.scripts.delete('s1');

    expect(await saveFilters([managedRule])).toBe(false);
    expect(server.scripts.size).toBe(0);
    expect(get(filterRules)).toEqual([]);
  });

  it('keeps the previous rules in the store when the save fails', async () => {
    hoisted.remoteRequest
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: rulesToSieve([managedRule]) });
    await loadFilters();
    hoisted.remoteRequest
      // the pre-save check finds the script unchanged
      .mockResolvedValueOnce([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }])
      .mockResolvedValueOnce({ content: rulesToSieve([managedRule]) })
      .mockRejectedValueOnce(new Error('nope'));

    const ok = await saveFilters([]);

    expect(ok).toBe(false);
    // A failed save that cleared the list would look like the rules were lost.
    expect(get(filterRules)).toEqual([managedRule]);
  });
});

describe('account binding', () => {
  it('drops a load that finished after the account was reset', async () => {
    let release: (v: unknown) => void = () => {};
    hoisted.remoteRequest.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const pending = loadFilters();
    // Account switch: storage now names another account, and the switch resets.
    localStorage.setItem('webmail_email', 'other@example.com');
    resetFilters();
    release([{ id: 's1', name: MANAGED_SCRIPT_NAME, is_active: true }]);
    await pending;

    expect(get(filterRules)).toEqual([]);
    expect(hoisted.remoteRequest).toHaveBeenCalledTimes(1);
    localStorage.removeItem('webmail_email');
  });

  it("keeps the new account's filters when the switch resets after they loaded", async () => {
    localStorage.setItem('webmail_email', 'new@example.com');
    fakeServer([{ id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) }]);
    await loadFilters();

    // switchAccount calls resetFilters after an await, by which time the view
    // has already loaded the new account.
    resetFilters();

    expect(get(filterRules)).toEqual([managedRule]);
    localStorage.removeItem('webmail_email');
  });
});

describe('deleteAllFilters', () => {
  it('deletes the script and clears state', async () => {
    const server = fakeServer([
      { id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) },
    ]);
    await loadFilters();

    const ok = await deleteAllFilters();

    expect(ok).toBe(true);
    expect(server.scripts.size).toBe(0);
    expect(get(filterRules)).toEqual([]);
    expect(get(filtersActive)).toBe(false);
    const del = hoisted.remoteRequest.mock.calls.find(([a]) => a === 'SieveScriptDelete')!;
    expect(del[2]).toMatchObject({ method: 'DELETE' });
  });

  it('does not delete filters changed elsewhere since they were loaded', async () => {
    const server = fakeServer([
      { id: 's1', name: MANAGED_SCRIPT_NAME, content: rulesToSieve([managedRule]) },
    ]);
    await loadFilters();
    server.scripts.get('s1')!.content = rulesToSieve([{ ...managedRule, name: 'Edited' }]);

    expect(await deleteAllFilters()).toBe(false);
    expect(server.scripts.size).toBe(1);
  });

  it('is a no-op when no script was ever created', async () => {
    hoisted.remoteRequest.mockResolvedValueOnce([]);
    await loadFilters();
    hoisted.remoteRequest.mockClear();

    expect(await deleteAllFilters()).toBe(true);
    expect(hoisted.remoteRequest).not.toHaveBeenCalled();
  });
});
