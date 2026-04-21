vi.mock('../../src/utils/platform.js', () => ({
  isTauriMobile: false,
}));

vi.mock('../../src/utils/background-service.js', () => ({
  registerPushToken: vi.fn(),
  unregisterPushToken: vi.fn(),
}));

vi.mock('../../src/utils/unified-push.js', () => ({
  isUnifiedPushAvailable: vi.fn(() => Promise.resolve(false)),
  registerUnifiedPush: vi.fn(() => Promise.resolve(null)),
  unregisterUnifiedPush: vi.fn(() => Promise.resolve()),
  initUnifiedPushListener: vi.fn(() => Promise.resolve()),
  isUnifiedPushRegistered: vi.fn(() => false),
}));

import { handlePushPayload } from '../../src/utils/push-notifications.js';

describe('push notification payload routing', () => {
  it('routes calendar events to the calendar screen with an item hash', () => {
    expect(
      handlePushPayload({
        type: 'calendar-event',
        data: { id: 'event-123' },
      }),
    ).toEqual({ action: 'navigate', path: '/calendar#event=event-123' });
  });

  it('routes calendar tasks to the calendar screen with a task hash', () => {
    expect(
      handlePushPayload({
        type: 'calendar-task',
        uid: 'task-456',
      }),
    ).toEqual({ action: 'navigate', path: '/calendar#task=task-456' });
  });

  it('routes contacts to the contacts screen with an item hash', () => {
    expect(
      handlePushPayload({
        type: 'contact-created',
        data: { contact_id: 'contact-789' },
      }),
    ).toEqual({ action: 'navigate', path: '/contacts#contact=contact-789' });
  });

  it('routes note payloads to the notes hash', () => {
    expect(
      handlePushPayload({
        type: 'note-update',
      }),
    ).toEqual({ action: 'navigate', path: '#notes' });
  });
});
