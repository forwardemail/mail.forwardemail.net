<script lang="ts">
  import { onMount } from 'svelte';
  import * as Card from '$lib/components/ui/card';
  import { Button } from '$lib/components/ui/button';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import Circle from '@lucide/svelte/icons/circle';
  import { Local } from '../../utils/storage.js';
  import { isTauri } from '../../utils/platform.js';
  import { isDemoMode } from '../../utils/demo-mode.js';
  import { getPushNotificationStatus } from '../../utils/push-notifications.js';
  import {
    getEffectiveSettingValue,
    setSettingValue,
    localSettingsVersion,
  } from '../../stores/settingsStore';
  import {
    isThemeChosen,
    resolveNotificationComplete,
    shouldShowGetStarted,
    type PushPermission,
  } from '../../utils/get-started';

  /**
   * The card stays routing-agnostic: the empty inbox navigates to the settings
   * page while Settings itself just switches sections, so each host passes the
   * behavior in.
   */
  let {
    onNavigate,
    visible = $bindable(false),
  }: {
    onNavigate: (sectionId: 'general' | 'appearance') => void;
    /** Reports whether the card is showing, so a host can adjust its own copy. */
    visible?: boolean;
  } = $props();

  const webPermission = () =>
    typeof Notification !== 'undefined' ? Notification.permission : null;

  let notificationsComplete = $state(false);

  // localSettingsVersion bumps on every setSettingValue, so both the theme
  // choice and the dismissal re-derive without extra wiring.
  const dismissed = $derived.by(() => {
    void $localSettingsVersion;
    return Boolean(getEffectiveSettingValue('get_started_dismissed'));
  });
  const themeComplete = $derived.by(() => {
    void $localSettingsVersion;
    return isThemeChosen(Local.get('theme'));
  });

  const steps = $derived([
    {
      id: 'notifications' as const,
      section: 'general' as const,
      label: 'Enable notifications',
      description: 'Get notified when new mail arrives on this device.',
      complete: notificationsComplete,
    },
    {
      id: 'appearance' as const,
      section: 'appearance' as const,
      label: 'Personalize appearance',
      description: 'Pick a theme, layout, and density that suit you.',
      complete: themeComplete,
    },
  ]);

  const show = $derived(shouldShowGetStarted({ dismissed, demoMode: isDemoMode(), items: steps }));

  $effect(() => {
    visible = show;
  });

  onMount(() => {
    notificationsComplete = resolveNotificationComplete(null, webPermission());
    if (isTauri) {
      // Read-only status probe, fired after mount so no plugin call ever sits
      // on the page-load path.
      void getPushNotificationStatus()
        .then((status) => {
          notificationsComplete = resolveNotificationComplete(
            ((status as { permission?: string } | null)?.permission as PushPermission) ?? null,
            webPermission(),
          );
        })
        .catch(() => {
          // Status is best effort; the item just stays incomplete.
        });
    }
  });

  const dismiss = () => {
    void setSettingValue('get_started_dismissed', true);
  };
</script>

{#if show}
  <Card.Root data-testid="get-started-card">
    <Card.Header>
      <Card.Title>Get started</Card.Title>
      <Card.Description>A couple of quick steps to make Forward Email yours.</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#each steps as step (step.id)}
        <div class="flex items-center justify-between gap-4">
          <div class="flex items-start gap-3">
            {#if step.complete}
              <CheckCircle class="mt-0.5 h-5 w-5 shrink-0 text-state-success" />
            {:else}
              <Circle class="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            {/if}
            <div class="min-w-0 text-left">
              <div class="font-medium">{step.label}</div>
              <p class="text-sm text-muted-foreground">{step.description}</p>
            </div>
          </div>
          {#if !step.complete}
            <Button variant="outline" size="sm" onclick={() => onNavigate(step.section)}>
              Open settings
            </Button>
          {/if}
        </div>
      {/each}
    </Card.Content>
    <Card.Footer>
      <Button variant="ghost" size="sm" onclick={dismiss}>Dismiss</Button>
    </Card.Footer>
  </Card.Root>
{/if}
