import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateDemoMode,
  deactivateDemoMode,
  interceptDemoRequest,
  isDemoBlockedError,
  setDemoToasts,
} from '../../src/utils/demo-mode';
import { Remote } from '../../src/utils/remote';

const writeActions = [
  'Emails',
  'EmailCancel',
  'FolderCreate',
  'FolderUpdate',
  'FolderDelete',
  'MessageCreate',
  'MessageDelete',
  'ContactsCreate',
  'ContactsUpdate',
  'ContactsDelete',
  'CalendarCreate',
  'CalendarUpdate',
  'CalendarDelete',
  'CalendarEventCreate',
  'CalendarEventUpdate',
  'CalendarEventDelete',
  'LabelsCreate',
  'LabelsUpdate',
  'AccountUpdate',
] as const;

describe('friendly demo mutation feedback', () => {
  const show = vi.fn();

  beforeEach(() => {
    show.mockReset();
    setDemoToasts({ show });
    activateDemoMode();
  });

  afterEach(() => {
    deactivateDemoMode();
    setDemoToasts(null);
  });

  it('explains a blocked delete in human terms with a clear account action', () => {
    const intercepted = interceptDemoRequest('MessageDelete');

    expect(intercepted).toEqual({
      handled: true,
      result: { ok: false, demo: true, blocked: true },
    });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(
      'Delete message isn’t available in the demo. Create an account to make changes.',
      'warning',
      expect.objectContaining({
        duration: 12000,
        action: expect.objectContaining({ label: 'Create Account' }),
      }),
    );
    expect(show.mock.calls[0][0]).not.toMatch(/failed/i);
  });

  it.each(writeActions)('blocks %s centrally instead of allowing a fake-auth failure', (action) => {
    const intercepted = interceptDemoRequest(action);

    expect(intercepted.handled).toBe(true);
    expect(intercepted.result).toMatchObject({ demo: true, blocked: true });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatch(/demo/i);
    expect(show.mock.calls[0][0]).not.toMatch(/failed/i);
  });

  it('distinguishes flag changes, ordinary moves, and delete-to-trash intent', () => {
    expect(interceptDemoRequest('MessageUpdate', { id: 'demo-1', flags: ['\\Seen'] })).toEqual({
      handled: true,
      result: { ok: true, demo: true },
    });
    expect(show).not.toHaveBeenCalled();

    expect(interceptDemoRequest('MessageUpdate', { id: 'demo-1', folder: 'Trash' })).toEqual({
      handled: true,
      result: { ok: false, demo: true, blocked: true },
    });
    expect(show).toHaveBeenCalledWith(
      'Move isn’t available in the demo. Create an account to make changes.',
      'warning',
      expect.any(Object),
    );

    show.mockReset();
    expect(
      interceptDemoRequest(
        'MessageUpdate',
        { id: 'demo-1', folder: 'Trash' },
        { demoAction: 'Delete message' },
      ),
    ).toEqual({
      handled: true,
      result: { ok: false, demo: true, blocked: true },
    });
    expect(show).toHaveBeenCalledWith(
      'Delete message isn’t available in the demo. Create an account to make changes.',
      'warning',
      expect.any(Object),
    );
  });

  it('uses a caller-provided action label for shared write endpoints', () => {
    expect(
      interceptDemoRequest(
        'AccountUpdate',
        { settings: { label_settings: {} } },
        { method: 'PUT', demoAction: 'Create label' },
      ),
    ).toEqual({
      handled: true,
      result: { ok: false, demo: true, blocked: true },
    });
    expect(show).toHaveBeenCalledWith(
      'Create label isn’t available in the demo. Create an account to make changes.',
      'warning',
      expect.any(Object),
    );
  });

  it('propagates a stable marked error from Remote.request for UI suppression', async () => {
    await expect(Remote.request('MessageDelete')).rejects.toMatchObject({
      name: 'DemoBlockedError',
      code: 'DEMO_ACTION_BLOCKED',
      isDemo: true,
    });
  });

  it('recognizes both current and legacy blocked-error markers', () => {
    expect(isDemoBlockedError({ code: 'DEMO_ACTION_BLOCKED' })).toBe(true);
    expect(isDemoBlockedError({ isDemo: true })).toBe(true);
    expect(isDemoBlockedError(new Error('network failed'))).toBe(false);
    expect(isDemoBlockedError(null)).toBe(false);
  });
});
