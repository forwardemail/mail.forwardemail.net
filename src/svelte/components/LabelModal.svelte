<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Alert from '$lib/components/ui/alert';
  import { LABEL_PALETTE } from '../../utils/labels.js';

  interface Props {
    visible?: boolean;
    mode?: 'create' | 'edit';
    name?: string;
    color?: string;
    keyword?: string;
    palette?: string[];
    error?: string;
    saving?: boolean;
    showClose?: boolean;
    onClose?: () => void;
    onSave?: () => void;
    onClearError?: () => void;
  }

  let {
    visible = $bindable(false),
    mode = 'create',
    name = $bindable(''),
    color = $bindable(''),
    keyword = '',
    palette = LABEL_PALETTE,
    error = '',
    saving = false,
    showClose = false,
    onClose = () => {},
    onSave = () => {},
    onClearError = () => {},
  }: Props = $props();

  const title = $derived(mode === 'edit' ? 'Edit label' : 'New label');

  const handleOpenChange = (open: boolean) => {
    if (!open) onClose();
  };
</script>

<Dialog.Root open={visible} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-md" showCloseButton={showClose}>
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      {#if mode === 'edit'}
        <Dialog.Description>
          Keyword: <code class="rounded bg-muted px-1.5 py-0.5 text-sm">{keyword}</code>
        </Dialog.Description>
      {/if}
    </Dialog.Header>

    <div class="grid gap-4 py-4">
      <div class="grid gap-2">
        <Label for="label-name">Name</Label>
        <Input
          id="label-name"
          type="text"
          placeholder="Label name"
          bind:value={name}
          oninput={onClearError}
        />
      </div>

      <div class="grid gap-2">
        <Label>Color</Label>
        <div class="label-color-section">
          <div class="label-color-palette">
            {#each palette as swatch}
              <button
                type="button"
                class="label-color-swatch"
                class:active={color === swatch}
                style={`background:${swatch}`}
                title={swatch}
                onclick={() => {
                  color = swatch;
                  onClearError();
                }}
              ></button>
            {/each}
          </div>
          <div class="label-custom-color">
            <span class="text-sm text-muted-foreground font-medium">Custom:</span>
            <input
              type="color"
              bind:value={color}
              oninput={onClearError}
              class="label-color-input"
            />
            <Input
              type="text"
              bind:value={color}
              oninput={onClearError}
              placeholder="#000000"
              maxlength={7}
              class="font-mono flex-1"
            />
          </div>
        </div>
      </div>

      {#if error}
        <Alert.Root variant="destructive">
          <Alert.Description>{error}</Alert.Description>
        </Alert.Root>
      {/if}
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
      <Button onclick={onSave} disabled={saving}>
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .label-color-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .label-color-palette {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 8px;
  }

  .label-color-swatch {
    width: 100%;
    min-height: 36px;
    aspect-ratio: 1 / 1;
    border-radius: 8px;
    border: 2px solid transparent;
    cursor: pointer;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
    transition:
      transform 0.1s ease,
      border-color 0.1s ease;
  }

  .label-color-swatch:hover {
    transform: scale(1.06);
  }

  .label-color-swatch.active {
    border-color: hsl(var(--foreground));
    box-shadow:
      0 0 0 2px hsl(var(--background)),
      inset 0 0 0 1px rgba(255, 255, 255, 0.35);
  }

  .label-custom-color {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 14px;
    border-top: 1px solid hsl(var(--border));
  }

  .label-color-input {
    width: 44px;
    height: 36px;
    border-radius: 8px;
    border: 1px solid hsl(var(--border));
    cursor: pointer;
    background: transparent;
    flex-shrink: 0;
  }

  .label-color-input::-webkit-color-swatch-wrapper {
    padding: 2px;
  }

  .label-color-input::-webkit-color-swatch {
    border: none;
    border-radius: 6px;
  }

  @media (max-width: 600px) {
    .label-color-palette {
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 6px;
    }

    .label-color-swatch {
      min-height: 28px;
      border-radius: 6px;
    }

    .label-custom-color {
      flex-wrap: wrap;
    }
  }
</style>
