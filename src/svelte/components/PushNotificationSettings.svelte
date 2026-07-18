<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Alert from '$lib/components/ui/alert';
  import * as Card from '$lib/components/ui/card';
  import * as Dialog from '$lib/components/ui/dialog';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import Bell from '@lucide/svelte/icons/bell';
  import BellOff from '@lucide/svelte/icons/bell-off';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Wrench from '@lucide/svelte/icons/wrench';
  import {
    deregisterCurrentDevicePush,
    getPushNotificationStatus,
    registerCurrentDevicePush,
    removePushRegistration,
    reregisterCurrentDevicePush,
    selectFcmPushProvider,
    selectUnifiedPushDistributor,
    subscribePushStatus,
  } from '../../utils/push-notifications.js';
  import type {
    PushHealth,
    PushManagementCode,
    PushManagementResult,
    PushNotificationStatus,
    PushRegistrationStatus,
  } from '../../utils/push-notifications.js';

  interface ToastApi {
    show?: (message: string, type?: string) => void;
  }

  interface Props {
    toasts?: ToastApi | null;
    openExternal: (url: string) => Promise<void> | void;
  }

  type Confirmation =
    | { action: 'deregister' }
    | { action: 'remove'; registration: PushRegistrationStatus };

  let { toasts = null, openExternal }: Props = $props();
  let status = $state<PushNotificationStatus | null>(null);
  let loading = $state(true);
  let activeAction = $state('');
  let error = $state('');
  let confirmationOpen = $state(false);
  let confirmation = $state<Confirmation | null>(null);
  let refreshSequence = 0;

  const healthMeta: Record<PushHealth, { label: string; description: string; badgeClass: string }> =
    {
      active: {
        label: 'Active',
        description: 'This device is registered and ready to receive remote mail notifications.',
        badgeClass:
          'border-green-300 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200',
      },
      'not-registered': {
        label: 'Not registered',
        description: 'Register this device to receive remote mail notifications.',
        badgeClass: 'border-border bg-muted text-muted-foreground',
      },
      'needs-repair': {
        label: 'Needs attention',
        description: 'Local and server registration state do not match. Re-register to repair it.',
        badgeClass:
          'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
      },
      'permission-not-granted': {
        label: 'Permission needed',
        description: 'Notification permission is not granted on this device.',
        badgeClass:
          'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
      },
      'needs-distributor': {
        label: 'Distributor needed',
        description: 'Choose a UnifiedPush distributor before registering this device.',
        badgeClass:
          'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
      },
      'server-unavailable': {
        label: 'Status unavailable',
        description:
          'Forward Email could not be reached. Local device state is shown without changing registration.',
        badgeClass:
          'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100',
      },
      unsupported: {
        label: 'Unsupported',
        description: 'Native push notifications are not available on this platform.',
        badgeClass: 'border-border bg-muted text-muted-foreground',
      },
    };

  const permissionLabel = (value: PushNotificationStatus['permission']) => {
    switch (value) {
      case 'granted':
        return 'Allowed';
      case 'not-granted':
        return 'Not allowed';
      case 'unsupported':
        return 'Not applicable';
      default:
        return 'Unknown';
    }
  };

  const formatDate = (value: string | null, fallback = 'Not yet') => {
    if (!value) return fallback;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return fallback;
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  };

  const actionError = (code: PushManagementCode) => {
    switch (code) {
      case 'authentication-required':
        return 'Sign in to an alias before managing push notifications.';
      case 'demo-mode':
        return 'Push notifications are unavailable in demo mode.';
      case 'permission-denied':
        return 'Notification permission was not granted. Enable it in system settings and try again.';
      case 'distributor-required':
        return 'Choose a UnifiedPush distributor before registering.';
      case 'server-unavailable':
        return 'Forward Email could not be reached. Check your connection and try again.';
      case 'registration-timeout':
        return 'The native notification service did not respond. Check system notification settings and try again.';
      case 'deregistration-failed':
        return 'The registration could not be removed completely. Refresh the status and try again.';
      case 'unsupported':
        return 'Native push notifications are not supported on this platform.';
      default:
        return 'Push registration did not complete. Refresh the status and try again.';
    }
  };

  const refreshStatus = async (showLoading = true) => {
    const sequence = ++refreshSequence;
    if (showLoading) loading = true;
    try {
      const next = await getPushNotificationStatus();
      if (sequence !== refreshSequence) return;
      status = next;
      error = '';
    } catch (err) {
      if (sequence !== refreshSequence) return;
      error = err instanceof Error ? err.message : 'Unable to load push notification status.';
    } finally {
      if (sequence === refreshSequence) loading = false;
    }
  };

  const applyResult = (result: PushManagementResult, successMessage: string) => {
    status = result.status;
    if (result.ok) {
      error = '';
      toasts?.show?.(successMessage, 'success');
      return;
    }

    error = actionError(result.code);
    toasts?.show?.(error, 'error');
  };

  const runAction = async (name: string, operation: () => Promise<void>) => {
    if (activeAction) return;
    activeAction = name;
    error = '';
    try {
      await operation();
    } catch (err) {
      error = err instanceof Error ? err.message : 'Push notification action failed.';
      toasts?.show?.(error, 'error');
    } finally {
      activeAction = '';
    }
  };

  const registerDevice = () =>
    runAction('register', async () => {
      applyResult(
        await registerCurrentDevicePush(),
        'Push notifications registered for this device.',
      );
    });

  const reregisterDevice = () =>
    runAction('reregister', async () => {
      applyResult(
        await reregisterCurrentDevicePush(),
        'Push notification registration refreshed for this device.',
      );
    });

  const requestDeregister = () => {
    confirmation = { action: 'deregister' };
    confirmationOpen = true;
  };

  const requestRemove = (registration: PushRegistrationStatus) => {
    confirmation = { action: 'remove', registration };
    confirmationOpen = true;
  };

  const confirmDestructiveAction = async () => {
    const pending = confirmation;
    confirmationOpen = false;
    confirmation = null;
    if (!pending) return;

    if (pending.action === 'deregister') {
      await runAction('deregister', async () => {
        applyResult(
          await deregisterCurrentDevicePush(),
          'Push notifications deregistered for this device.',
        );
      });
      return;
    }

    await runAction(`remove:${pending.registration.id}`, async () => {
      applyResult(
        await removePushRegistration(pending.registration.id),
        'The selected push registration was removed.',
      );
    });
  };

  const chooseUnifiedPush = () =>
    runAction('provider', async () => {
      if (!(await selectUnifiedPushDistributor())) {
        throw new Error('No UnifiedPush distributor could be selected.');
      }
      applyResult(
        await registerCurrentDevicePush(),
        'UnifiedPush selected and registered for this device.',
      );
    });

  const chooseFcm = () =>
    runAction('provider', async () => {
      if (!(await selectFcmPushProvider())) {
        throw new Error('Firebase Cloud Messaging could not be initialized.');
      }
      const next = await getPushNotificationStatus();
      status = next;
      if (next.health !== 'active') {
        error = actionError(
          next.health === 'server-unavailable' ? 'server-unavailable' : 'registration-failed',
        );
        toasts?.show?.(error, 'error');
        return;
      }
      toasts?.show?.('Firebase Cloud Messaging selected for this device.', 'success');
    });

  const openDistributorDirectory = async () => {
    try {
      await openExternal('https://unifiedpush.org/users/distributors/');
    } catch (err) {
      error = err instanceof Error ? err.message : 'Unable to open the distributor directory.';
    }
  };

  const canManage = () => Boolean(status?.supported && status.authenticated && !status.demo);

  const hasCurrentDeviceState = () =>
    Boolean(status?.currentRegistration || status?.localTokenPresent || status?.initialized);

  const canChooseUnifiedPush = () =>
    status?.platform === 'android' &&
    status.androidProviderMode !== 'fcm' &&
    status.unifiedPush !== null;

  const canChooseFcm = () =>
    status?.platform === 'android' && status.androidProviderMode !== 'unified-push';

  onMount(() => {
    void refreshStatus();
    return subscribePushStatus(() => {
      if (!activeAction) void refreshStatus(false);
    });
  });
