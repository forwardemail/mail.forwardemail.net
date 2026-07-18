import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import type {
  PushNotificationStatus,
  PushRegistrationStatus,
} from '../../src/utils/push-notifications.js';

const push = vi.hoisted(() => ({
  deregister: vi.fn(),
  getStatus: vi.fn(),
  listener: null as (() => void) | null,
  register: vi.fn(),
  remove: vi.fn(),
  reregister: vi.fn(),
  selectFcm: vi.fn(),
  selectUnifiedPush: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../../src/utils/push-notifications.js', () => ({
  deregisterCurrentDevicePush: (...args: unknown[]) => push.deregister(...args),
  getPushNotificationStatus: (...args: unknown[]) => push.getStatus(...args),
  registerCurrentDevicePush: (...args: unknown[]) => push.register(...args),
  removePushRegistration: (...args: unknown[]) => push.remove(...args),
  reregisterCurrentDevicePush: (...args: unknown[]) => push.reregister(...args),
  selectFcmPushProvider: (...args: unknown[]) => push.selectFcm(...args),
  selectUnifiedPushDistributor: (...args: unknown[]) => push.selectUnifiedPush(...args),
  subscribePushStatus: (...args: unknown[]) => push.subscribe(...args),
}));

import PushNotificationSettings from '../../src/svelte/components/PushNotificationSettings.svelte';

const currentRegistration = (
  overrides: Partial<PushRegistrationStatus> = {},
): PushRegistrationStatus => ({
  id: 'registration-current',
  platform: 'apns',
  providerLabel: 'Apple Push Notification service',
  deviceName: 'iPhone 15',
  tokenFingerprint: '8f2a1c0d',
  lastUsedAt: '2026-07-17T20:00:00.000Z',
  failureCount: 0,
  expiresAt: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-17T20:00:00.000Z',
  isCurrentDevice: true,
  ...overrides,
});

const makeStatus = (overrides: Partial<PushNotificationStatus> = {}): PushNotificationStatus => ({
  supported: true,
  authenticated: true,
  demo: false,
  platform: 'ios',
  provider: 'apns',
  providerLabel: 'Apple Push Notification service',
  androidProviderMode: null,
  providerPreference: null,
  permission: 'granted',
  initialized: true,
  localTokenPresent: true,
  localTokenFingerprint: '8f2a1c0d',
  serverReachable: true,
  currentRegistration: currentRegistration(),
  otherRegistrations: [],
  unifiedPush: null,
  health: 'active',
  ...overrides,
});

const successfulResult = (
  code: 'registered' | 'reregistered' | 'deregistered' | 'removed',
  status: PushNotificationStatus,
) => ({
  ok: true as const,
  code,
  status,
});

