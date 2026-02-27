<script>
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Card from '$lib/components/ui/card';
  import Mail from '@lucide/svelte/icons/mail';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import HelpCircle from '@lucide/svelte/icons/help-circle';
  import {
    isProtocolHandlerSupported,
    registerAsMailtoHandler,
    getRegistrationStatus,
  } from '../../utils/mailto-handler.js';
  import { isTauri } from '../../utils/platform.js';

  let supported = $state(false);
  let status = $state('unknown');
  let registering = $state(false);
  // Only show on desktop web — Tauri handles mailto natively, mobile web doesn't support it
  let visible = $state(false);

  onMount(() => {
    supported = isProtocolHandlerSupported();
    status = getRegistrationStatus();
    visible = !isTauri && supported;
  });

  function handleRegister() {
    registering = true;
    try {
      const success = registerAsMailtoHandler();
      if (success) {
        // Re-check status after a brief delay (browser may show prompt)
        setTimeout(() => {
          status = getRegistrationStatus();
          registering = false;
        }, 1000);
      } else {
        registering = false;
      }
    } catch {
      registering = false;
    }
  }
</script>

{#if visible}
<Card.Root>
  <Card.Header>
    <Card.Title class="flex items-center gap-2">
      <Mail class="h-5 w-5" />
      Default Email App
    </Card.Title>
    <Card.Description>
      Set Forward Email as your default email application for mailto: links.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-4">
    <div class="flex items-center gap-2 text-sm">
      {#if status === 'registered'}
        <CheckCircle class="h-4 w-4 text-green-600 dark:text-green-400" />
        <span class="text-green-600 dark:text-green-400">
          Forward Email is set as your default email app.
        </span>
      {:else if status === 'declined'}
        <AlertCircle class="h-4 w-4 text-orange-500" />
        <span class="text-orange-500">
          Registration was previously declined. You may need to update your browser settings.
        </span>
      {:else}
        <HelpCircle class="h-4 w-4 text-muted-foreground" />
        <span class="text-muted-foreground">
          Status unknown. Click below to register or re-register.
        </span>
      {/if}
    </div>

    <Button
      variant={status === 'registered' ? 'outline' : 'default'}
      size="sm"
      onclick={handleRegister}
      disabled={registering}
    >
      {#if registering}
        Registering...
      {:else if status === 'registered'}
        Re-register as default
      {:else}
        Set as default email app
      {/if}
    </Button>

    <p class="text-xs text-muted-foreground">
      When registered, clicking mailto: links on any website will open Forward Email to compose a new message.
    </p>
  </Card.Content>
</Card.Root>
{/if}
