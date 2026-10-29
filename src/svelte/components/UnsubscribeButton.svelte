<script lang="ts">
  /**
   * Unsubscribe from a mailing list, from the reader.
   *
   * Shown only when the message carries a usable List-Unsubscribe header (see
   * list-unsubscribe.ts), and nothing happens without a confirmation that
   * names the destination. An email target is preferred: it goes out from the
   * user's own account, is kept out of Sent, and does not open a page that
   * learns their IP address. An https target opens in the system browser.
   */
  import { Button } from '$lib/components/ui/button';
  import * as Dialog from '$lib/components/ui/dialog';
  import MailMinus from '@lucide/svelte/icons/mail-minus';
  import { getUnsubscribeOptions } from '../../utils/list-unsubscribe';
  import { openExternalUrl } from '../../utils/external-links.js';
  import { Local } from '../../utils/storage';

  interface Props {
    nodemailer?: unknown;
    /** Account the message was delivered to; the email is sent from it. */
    account?: string;
    onToast?: (message: string, type?: string) => void;
  }

  const { nodemailer = null, account = '', onToast }: Props = $props();

  const options = $derived(getUnsubscribeOptions(nodemailer));
  let confirming = $state(false);
  let working = $state(false);
  // Shown in place of the button once done, for hosts without toasts
  let done = $state('');
  // The reader keeps this component across messages
  $effect(() => {
    void nodemailer;
    done = '';
    confirming = false;
  });

  const destination = $derived.by(() => {
    if (options?.mail) return options.mail.to;
    if (options?.url) {
      try {
        return new URL(options.url).hostname;
      } catch {
        return '';
      }
    }
    return '';
  });

  async function unsubscribe() {
    if (!options || working) return;
    working = true;
    try {
      if (options.mail) {
        const from = account || Local.get('email') || '';
        const { queueEmail } = await import('../../utils/outbox-service.js');
        await queueEmail({
          from,
          to: [options.mail.to],
          subject: options.mail.subject,
          text: options.mail.body,
          // Not something to keep in Sent
          save_sent: false,
        });
        done = 'Unsubscribe request sent';
        onToast?.(`Unsubscribe request sent to ${options.mail.to}`, 'success');
      } else if (options.url) {
        await openExternalUrl(options.url);
        done = 'Unsubscribe page opened';
        onToast?.(`Opened the unsubscribe page on ${destination}`, 'success');
      }
      confirming = false;
    } catch (err) {
      // queueEmail has already shown the demo-mode notice
      if (!(err as { isDemo?: boolean })?.isDemo) {
        onToast?.((err as Error)?.message || 'Could not unsubscribe', 'error');
      }
    } finally {
      working = false;
    }
  }
</script>

{#if options && done}
  <span class="text-xs text-muted-foreground" data-testid="reader-unsubscribe-done">{done}</span>
{:else if options}
  <Button
    variant="ghost"
    size="sm"
    class="h-7 px-2 text-xs"
    onclick={() => (confirming = true)}
    data-testid="reader-unsubscribe"
  >
    <MailMinus class="h-3.5 w-3.5" />
    Unsubscribe
  </Button>

  <Dialog.Root bind:open={confirming}>
    <Dialog.Content class="sm:max-w-[420px]">
      <Dialog.Header>
        <Dialog.Title>Unsubscribe from this list?</Dialog.Title>
      </Dialog.Header>
      <div class="py-2 text-sm text-muted-foreground">
        {#if options.mail}
          <p>
            An unsubscribe email will be sent from {account || 'your account'} to
            <strong class="text-foreground">{options.mail.to}</strong>. It is not saved to Sent.
          </p>
        {:else}
          <p>
            The sender's unsubscribe page on <strong class="text-foreground">{destination}</strong>
            will open in your browser.
          </p>
        {/if}
        <p class="mt-2">
          Only unsubscribe from mail you signed up for. For spam, use Report spam or Block sender
          instead: unsubscribing tells a spammer the address is read.
        </p>
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onclick={() => (confirming = false)}>Cancel</Button>
        <Button onclick={unsubscribe} disabled={working} data-testid="reader-unsubscribe-confirm">
          {working ? 'Unsubscribing…' : 'Unsubscribe'}
        </Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
