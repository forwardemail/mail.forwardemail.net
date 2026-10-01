import { afterEach, describe, expect, it, vi } from 'vitest';

// The registry reads the terminal flag once, when it loads, so each case
// loads a fresh copy.
const load = async (terminal: boolean) => {
  vi.resetModules();
  const g = globalThis as { __FORWARDEMAIL_TERMINAL__?: boolean };
  if (terminal) g.__FORWARDEMAIL_TERMINAL__ = true;
  else delete g.__FORWARDEMAIL_TERMINAL__;
  return import('../../src/stores/settingsRegistry');
};

afterEach(() => {
  delete (globalThis as { __FORWARDEMAIL_TERMINAL__?: boolean }).__FORWARDEMAIL_TERMINAL__;
});

describe('plain-text defaults', () => {
  it('stay off in the browser and the apps', async () => {
    const { getSettingDefinition, parseLocalValue } = await load(false);
    for (const id of ['compose_plain_default', 'view_plain_text']) {
      const def = getSettingDefinition(id);
      expect(def?.defaultValue).toBe(false);
      expect(parseLocalValue(def, null)).toBe(false);
    }
  });

  it('are on in the terminal client, and a saved choice still wins', async () => {
    const { getSettingDefinition, parseLocalValue } = await load(true);
    for (const id of ['compose_plain_default', 'view_plain_text']) {
      const def = getSettingDefinition(id);
      expect(def?.defaultValue).toBe(true);
      expect(parseLocalValue(def, null)).toBe(true);
      expect(parseLocalValue(def, 'false')).toBe(false);
    }
  });
});
