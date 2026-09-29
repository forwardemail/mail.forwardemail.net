<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import Bell from '@lucide/svelte/icons/bell';
  import BellRing from '@lucide/svelte/icons/bell-ring';
  import {
    getNotificationPermissionState,
    requestNotificationPermission,
    showTestNotification,
  } from '../../utils/notification-manager.js';

  import type {
    NotificationPermissionState,
    NotificationToastHost,
  } from '../../utils/notification-manager.js';

  // isTauri comes from the parent, which already reads platform.js.
  let { toasts, isTauri = false }: { toasts?: NotificationToastHost | null; isTauri?: boolean } =
    $props();

  let permission = $state<NotificationPermissionState | 'loading'>('loading');
  let busy = $state(false);

  const refresh = async () => {
    permission = await getNotificationPermissionState();
  };

  onMount(() => {
    refresh();
    // The user may change it in the browser or system settings meanwhile.
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  // Called straight from the click: browsers only show the prompt for a
  // request that a user action started.
  const allow = async () => {
    busy = true;
    try {
      const granted = await requestNotificationPermission();
      await refresh();
      toasts?.show?.(
        granted
          ? 'Notifications are on.'
          : isTauri
            ? 'Notifications are off. Allow Forward Email in your system notification settings.'
            : 'Notifications are off. Allow them for this site in your browser settings.',
        granted ? 'success' : 'info',
      );
    } finally {
      busy = false;
    }
  };

  const test = async () => {
    busy = true;
    try {
      const shown = await showTestNotification();
      if (!shown) {
        toasts?.show?.(
          'No notification could be shown. Check the notification settings for Forward Email.',
          'error',
        );
      }
    } finally {
      busy = false;
    }
  };

  const description = $derived.by(() => {
    switch (permission) {
      case 'granted':
        return 'On. New mail shows a notification when Forward Email is not the window you are using.';
      case 'denied':
        return isTauri
          ? 'Blocked. Allow Forward Email in your system notification settings.'
          : 'Blocked for this site. Allow notifications in your browser’s site settings, then reload.';
      case 'unsupported':
        return 'This browser cannot show notifications. New mail still appears in the app.';
      case 'loading':
        return '';
      default:
        return 'Off. Allow notifications to hear about new mail while Forward Email is in the background.';
    }
  });
</script>

<div class="space-y-2" data-testid="new-mail-notifications">
  <div class="flex items-center gap-2 font-medium">
    <Bell class="h-4 w-4" />
    <span>New mail notifications</span>
  </div>
  <p class="text-sm text-muted-foreground" data-testid="new-mail-notifications-state">
    {description}
  </p>
  <div class="flex flex-wrap gap-2">
    {#if permission === 'default' || (isTauri && permission === 'denied')}
      <Button onclick={allow} disabled={busy}>
        <Bell class="mr-2 h-4 w-4" />
        Allow notifications
      </Button>
    {/if}
    {#if permission === 'granted'}
      <Button variant="outline" onclick={test} disabled={busy}>
        <BellRing class="mr-2 h-4 w-4" />
        Send a test notification
      </Button>
    {/if}
  </div>
</div>
