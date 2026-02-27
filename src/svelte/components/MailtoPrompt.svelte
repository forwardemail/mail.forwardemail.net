<script>
  import { Button } from '$lib/components/ui/button';
  import Mail from '@lucide/svelte/icons/mail';
  import X from '@lucide/svelte/icons/x';
  import {
    shouldShowMailtoPrompt,
    registerAsMailtoHandler,
    markPromptShown,
  } from '../../utils/mailto-handler.js';

  /** @type {string} Current user account email */
  let { account = '' } = $props();

  let visible = $state(false);

  // Use $effect so the timer is cleaned up on account change (re-runs when account changes)
  $effect(() => {
    const currentAccount = account;
    visible = false;
    if (shouldShowMailtoPrompt(currentAccount)) {
      const timer = setTimeout(() => {
        visible = true;
      }, 2000);
      return () => clearTimeout(timer);
    }
  });

  function handleSetDefault() {
    registerAsMailtoHandler();
    markPromptShown(account);
    visible = false;
  }

  function handleDismiss() {
    markPromptShown(account);
    visible = false;
  }
</script>

{#if visible}
  <div
    class="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 transform"
    role="alert"
    aria-live="polite"
  >
    <div
      class="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 shadow-lg"
    >
      <Mail class="h-5 w-5 shrink-0 text-primary" />
      <p class="text-sm">
        Set Forward Email as your default email app?
      </p>
      <div class="flex shrink-0 gap-2">
        <Button size="sm" onclick={handleSetDefault}>
          Set as default
        </Button>
        <Button size="sm" variant="ghost" onclick={handleDismiss} aria-label="Dismiss">
          <X class="h-4 w-4" />
        </Button>
      </div>
    </div>
  </div>
{/if}
