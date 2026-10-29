/**
 * Block sender adds one rule to the managed filters. It must never turn off a
 * script the user wrote elsewhere, never write over a hand-edited managed
 * script, and produce a rule an older app version keeps when it re-saves.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Script = { id: string; name: string; is_active: boolean; content: string };

const server = vi.hoisted(() => ({ scripts: [] as Script[], seq: 0 }));

vi.mock('../../src/utils/remote', () => ({
  Remote: {
    request: vi.fn(
      async (action: string, params: Record<string, unknown>, opts: Record<string, string>) => {
        const id = decodeURIComponent(
          String(opts?.pathOverride || '')
            .split('/')
            .pop() || '',
        );
        if (action === 'SieveScripts') return server.scripts.map(({ content: _c, ...s }) => s);
        if (action === 'SieveScript')
          return { content: server.scripts.find((s) => s.id === id)?.content };
        if (action === 'SieveScriptCreate') {
          const script = {
            id: `s${++server.seq}`,
            name: String(params.name),
            is_active: Boolean(params.activate),
            content: String(params.content),
          };
          if (script.is_active) server.scripts.forEach((s) => (s.is_active = false));
          server.scripts.push(script);
          return script;
        }
        if (action === 'SieveScriptUpdate') {
          const script = server.scripts.find((s) => s.id === id)!;
          script.content = String(params.content);
          if (params.activate) {
            server.scripts.forEach((s) => (s.is_active = false));
            script.is_active = true;
          }
          return script;
        }
        throw new Error(`unexpected ${action}`);
      },
    ),
  },
}));

const { blockSender, resetFilters } = await import('../../src/stores/filtersStore');
const { rulesToSieve, sieveToRules, createRule, MANAGED_SCRIPT_NAME } =
  await import('../../src/utils/sieve-rules');

const managed = () => server.scripts.find((s) => s.name === MANAGED_SCRIPT_NAME);

beforeEach(() => {
  server.scripts = [];
  server.seq = 0;
  resetFilters();
});

describe('blockSender', () => {
  it('creates the managed script with a rule that files the sender into Junk', async () => {
    const result = await blockSender('Spammer@Example.com', 'Junk');
    expect(result).toEqual({ ok: true, already: false });

    const script = managed()!;
    expect(script.is_active).toBe(true);
    expect(script.content).toContain('header :contains "from" "<spammer@example.com>"');
    expect(script.content).toContain('header :is "from" "spammer@example.com"');
    expect(script.content).toContain('fileinto :create "Junk"');

    const [rule] = sieveToRules(script.content)!;
    expect(rule.match).toBe('any');
    expect(rule.name).toBe('Block spammer@example.com');
  });

  it('puts the block first and keeps the existing rules', async () => {
    const existing = createRule({
      name: 'Newsletters',
      conditions: [{ field: 'from', op: 'contains', value: 'news@' }],
      actions: { fileinto: 'News' },
    });
    server.scripts.push({
      id: 's1',
      name: MANAGED_SCRIPT_NAME,
      is_active: true,
      content: rulesToSieve([existing]),
    });

    await blockSender('a@b.example', 'Junk');
    const rules = sieveToRules(managed()!.content)!;
    expect(rules.map((r) => r.name)).toEqual(['Block a@b.example', 'Newsletters']);
  });

  it('does nothing the second time', async () => {
    await blockSender('a@b.example', 'Junk');
    const before = managed()!.content;
    expect(await blockSender('A@B.example', 'Junk')).toEqual({ ok: true, already: true });
    expect(managed()!.content).toBe(before);
  });

  it('refuses rather than turn off a script the user wrote elsewhere', async () => {
    server.scripts.push({ id: 's1', name: 'my-rules', is_active: true, content: 'keep;' });
    const result = await blockSender('a@b.example', 'Junk');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toMatch(/"my-rules" is active/);
    expect(server.scripts).toHaveLength(1);
    expect(server.scripts[0].is_active).toBe(true);
  });

  it('refuses to write over a hand-edited managed script', async () => {
    server.scripts.push({
      id: 's1',
      name: MANAGED_SCRIPT_NAME,
      is_active: true,
      content: 'require ["fileinto"];\nif true { fileinto "X"; }',
    });
    const result = await blockSender('a@b.example', 'Junk');
    expect(result.ok).toBe(false);
    expect(managed()!.content).toContain('fileinto "X"');
  });

  it('refuses an address it cannot match safely, and a missing junk folder', async () => {
    expect((await blockSender('not an address', 'Junk')).ok).toBe(false);
    expect((await blockSender('a"@b.example', 'Junk')).ok).toBe(false);
    expect((await blockSender('a@b.example', '')).ok).toBe(false);
    expect(server.scripts).toHaveLength(0);
  });

  it('uses only condition types older app versions already know', async () => {
    // An older version drops conditions it does not recognise when it re-saves
    // the filters, which would silently empty the block rule.
    const { CONDITION_FIELD_LABELS, CONDITION_OP_LABELS } =
      await import('../../src/utils/sieve-rules');
    await blockSender('a@b.example', 'Junk');
    const [rule] = sieveToRules(managed()!.content)!;
    for (const c of rule.conditions) {
      expect(Object.keys(CONDITION_FIELD_LABELS)).toContain(c.field);
      expect(Object.keys(CONDITION_OP_LABELS)).toContain(c.op);
    }
    expect(Object.keys(rule.actions).sort()).toEqual(['fileinto', 'stop']);
  });
});
