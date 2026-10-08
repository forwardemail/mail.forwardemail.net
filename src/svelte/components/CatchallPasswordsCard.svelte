<script lang="ts">
  /**
   * Domain-wide catch-all passwords, for sending from any address on a domain.
   *
   * Saved on this device for every account (see catchall-credentials.ts). The
   * compose From menu then offers "Other address @domain", and the send uses
   * the catch-all password. The API accepts it for sending only, so it never
   * opens a mailbox; the Sent copy goes to the account you're viewing.
   */
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Card from '$lib/components/ui/card';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import {
    listCatchallDomains,
    normalizeCatchallDomain,
    removeCatchallCredential,
    saveCatchallCredential,
  } from '../../utils/catchall-credentials';

  interface Props {
    onToast?: (message: string, type?: string) => void;
  }

  const { onToast }: Props = $props();

  let domains = $state<string[]>(listCatchallDomains());
  let showAdd = $state(false);
  let addDomain = $state('');
  let addPassword = $state('');
  let addError = $state('');

  // The field reads `*@example.com`; this is the part after the @ as typed.
  const domainPreview = $derived(normalizeCatchallDomain(addDomain));

  const openAdd = () => {
    addDomain = '';
    addPassword = '';
    addError = '';
    showAdd = true;
  };

  const save = () => {
    const result = saveCatchallCredential(addDomain, addPassword);
    if (!result.ok) {
      addError = result.error;
      return;
    }
    domains = listCatchallDomains();
    showAdd = false;
    addPassword = '';
    onToast?.(`You can now send from any address @${result.domain}`, 'success');
  };

  const remove = (domain: string) => {
    if (!confirm(`Remove the catch-all password for ${domain}?`)) return;
    removeCatchallCredential(domain);
    domains = listCatchallDomains();
    onToast?.(`Removed the catch-all password for ${domain}`, 'success');
  };
</script>

<Card.Root data-testid="catchall-passwords">
  <Card.Header>
    <Card.Title>Send from any address</Card.Title>
    <Card.Description>
      Save a domain's catch-all password to send from any address on that domain, from every account
      on this device.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-3">
    {#each domains as domain (domain)}
      <div class="flex items-center justify-between gap-2 border border-border px-3 py-2">
        <span class="truncate font-mono text-sm">*@{domain}</span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Remove the catch-all password for ${domain}`}
          onclick={() => remove(domain)}
        >
          <Trash2 class="h-4 w-4" />
        </Button>
      </div>
    {/each}

    {#if showAdd}
      <form
        class="space-y-3"
        onsubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <div class="space-y-1.5">
          <Label for="catchall-domain">Domain</Label>
          <div class="flex items-center gap-1">
            <span class="font-mono text-sm text-muted-foreground">*@</span>
            <Input
              id="catchall-domain"
              placeholder="example.com"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              bind:value={addDomain}
              oninput={() => (addError = '')}
            />
          </div>
        </div>
        <div class="space-y-1.5">
          <Label for="catchall-password">Catch-all password</Label>
          <Input
            id="catchall-password"
            type="password"
            autocomplete="off"
            bind:value={addPassword}
            oninput={() => (addError = '')}
          />
        </div>
        {#if addError}
          <p class="text-sm text-destructive">{addError}</p>
        {/if}
        <div class="flex gap-2">
          <Button type="button" variant="ghost" onclick={() => (showAdd = false)}>Cancel</Button>
          <Button type="submit" disabled={!domainPreview || !addPassword}>Save</Button>
        </div>
      </form>
    {:else}
      <Button variant="outline" onclick={openAdd}>
        <Plus class="mr-2 h-4 w-4" />
        Add catch-all password
      </Button>
    {/if}

    <p class="text-sm text-muted-foreground">
      Generate one in your domain's Advanced Settings under Catch-all passwords. Then pick
      <strong>Other address</strong> in the From menu when composing. The password can only send mail,
      and a copy of each message goes to the Sent folder of the account you're using. Saved on this device
      only, and protected by App Lock.
    </p>
  </Card.Content>
</Card.Root>
