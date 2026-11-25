<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';

  interface PassphraseResult {
    passphrase: string;
    remember: boolean;
  }

  /** Reuses the dialog for other secrets, such as a smartcard PIN. */
  interface PassphraseOptions {
    title?: string;
    description?: string;
    label?: string;
    submitLabel?: string;
    error?: string;
    /** Offer "Remember on this device". Off for a card PIN. */
    allowRemember?: boolean;
  }

  interface PassphraseApi {
    open: (name?: string, options?: PassphraseOptions) => Promise<PassphraseResult>;
    close: () => void;
  }

  interface Props {
    registerApi?: (api: PassphraseApi) => void;
  }

  let { registerApi = () => {} }: Props = $props();

  let visible = $state(false);
  let keyName = $state('');
  let passphrase = $state('');
  let remember = $state(true);
  let options = $state<PassphraseOptions>({});
  let resolver: ((value: PassphraseResult) => void) | null = $state(null);
  let rejecter: ((reason: Error) => void) | null = $state(null);
  let inputEl: HTMLInputElement | null = $state(null);

  const reset = () => {
    keyName = '';
    passphrase = '';
    remember = true;
    options = {};
    resolver = null;
    rejecter = null;
  };

  const close = () => {
    visible = false;
    reset();
  };

  const open = (name: string = '', opts: PassphraseOptions = {}): Promise<PassphraseResult> => {
    keyName = name;
    passphrase = '';
    options = opts;
    remember = opts.allowRemember !== false;
    visible = true;
    setTimeout(() => {
      if (inputEl) inputEl.focus();
    }, 50);
    return new Promise((resolve, reject) => {
      resolver = resolve;
      rejecter = reject;
    });
  };

  const submit = () => {
    if (resolver) resolver({ passphrase, remember: options.allowRemember !== false && remember });
    close();
  };

  const cancel = () => {
    if (rejecter) rejecter(new Error('Passphrase cancelled'));
    close();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      cancel();
    }
  };

  // Guard to only register API once
  let apiRegistered = false;
  $effect(() => {
    if (!apiRegistered) {
      apiRegistered = true;
      registerApi?.({ open, close });
    }
  });
</script>

<Dialog.Root bind:open={visible} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>{options.title || 'Enter PGP passphrase'}</Dialog.Title>
      {#if keyName}
        <Dialog.Description>
          Key: <strong>{keyName}</strong>
        </Dialog.Description>
      {/if}
      <Dialog.Description>
        {options.description ||
          'This passphrase unlocks your private key. It is separate from pasting the key itself.'}
      </Dialog.Description>
      {#if options.error}
        <p class="text-sm text-destructive" role="alert">{options.error}</p>
      {/if}
    </Dialog.Header>

    <div class="grid gap-4 py-4">
      <div class="grid gap-2">
        <Label for="passphrase">{options.label || 'Passphrase'}</Label>
        <Input
          id="passphrase"
          type="password"
          placeholder={`Enter ${(options.label || 'passphrase').toLowerCase()}`}
          bind:value={passphrase}
          bind:ref={inputEl}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
      </div>
      {#if options.allowRemember !== false}
        <label class="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" bind:checked={remember} />
          Remember this passphrase on this device
        </label>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={cancel}>Cancel</Button>
      <Button onclick={submit} disabled={!passphrase}>{options.submitLabel || 'Unlock'}</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