beforeEach(() => {
  vi.clearAllMocks();
  push.listener = null;
  push.subscribe.mockImplementation((listener: () => void) => {
    push.listener = listener;
    return push.unsubscribe;
  });
  push.getStatus.mockResolvedValue(makeStatus());
  push.selectFcm.mockResolvedValue(true);
  push.selectUnifiedPush.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

describe('<PushNotificationSettings />', () => {
  it('shows privacy-safe iOS APNS status and re-registration controls', async () => {
    const toasts = { show: vi.fn() };
    const repaired = makeStatus({
      currentRegistration: currentRegistration({ updatedAt: '2026-07-18T12:00:00.000Z' }),
    });
    push.reregister.mockResolvedValue(successfulResult('reregistered', repaired));

    render(PushNotificationSettings, {
      props: { toasts, openExternal: vi.fn() },
    });

    expect(await screen.findByText('Active')).toBeInTheDocument();
    expect(screen.getByText('iOS')).toBeInTheDocument();
    expect(screen.getByText('Apple Push Notification service')).toBeInTheDocument();
    expect(screen.getByTestId('push-token-fingerprint')).toHaveTextContent('8f2a1c0d');
    expect(screen.queryByTestId('android-push-provider-controls')).toBeNull();
    expect(screen.queryByText(/raw push token/i)).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Re-register' }));

    await waitFor(() => expect(push.reregister).toHaveBeenCalledTimes(1));
    expect(toasts.show).toHaveBeenCalledWith(
      'Push notification registration refreshed for this device.',
      'success',
    );
  });

  it('requests registration from a permission-aware iOS empty state', async () => {
    const empty = makeStatus({
      providerLabel: 'Apple Push Notification service',
      permission: 'not-granted',
      initialized: false,
      localTokenPresent: false,
      localTokenFingerprint: null,
      currentRegistration: null,
      health: 'permission-not-granted',
    });
    const active = makeStatus();
    push.getStatus.mockResolvedValue(empty);
    push.register.mockResolvedValue(successfulResult('registered', active));

    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    expect(await screen.findByText('Permission needed')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Allow & register this device' }));

    await waitFor(() => expect(push.register).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('restores the registration control after a native-service timeout', async () => {
    const toasts = { show: vi.fn() };
    const permissionNeeded = makeStatus({
      platform: 'android',
      provider: 'fcm',
      providerLabel: 'Firebase Cloud Messaging',
      androidProviderMode: 'auto',
      providerPreference: 'fcm',
      permission: 'not-granted',
      initialized: false,
      localTokenPresent: false,
      localTokenFingerprint: null,
      currentRegistration: null,
      health: 'permission-not-granted',
    });
    push.getStatus.mockResolvedValue(permissionNeeded);
    push.register.mockResolvedValue({
      ok: false,
      code: 'registration-timeout',
      status: permissionNeeded,
    });

    render(PushNotificationSettings, {
      props: { toasts, openExternal: vi.fn() },
    });

    const button = await screen.findByRole('button', {
      name: 'Allow & register this device',
    });
    await fireEvent.click(button);

    const message =
      'The native notification service did not respond. Check system notification settings and try again.';
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow & register this device' })).toBeEnabled();
    expect(toasts.show).toHaveBeenCalledWith(message, 'error');
  });

  it('supports Android FCM and switches to an installed UnifiedPush distributor', async () => {
    const fcm = makeStatus({
      platform: 'android',
      provider: 'fcm',
      providerLabel: 'Firebase Cloud Messaging',
      androidProviderMode: 'auto',
      providerPreference: 'fcm',
      currentRegistration: currentRegistration({
        platform: 'fcm',
        providerLabel: 'Firebase Cloud Messaging',
        deviceName: 'Pixel 9',
      }),
      unifiedPush: {
        availableDistributors: ['org.unifiedpush.distributor.nextpush'],
        distributor: null,
        selectionRequired: false,
        instance: null,
        subscription: null,
      },
    });
    const unified = makeStatus({
      platform: 'android',
      provider: 'unified-push',
      providerLabel: 'UnifiedPush',
      androidProviderMode: 'auto',
      providerPreference: 'unified-push',
      currentRegistration: currentRegistration({
        platform: 'unified-push',
        providerLabel: 'UnifiedPush',
        deviceName: 'Pixel 9',
      }),
      unifiedPush: {
        availableDistributors: ['org.unifiedpush.distributor.nextpush'],
        distributor: 'org.unifiedpush.distributor.nextpush',
        selectionRequired: false,
        instance: 'forwardemail-webmail',
        subscription: {
          endpoint: 'https://push.example.test/endpoint',
          p256dh: 'public-key',
          auth: 'auth-secret',
        },
      },
    });
    push.getStatus.mockResolvedValue(fcm);
    push.register.mockResolvedValue(successfulResult('registered', unified));

    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    expect(await screen.findByText('Android')).toBeInTheDocument();
    expect(screen.getByText('Firebase Cloud Messaging')).toBeInTheDocument();
    expect(screen.getByTestId('android-push-provider-controls')).toHaveTextContent(
      'supports Firebase Cloud Messaging and UnifiedPush',
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Use UnifiedPush' }));

    await waitFor(() => expect(push.selectUnifiedPush).toHaveBeenCalledTimes(1));
    expect(push.register).toHaveBeenCalledTimes(1);
    expect(screen.getByText('UnifiedPush')).toBeInTheDocument();
  });

  it('switches an auto-provider Android build from UnifiedPush back to FCM', async () => {
    const unified = makeStatus({
      platform: 'android',
      provider: 'unified-push',
      providerLabel: 'UnifiedPush',
      androidProviderMode: 'auto',
      providerPreference: 'unified-push',
      currentRegistration: currentRegistration({
        platform: 'unified-push',
        providerLabel: 'UnifiedPush',
        deviceName: 'Pixel 9',
      }),
      unifiedPush: {
        availableDistributors: ['org.unifiedpush.distributor.nextpush'],
        distributor: 'org.unifiedpush.distributor.nextpush',
        selectionRequired: false,
        instance: 'forwardemail-webmail',
        subscription: {
          endpoint: 'https://push.example.test/endpoint',
          p256dh: 'public-key',
          auth: 'auth-secret',
        },
      },
    });
    const fcm = makeStatus({
      platform: 'android',
      provider: 'fcm',
      providerLabel: 'Firebase Cloud Messaging',
      androidProviderMode: 'auto',
      providerPreference: 'fcm',
      currentRegistration: currentRegistration({
        platform: 'fcm',
        providerLabel: 'Firebase Cloud Messaging',
        deviceName: 'Pixel 9',
      }),
      unifiedPush: {
        availableDistributors: ['org.unifiedpush.distributor.nextpush'],
        distributor: null,
        selectionRequired: false,
        instance: null,
        subscription: null,
      },
    });
    push.getStatus.mockResolvedValueOnce(unified).mockResolvedValueOnce(fcm);

    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    expect(await screen.findByText('UnifiedPush')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Use Firebase Cloud Messaging' }));

    await waitFor(() => expect(push.selectFcm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Firebase Cloud Messaging')).toBeInTheDocument());
    expect(push.getStatus).toHaveBeenCalledTimes(2);
  });

  it('guides Android UnifiedPush users to select or install a distributor', async () => {
    const openExternal = vi.fn();
    push.getStatus.mockResolvedValue(
      makeStatus({
        platform: 'android',
        provider: 'unified-push',
        providerLabel: 'UnifiedPush',
        androidProviderMode: 'unified-push',
        providerPreference: 'unified-push',
        permission: 'granted',
        initialized: false,
        localTokenPresent: false,
        localTokenFingerprint: null,
        currentRegistration: null,
        unifiedPush: {
          availableDistributors: [],
          distributor: null,
          selectionRequired: true,
          instance: null,
          subscription: null,
        },
        health: 'needs-distributor',
      }),
    );
    push.selectUnifiedPush.mockResolvedValue(false);

    render(PushNotificationSettings, {
      props: { openExternal },
    });

    expect(await screen.findByText('Distributor needed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register this device' })).toBeNull();

    await fireEvent.click(screen.getByRole('button', { name: 'Find a distributor' }));
    expect(openExternal).toHaveBeenCalledWith('https://unifiedpush.org/users/distributors/');
  });

  it('confirms deregistration and updates to the returned empty state', async () => {
    const empty = makeStatus({
      initialized: false,
      localTokenPresent: false,
      localTokenFingerprint: null,
      currentRegistration: null,
      health: 'not-registered',
    });
    push.deregister.mockResolvedValue(successfulResult('deregistered', empty));

    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    await screen.findByText('Active');
    await fireEvent.click(screen.getByRole('button', { name: 'Deregister this device' }));

    expect(screen.getByText('Deregister this device?')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Deregister device' }));

    await waitFor(() => expect(push.deregister).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Not registered')).toBeInTheDocument();
  });

  it('lists and removes a stale registration without exposing its raw token', async () => {
    const stale = currentRegistration({
      id: 'registration-stale',
      platform: 'fcm',
      providerLabel: 'Firebase Cloud Messaging',
      deviceName: 'Old Android phone',
      tokenFingerprint: '91dd447a',
      isCurrentDevice: false,
    });
    const initial = makeStatus({ otherRegistrations: [stale] });
    const removed = makeStatus({ otherRegistrations: [] });
    push.getStatus.mockResolvedValue(initial);
    push.remove.mockResolvedValue(successfulResult('removed', removed));

    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    await fireEvent.click(await screen.findByText('Other registrations (1)'));
    expect(screen.getByText('91dd447a')).toBeInTheDocument();
    expect(screen.queryByText('super-secret-fcm-token')).toBeNull();

    await fireEvent.click(
      screen.getByRole('button', { name: 'Remove push registration for Old Android phone' }),
    );
    expect(screen.getByText('Remove this push registration?')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Remove registration' }));

    await waitFor(() => expect(push.remove).toHaveBeenCalledWith('registration-stale'));
    expect(screen.queryByText('Other registrations (1)')).toBeNull();
  });

  it('refreshes when lifecycle registration state changes', async () => {
    const inactive = makeStatus({
      initialized: false,
      localTokenPresent: false,
      localTokenFingerprint: null,
      currentRegistration: null,
      health: 'not-registered',
    });
    push.getStatus.mockResolvedValueOnce(inactive).mockResolvedValueOnce(makeStatus());

    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    expect(await screen.findByText('Not registered')).toBeInTheDocument();
    expect(push.listener).toBeTypeOf('function');
    push.listener?.();

    await waitFor(() => expect(screen.getByText('Active')).toBeInTheDocument());
    expect(push.getStatus).toHaveBeenCalledTimes(2);
  });

  it('explains unsupported, unauthenticated, and demo states without offering mutations', async () => {
    push.getStatus.mockResolvedValue(
      makeStatus({
        supported: false,
        authenticated: false,
        platform: null,
        provider: null,
        providerLabel: '',
        androidProviderMode: null,
        permission: 'unsupported',
        initialized: false,
        localTokenPresent: false,
        localTokenFingerprint: null,
        serverReachable: false,
        currentRegistration: null,
        health: 'unsupported',
      }),
    );

    const { unmount } = render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });

    await waitFor(() =>
      expect(screen.getByTestId('push-health-badge')).toHaveTextContent('Unsupported'),
    );
    expect(
      screen.getByText(/available only in the native Android and iOS apps/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register this device/i })).toBeNull();
    unmount();

    push.getStatus.mockResolvedValue(
      makeStatus({
        authenticated: false,
        initialized: false,
        localTokenPresent: false,
        localTokenFingerprint: null,
        currentRegistration: null,
        health: 'not-registered',
      }),
    );
    const unauthenticated = render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });
    expect(
      await screen.findByText('Sign in to an alias before managing push notifications.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register this device/i })).toBeNull();
    unauthenticated.unmount();

    push.getStatus.mockResolvedValue(
      makeStatus({
        demo: true,
        initialized: false,
        localTokenPresent: false,
        localTokenFingerprint: null,
        currentRegistration: null,
        health: 'not-registered',
      }),
    );
    render(PushNotificationSettings, {
      props: { openExternal: vi.fn() },
    });
    expect(await screen.findByText(/registration is disabled in demo mode/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /register this device/i })).toBeNull();
  });
});
