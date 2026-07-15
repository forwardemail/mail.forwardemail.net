/**
 * Push Notifications – Safety & Platform Guard Tests
 *
 * Verifies that native remote-push initialization:
 *   - Is a no-op on non-mobile platforms
 *   - Is idempotent
 *   - Does not require callers to pass credentials
 *   - Deletes the exact persisted server registration on cleanup
 *   - Handles malformed notification payloads safely
 */

const { localStorageState, localGet, localSet, localRemove } = vi.hoisted(() => {
  const state = new Map();
  return {
    localStorageState: state,
    localGet: vi.fn((key) => state.get(key) ?? null),
    localSet: vi.fn((key, value) => state.set(key, value)),
    localRemove: vi.fn((key) => state.delete(key)),
  };
});

vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: false,
}));

vi.mock('../../src/utils/background-service.js', () => ({
  registerPushToken: vi.fn(() => Promise.resolve('registration-id')),
  unregisterPushToken: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: localGet,
    set: localSet,
    remove: localRemove,
  },
}));

import {
  initPushNotifications,
  cleanupPushNotifications,
  isPushInitialized,
  handlePushPayload,
} from '../../src/utils/push-notifications.js';
import { registerPushToken, unregisterPushToken } from '../../src/utils/background-service.js';

const REGISTRATION_ID_STORAGE_KEY = 'push_notification_registration_id';
const TOKEN_STORAGE_KEY = 'push_notification_token';
const TOKEN_PLATFORM_KEY = 'push_notification_platform';

describe('push-notifications safety guards', () => {
  beforeEach(async () => {
    localStorageState.clear();
    vi.clearAllMocks();
    await cleanupPushNotifications();
    vi.clearAllMocks();
  });

  describe('platform guards (isTauriMobile = false)', () => {
    it('returns false on non-mobile platforms (desktop/web)', async () => {
      const result = await initPushNotifications();
      expect(result).toBe(false);
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('does not need caller-supplied credentials', async () => {
      const result = await initPushNotifications();
      expect(result).toBe(false);
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('ignores obsolete caller options safely', async () => {
      const result = await initPushNotifications({ authToken: 'legacy-token' });
      expect(result).toBe(false);
      expect(registerPushToken).not.toHaveBeenCalled();
    });

    it('does not throw when called multiple times', async () => {
      const result1 = await initPushNotifications();
      const result2 = await initPushNotifications();
      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('deletes the persisted server registration ID', async () => {
      localStorageState.set(REGISTRATION_ID_STORAGE_KEY, 'registration-123');

      await cleanupPushNotifications();

      expect(unregisterPushToken).toHaveBeenCalledWith('registration-123');
      expect(localRemove).toHaveBeenCalledWith(TOKEN_STORAGE_KEY);
      expect(localRemove).toHaveBeenCalledWith(TOKEN_PLATFORM_KEY);
      expect(localRemove).toHaveBeenCalledWith(REGISTRATION_ID_STORAGE_KEY);
    });

    it('does not call unregister without a persisted registration ID', async () => {
      await cleanupPushNotifications();
      expect(unregisterPushToken).not.toHaveBeenCalled();
    });

    it('resets initialized state on cleanup', async () => {
      await cleanupPushNotifications();
      expect(isPushInitialized()).toBe(false);
    });

    it('is safe to call cleanup multiple times', async () => {
      localStorageState.set(REGISTRATION_ID_STORAGE_KEY, 'registration-123');

      await cleanupPushNotifications();
      await cleanupPushNotifications();

      expect(unregisterPushToken).toHaveBeenCalledTimes(1);
      expect(isPushInitialized()).toBe(false);
    });
  });

  describe('handlePushPayload validation', () => {
    it('returns null for null payload', () => {
      expect(handlePushPayload(null)).toBeNull();
    });

    it('returns null for non-object payload', () => {
      expect(handlePushPayload('string')).toBeNull();
      expect(handlePushPayload(42)).toBeNull();
      expect(handlePushPayload(undefined)).toBeNull();
    });

    it('returns null for payload without type', () => {
      expect(handlePushPayload({ data: { foo: 'bar' } })).toBeNull();
    });

    it('returns null for unknown type', () => {
      expect(handlePushPayload({ type: 'unknown-event' })).toBeNull();
    });

    it('routes new-message with uid to inbox', () => {
      const result = handlePushPayload({ type: 'new-message', uid: '12345' });
      expect(result).toEqual({ action: 'navigate', path: '#INBOX/12345' });
    });

    it('routes new-message without uid to INBOX', () => {
      const result = handlePushPayload({ type: 'new-message' });
      expect(result).toEqual({ action: 'navigate', path: '#INBOX' });
    });

    it('routes new-message with custom mailbox', () => {
      const result = handlePushPayload({
        type: 'new-message',
        uid: '99',
        mailbox: 'Archive',
      });
      expect(result).toEqual({ action: 'navigate', path: '#Archive/99' });
    });

    it('routes calendar-event with id', () => {
      const result = handlePushPayload({
        type: 'calendar-event',
        data: { id: 'evt-1' },
      });
      expect(result).toEqual({ action: 'navigate', path: '/calendar#event=evt-1' });
    });

    it('routes calendar-task with uid', () => {
      const result = handlePushPayload({
        type: 'calendar-task',
        uid: 'task-1',
      });
      expect(result).toEqual({ action: 'navigate', path: '/calendar#task=task-1' });
    });

    it('routes contact-created with id', () => {
      const result = handlePushPayload({
        type: 'contact-created',
        data: { contact_id: 'c-1' },
      });
      expect(result).toEqual({ action: 'navigate', path: '/contacts#contact=c-1' });
    });

    it('routes note-update', () => {
      const result = handlePushPayload({ type: 'note-update' });
      expect(result).toEqual({ action: 'navigate', path: '#notes' });
    });

    it('encodes untrusted payload fields before navigation', () => {
      const result = handlePushPayload({
        type: 'calendar-event',
        data: { id: '<script>alert(1)</script>' },
      });
      expect(result).toEqual({
        action: 'navigate',
        path: '/calendar#event=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
      });
    });
  });
});
