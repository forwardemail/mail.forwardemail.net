<script>
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import * as Card from '$lib/components/ui/card';
  import Mail from '@lucide/svelte/icons/mail';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import HelpCircle from '@lucide/svelte/icons/help-circle';
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import {
    isMailtoHandlerSupported,
    registerAsMailtoHandler,
    getRegistrationStatus,
  } from '../../utils/mailto-handler.js';

  let supported = $state(false);
  /** @type {'default' | 'registered' | 'not_default' | 'declined' | 'unknown'} */
  let status = $state('unknown');
  let registering = $state(false);
  /** @type {string | null} */
  let instructionMessage = $state(null);
  let visible = $state(false);

  onMount(async () => {
    supported = isMailtoHandlerSupported();
    if (supported) {
      status = await getRegistrationStatus();
    }
    visible = supported;
  });

  async function handleRegister() {
    registering = true;
    instructionMessage = null;
    try {
      const result = await registerAsMailtoHandler();

      if (result.method === 'open_mail_settings') {
        // Native settings flow: show the instructions and refresh status immediately.
        instructionMessage = result.message || null;
        status = await getRegistrationStatus();
        // Re-check again after a delay in case the user changes the OS setting.
        setTimeout(async () => {
          status = await getRegistrationStatus();
        }, 5000);
      } else if (result.success) {
        // Direct registration succeeded (Windows/Linux/non-sandboxed macOS)
        status = 'default';
      } else if (result.message) {
        instructionMessage = result.message;
      }

      // Re-check status after a brief delay for web browser prompts
      if (!result.method || result.method === 'registered') {
        setTimeout(async () => {
          status = await getRegistrationStatus();
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
        {#if status === 'default'}
          <CheckCircle class="h-4 w-4 text-green-600 dark:text-green-400" />
          <span class="text-green-600 dark:text-green-400">
            Forward Email is set as your default email app.
          </span>
        {:else if status === 'registered'}
          <HelpCircle class="h-4 w-4 text-blue-600 dark:text-blue-400" />
          <span class="text-blue-600 dark:text-blue-400">
            Forward Email is registered with Windows, but Windows still needs you to choose it for
            the MAILTO link type in Default apps.
          </span>
        {:else if status === 'declined'}
          <AlertCircle class="h-4 w-4 text-orange-500" />
          <span class="text-orange-500">
            Registration was previously declined. You may need to update your browser settings.
          </span>
        {:else if status === 'not_default'}
          <AlertCircle class="h-4 w-4 text-muted-foreground" />
          <span class="text-muted-foreground">
            Another app is currently set as the default email handler.
          </span>
        {:else}
          <HelpCircle class="h-4 w-4 text-muted-foreground" />
          <span class="text-muted-foreground">
            Status unknown. Click below to register or re-register.
          </span>
        {/if}
      </div>

      {#if instructionMessage}
        <div
          class="flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200"
        >
          <ExternalLink class="mt-0.5 h-4 w-4 shrink-0" />
          <p class="whitespace-pre-line">{instructionMessage}</p>
        </div>
      {/if}

      <Button
        variant={status === 'default' ? 'outline' : 'default'}
        size="sm"
        onclick={handleRegister}
        disabled={registering}
      >
        {#if registering}
          Registering...
        {:else if status === 'default'}
          Re-register as default
        {:else if status === 'registered'}
          Open Windows mail settings again
        {:else}
          Set as default email app
        {/if}
      </Button>

      <p class="text-xs text-muted-foreground">
        When registered, clicking mailto: links on any website will open Forward Email to compose a
        new message. On Windows, if Forward Email does not appear under the application search, use
        the MAILTO link-type search instead and choose Forward Email from that handler list.
      </p>
    </Card.Content>
  </Card.Root>
{/if}