</script>

<Card.Root aria-busy={loading || Boolean(activeAction)}>
  <Card.Header>
    <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="space-y-1.5">
        <Card.Title class="flex items-center gap-2">
          <Bell class="h-5 w-5" />
          Push notifications
        </Card.Title>
        <Card.Description>
          Manage remote mail notifications for this device. Registration details are
          device-specific.
        </Card.Description>
      </div>
      {#if status}
        <span
          class={`inline-flex w-fit items-center rounded-full border px-2.5 py-1 text-xs font-medium ${healthMeta[status.health].badgeClass}`}
          data-testid="push-health-badge"
        >
          {healthMeta[status.health].label}
        </span>
      {/if}
    </div>
  </Card.Header>

  <Card.Content class="space-y-5">
    <div class="min-h-5 text-sm text-muted-foreground" aria-live="polite">
      {#if loading && !status}
        Checking push notification status…
      {:else if activeAction}
        Updating push notification registration…
      {:else if status}
        {healthMeta[status.health].description}
      {/if}
    </div>

    {#if error}
      <Alert.Root variant="destructive">
        <AlertCircle class="h-4 w-4" />
        <Alert.Description>{error}</Alert.Description>
      </Alert.Root>
    {/if}

    {#if status}
      {#if !status.supported}
        <Alert.Root>
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>
            Push notification controls are available only in the native Android and iOS apps.
          </Alert.Description>
        </Alert.Root>
      {:else if !status.authenticated}
        <Alert.Root>
          <AlertCircle class="h-4 w-4" />
          <Alert.Description
            >Sign in to an alias before managing push notifications.</Alert.Description
          >
        </Alert.Root>
      {:else if status.demo}
        <Alert.Root>
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>
            Push notification registration is disabled in demo mode and no token is sent to the
            server.
          </Alert.Description>
        </Alert.Root>
      {:else if status.permission === 'not-granted'}
        <Alert.Root>
          <BellOff class="h-4 w-4" />
          <Alert.Description>
            {#if status.provider === 'unified-push'}
              UnifiedPush can keep data synchronized, but Android may not display notifications
              until notification permission is enabled in system settings.
            {:else}
              Registration will request notification permission. If it remains denied, enable it in
              system settings and try again.
            {/if}
          </Alert.Description>
        </Alert.Root>
      {/if}

      <dl class="grid gap-3 text-sm sm:grid-cols-2" data-testid="push-status-summary">
        <div class="rounded-md border p-3">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Platform
          </dt>
          <dd class="mt-1 flex items-center gap-2 font-medium">
            <Smartphone class="h-4 w-4 text-muted-foreground" />
            {status.platform === 'ios'
              ? 'iOS'
              : status.platform === 'android'
                ? 'Android'
                : 'Unsupported'}
          </dd>
        </div>
        <div class="rounded-md border p-3">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Provider
          </dt>
          <dd class="mt-1 font-medium">{status.providerLabel || 'Not selected'}</dd>
        </div>
        <div class="rounded-md border p-3">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Notification permission
          </dt>
          <dd class="mt-1 font-medium">{permissionLabel(status.permission)}</dd>
        </div>
        <div class="rounded-md border p-3">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Current device
          </dt>
          <dd class="mt-1 font-medium">
            {status.currentRegistration
              ? 'Registered with Forward Email'
              : 'Not confirmed on server'}
          </dd>
        </div>
        <div class="rounded-md border p-3">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Token fingerprint
          </dt>
          <dd class="mt-1 font-mono font-medium" data-testid="push-token-fingerprint">
            {status.currentRegistration?.tokenFingerprint ||
              status.localTokenFingerprint ||
              'Not available'}
          </dd>
        </div>
        <div class="rounded-md border p-3">
          <dt class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Last server activity
          </dt>
          <dd class="mt-1 font-medium">
            {formatDate(status.currentRegistration?.lastUsedAt || null, 'Not delivered yet')}
          </dd>
        </div>
      </dl>

      {#if status.currentRegistration && status.currentRegistration.failureCount > 0}
        <p class="text-xs text-muted-foreground">
          Recent delivery failures: {status.currentRegistration.failureCount}. Forward Email removes
          a registration after repeated failures.
        </p>
      {/if}

      <div class="flex flex-wrap gap-2" aria-label="Push notification controls">
        {#if canManage() && !hasCurrentDeviceState() && status.health !== 'needs-distributor'}
          <Button onclick={registerDevice} disabled={Boolean(activeAction)}>
            <Bell class="mr-2 h-4 w-4" />
            {status.permission === 'not-granted'
              ? 'Allow & register this device'
              : 'Register this device'}
          </Button>
        {:else if canManage() && hasCurrentDeviceState()}
          <Button onclick={reregisterDevice} disabled={Boolean(activeAction)}>
            <Wrench class="mr-2 h-4 w-4" />
            {status.health === 'needs-repair' ? 'Repair registration' : 'Re-register'}
          </Button>
          <Button
            variant="destructive"
            onclick={requestDeregister}
            disabled={Boolean(activeAction)}
          >
            <BellOff class="mr-2 h-4 w-4" />
            Deregister this device
          </Button>
        {/if}
        <Button
          variant="outline"
          onclick={() => refreshStatus()}
          disabled={loading || Boolean(activeAction)}
        >
          <RefreshCw class={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh status
        </Button>
      </div>

      {#if status.platform === 'android'}
        <div class="space-y-3 rounded-md border p-4" data-testid="android-push-provider-controls">
          <div>
            <h3 class="text-sm font-semibold">Android delivery provider</h3>
            <p class="mt-1 text-xs text-muted-foreground">
              {#if status.androidProviderMode === 'auto'}
                This build supports Firebase Cloud Messaging and UnifiedPush.
              {:else if status.androidProviderMode === 'unified-push'}
                This privacy-focused build uses UnifiedPush.
              {:else}
                This build uses Firebase Cloud Messaging.
              {/if}
            </p>
          </div>

          {#if canChooseUnifiedPush() && status.provider === 'unified-push'}
            <dl class="grid gap-2 text-sm sm:grid-cols-2">
              <div>
                <dt class="text-muted-foreground">Distributor</dt>
                <dd class="font-medium">{status.unifiedPush?.distributor || 'None selected'}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Compatible apps</dt>
                <dd class="font-medium">
                  {status.unifiedPush?.availableDistributors?.length || 0} installed
                </dd>
              </div>
              <div>
                <dt class="text-muted-foreground">Local subscription</dt>
                <dd class="font-medium">
                  {status.unifiedPush?.subscription ? 'Available' : 'Not available'}
                </dd>
              </div>
            </dl>
          {/if}

          <div class="flex flex-wrap gap-2">
            {#if canChooseUnifiedPush()}
              <Button
                variant="outline"
                onclick={chooseUnifiedPush}
                disabled={!canManage() || Boolean(activeAction)}
              >
                {status.provider === 'unified-push'
                  ? 'Choose UnifiedPush distributor'
                  : 'Use UnifiedPush'}
              </Button>
              <Button
                variant="ghost"
                onclick={openDistributorDirectory}
                disabled={Boolean(activeAction)}
              >
                <ExternalLink class="mr-2 h-4 w-4" />
                Find a distributor
              </Button>
            {/if}
            {#if canChooseFcm() && status.provider !== 'fcm'}
              <Button
                variant="outline"
                onclick={chooseFcm}
                disabled={!canManage() || Boolean(activeAction)}
              >
                Use Firebase Cloud Messaging
              </Button>
            {/if}
          </div>
        </div>
      {/if}

      {#if status.otherRegistrations.length > 0}
        <details class="rounded-md border" data-testid="other-push-registrations">
          <summary class="cursor-pointer px-4 py-3 text-sm font-medium">
            Other registrations ({status.otherRegistrations.length})
          </summary>
          <div class="space-y-3 border-t p-4">
            <p class="text-xs text-muted-foreground">
              These registrations belong to this alias on another or previously used device. Remove
              only entries you recognize as stale.
            </p>
            {#each status.otherRegistrations as registration (registration.id)}
              <div
                class="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div class="min-w-0 text-sm">
                  <div class="font-medium">
                    {registration.deviceName || 'Unnamed device'} · {registration.providerLabel}
                  </div>
                  <div class="mt-1 break-words text-xs text-muted-foreground">
                    Fingerprint
                    <span class="font-mono">{registration.tokenFingerprint || 'Unavailable'}</span>
                    · Last activity {formatDate(registration.lastUsedAt)} · Failures {registration.failureCount}
                  </div>
                  {#if registration.expiresAt}
                    <div class="mt-1 text-xs text-muted-foreground">
                      Expires {formatDate(registration.expiresAt)}
                    </div>
                  {/if}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onclick={() => requestRemove(registration)}
                  disabled={Boolean(activeAction)}
                  aria-label={`Remove push registration for ${registration.deviceName || registration.providerLabel}`}
                >
                  <Trash2 class="mr-2 h-4 w-4" />
                  Remove
                </Button>
              </div>
            {/each}
          </div>
        </details>
      {/if}

      <p class="text-xs text-muted-foreground">
        For security, full push tokens are never displayed. The short fingerprint identifies a token
        without exposing the credential.
      </p>
    {/if}
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={confirmationOpen}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>
        {confirmation?.action === 'deregister'
          ? 'Deregister this device?'
          : 'Remove this push registration?'}
      </Dialog.Title>
      <Dialog.Description>
        {#if confirmation?.action === 'deregister'}
          This device will stop receiving remote mail notifications until you register it again.
        {:else}
          {confirmation?.registration.deviceName || 'This device'} will stop receiving remote mail notifications
          for this alias. This does not sign out or delete mail.
        {/if}
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button
        variant="ghost"
        onclick={() => {
          confirmationOpen = false;
          confirmation = null;
        }}>Cancel</Button
      >
      <Button variant="destructive" onclick={confirmDestructiveAction}>
        {confirmation?.action === 'deregister' ? 'Deregister device' : 'Remove registration'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
