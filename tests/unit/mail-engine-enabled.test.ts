/**
 * The app asks the engine whether this build has custom servers switched on.
 * Anything short of a plain yes counts as no, so an older engine or a failed
 * call never leads to the sign-in form being offered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/platform.js', () => ({ isTauriDesktop: true }));

import {
  MailEngineError,
  mailEngineEnabled,
  setMailEngineForTests,
} from '../../src/backends/engine-bridge';

afterEach(() => setMailEngineForTests(null));

describe('mailEngineEnabled', () => {
  it('is yes only when the engine says so', async () => {
    setMailEngineForTests(async (cmd) => (cmd === 'mail_enabled' ? true : null));
    expect(await mailEngineEnabled()).toBe(true);
  });

  it('is no for a release build, which answers false', async () => {
    setMailEngineForTests(async () => false);
    expect(await mailEngineEnabled()).toBe(false);
  });

  it('is no when the engine does not know the command', async () => {
    setMailEngineForTests(async () => {
      throw new MailEngineError('engine', 'Command mail_enabled not found');
    });
    expect(await mailEngineEnabled()).toBe(false);
  });

  it('asks once and answers again after the engine is swapped', async () => {
    let asked = 0;
    setMailEngineForTests(async () => {
      asked += 1;
      return true;
    });
    await mailEngineEnabled();
    await mailEngineEnabled();
    expect(asked).toBe(1);

    setMailEngineForTests(async () => false);
    expect(await mailEngineEnabled()).toBe(false);
  });
});
