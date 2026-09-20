<script lang="ts">
  /**
   * Pinned recipient public keys.
   *
   * The server encrypts outbound mail opportunistically when it can find a key
   * over WKD, but that is invisible and cannot be forced. A key pinned here is
   * what the composer's encrypt toggle uses, so a correspondent whose domain
   * publishes nothing can still be written to securely.
   */
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Textarea } from '$lib/components/ui/textarea';
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Dialog from '$lib/components/ui/dialog';
  import Plus from '@lucide/svelte/icons/plus';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import {
    deleteRecipientKey,
    normalizeAddress,
    readRecipientKeys,
    saveRecipientKey,
    type RecipientKey,
  } from '../../utils/pgp-recipients';

  interface Props {
    onToast?: (message: string, type?: string) => void;
  }

  const { onToast }: Props = $props();

  let keys = $state<RecipientKey[]>(readRecipientKeys());
  let showAdd = $state(false);
  let addEmail = $state('');
  let addArmored = $state('');
  let addError = $state('');
  let pendingDelete = $state<RecipientKey | null>(null);

  const PUBLIC_KEY_BLOCK =
    /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]+-----END PGP PUBLIC KEY BLOCK-----/;

  const openAdd = () => {
    addEmail = '';
    addArmored = '';
    addError = '';
    showAdd = true;
  };

  const commitAdd = () => {
    const email = normalizeAddress(addEmail);
    if (!email || !email.includes('@')) {
      addError = 'Enter the email address this key belongs to.';
      return;
    }
    const armored = addArmored.trim();
    if (!PUBLIC_KEY_BLOCK.test(armored)) {
      // Catching a pasted PRIVATE key here matters: storing one under a
      // recipient would hand that person's secret key to every message.
      addError = armored.includes('PRIVATE KEY')
        ? 'That is a private key. Paste the public key block instead.'
        : 'Paste a full PGP public key block.';
      return;
    }
    keys = saveRecipientKey({ email, armored });
    showAdd = false;
    onToast?.(`Public key saved for ${email}`, 'success');
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const email = pendingDelete.email;
    keys = deleteRecipientKey(email);
    pendingDelete = null;
    onToast?.(`Removed the key for ${email}`, 'success');
  };
</script>

<Card.Root>
  <Card.Header>
    <Card.Title>Recipient encryption keys</Card.Title>
    <Card.Description>
      Messages are already encrypted automatically when a recipient publishes a key. Pin a key here
      to encrypt to someone whose key is not published, and to turn encryption on yourself from the
      composer.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-4">
    {#if !keys.length}
      <p class="text-sm text-muted-foreground">
        No pinned keys yet. Add one to enable the lock button when composing to that address.
      </p>
    {:else}
      <ul class="divide-y divide-border border border-border">
        {#each keys as key (key.email)}
          <li class="flex items-center gap-3 p-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{key.email}</p>
              {#if key.label}
                <p class="truncate text-xs text-muted-foreground">{key.label}</p>
              {/if}
            </div>
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8"
              aria-label={`Remove key for ${key.email}`}
              onclick={() => (pendingDelete = key)}
            >
              <Trash2 class="h-4 w-4" />
            </Button>
          </li>
        {/each}
      </ul>
    {/if}

    <Button variant="outline" onclick={openAdd}>
      <Plus class="mr-2 h-4 w-4" />
      Add a public key
    </Button>

    <p class="text-xs text-muted-foreground">
      Encrypted messages hide the body and attachments. The subject line and the addresses stay
      readable, which is a limitation of PGP itself.
    </p>
  </Card.Content>
</Card.Root>

<Dialog.Root bind:open={showAdd}>
  <Dialog.Content class="sm:max-w-[560px]">
    <Dialog.Header>
      <Dialog.Title>Add a recipient's public key</Dialog.Title>
    </Dialog.Header>
    <div class="space-y-4 py-2">
      {#if addError}
        <Alert.Root variant="destructive">
          <AlertCircle class="h-4 w-4" />
          <Alert.Description>{addError}</Alert.Description>
        </Alert.Root>
      {/if}
      <div class="space-y-2">
        <Label for="recipient-key-email">Email address</Label>
        <Input
          id="recipient-key-email"
          type="email"
          bind:value={addEmail}
          placeholder="jane@example.com"
        />
      </div>
      <div class="space-y-2">
        <Label for="recipient-key-armored">Public key</Label>
        <Textarea
          id="recipient-key-armored"
          bind:value={addArmored}
          placeholder={'-----BEGIN PGP PUBLIC KEY BLOCK-----'}
          class="min-h-[160px] font-mono text-xs"
        />
      </div>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (showAdd = false)}>Cancel</Button>
      <Button onclick={commitAdd}>Save key</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<Dialog.Root
  open={Boolean(pendingDelete)}
  onOpenChange={(open) => {
    if (!open) pendingDelete = null;
  }}
>
  <Dialog.Content class="sm:max-w-[400px]">
    <Dialog.Header>
      <Dialog.Title>Remove this key?</Dialog.Title>
    </Dialog.Header>
    <div class="py-4">
      <p class="text-muted-foreground">
        You will no longer be able to turn on encryption for {pendingDelete?.email} from the composer.
      </p>
    </div>
    <Dialog.Footer>
      <Button variant="ghost" onclick={() => (pendingDelete = null)}>Cancel</Button>
      <Button variant="destructive" onclick={confirmDelete}>Remove</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
