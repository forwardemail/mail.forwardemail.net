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
  import X from '@lucide/svelte/icons/x';
  import {
    forgetCatchallAddress,
    listCatchallCredentials,
    normalizeCatchallAddress,
    normalizeCatchallDomain,
    rememberCatchallAddress,
    removeCatchallCredential,
    saveCatchallCredential,
    type CatchallCredential,
  } from '../../utils/catchall-credentials';

  interface Props {
    onToast?: (message: string, type?: string) => void;
  }

  const { onToast }: Props = $props();

  // Domains with their remembered From addresses. The passwords are never
  // shown; only the domain and the addresses are read here.
  const readSaved = () =>
    listCatchallCredentials().map(({ domain, addresses }: CatchallCredential) => ({
      domain,
      addresses,
    }));
  let saved = $state(readSaved());
  // The "add a From address" field of each domain, by domain
  let newAddress = $state<Record<string, string>>({});
  let addressError = $state<Record<string, string>>({});

  const addAddress = (domain: string) => {
    const address = normalizeCatchallAddress(newAddress[domain] || '', domain);
    if (!address) {
      addressError = {
        ...addressError,
        [domain]: `Enter an address on ${domain}, like contact or contact@${domain}`,
      };
      return;
    }
    rememberCatchallAddress(address);
    saved = readSaved();
    newAddress = { ...newAddress, [domain]: '' };
    addressError = { ...addressError, [domain]: '' };
    onToast?.(`${address} is now in the From menu`, 'success');
  };

  const forgetAddress = (address: string) => {
    forgetCatchallAddress(address);
    saved = readSaved();
    onToast?.(`Removed ${address} from the From menu`, 'success');
  };
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
    saved = readSaved();
    showAdd = false;
    addPassword = '';
    onToast?.(`You can now send from any address @${result.domain}`, 'success');
  };

  const remove = (domain: string) => {
    if (!confirm(`Remove the catch-all password for ${domain}?`)) return;
    removeCatchallCredential(domain);
    saved = readSaved();
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
    {#each saved as entry (entry.domain)}
      <div class="space-y-2 border border-border px-3 py-2" data-testid="catchall-domain">
        <div class="flex items-center justify-between gap-2">
          <span class="truncate font-mono text-sm">*@{entry.domain}</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove the catch-all password for ${entry.domain}`}
            onclick={() => remove(entry.domain)}
          >
            <Trash2 class="h-4 w-4" />
          </Button>
        </div>
        {#if entry.addresses.length}
          <ul class="space-y-1" aria-label={`From addresses for ${entry.domain}`}>
            {#each entry.addresses as address (address)}
              <li class="flex items-center justify-between gap-2 pl-2 text-sm">
                <span class="truncate">{address}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${address} from the From menu`}
                  onclick={() => forgetAddress(address)}
                >
                  <X class="h-4 w-4" />
                </Button>
              </li>
            {/each}
          </ul>
        {/if}
        <form
          class="flex items-start gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            addAddress(entry.domain);
          }}
        >
          <div class="min-w-0 flex-1 space-y-1">
            <Input
              aria-label={`Add a From address on ${entry.domain}`}
              placeholder={`contact@${entry.domain}`}
              inputmode="email"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              value={newAddress[entry.domain] || ''}
              oninput={(event) => {
                newAddress = {
                  ...newAddress,
                  [entry.domain]: (event.currentTarget as HTMLInputElement).value,
                };
                addressError = { ...addressError, [entry.domain]: '' };
              }}
            />
            {#if addressError[entry.domain]}
              <p class="text-sm text-destructive" role="alert">{addressError[entry.domain]}</p>
            {/if}
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={!(newAddress[entry.domain] || '').trim()}
          >
            Add
          </Button>
        </form>
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
      <strong>Other address</strong> in the From menu when composing. Addresses you send from are added
      to the From menu, and a reply to mail sent to one of them is sent from it. The password can only
      send mail, and a copy of each message goes to the Sent folder of the account you're using. Saved
      on this device only, and protected by App Lock.
    </p>
  </Card.Content>
</Card.Root>
