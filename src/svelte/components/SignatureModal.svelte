<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Alert from '$lib/components/ui/alert';
  import DOMPurify from 'dompurify';
  import RichTextEditor from './RichTextEditor.svelte';

  interface Props {
    visible?: boolean;
    mode?: 'create' | 'edit';
    name?: string;
    body?: string;
    isDefault?: boolean;
    lockDefault?: boolean;
    error?: string;
    saving?: boolean;
    showClose?: boolean;
    onSave?: () => void;
    onClose?: () => void;
    onClearError?: () => void;
  }

  let {
    visible = $bindable(false),
    mode = 'create',
    name = $bindable(''),
    body = $bindable(''),
    isDefault = $bindable(false),
    lockDefault = false,
    error = '',
    saving = false,
    showClose = false,
    onSave = () => {},
    onClose = () => {},
    onClearError = () => {},
  }: Props = $props();

  const title = $derived(mode === 'edit' ? 'Edit signature' : 'New signature');
  const previewHtml = $derived(
    DOMPurify.sanitize(body || '<p class="text-muted-foreground">Preview</p>'),
  );

  function handleOpenChange(open: boolean) {
    if (!open) onClose();
  }
</script>

<Dialog.Root open={visible} onOpenChange={handleOpenChange}>
  <Dialog.Content class="sm:max-w-3xl" showCloseButton={showClose}>
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>
        Auto-append to outgoing mail. The default signature is used unless you pick another in the
        compose toolbar.
      </Dialog.Description>
    </Dialog.Header>

    <div class="sig-grid">
      <div class="sig-form">
        <div class="grid gap-2">
          <Label for="signature-name">Name</Label>
          <Input
            id="signature-name"
            type="text"
            placeholder="e.g. Personal"
            bind:value={name}
            oninput={onClearError}
          />
        </div>

        <div class="grid gap-2">
          <Label>Body</Label>
          <RichTextEditor
            bind:value={body}
            placeholder="— your name, role, etc."
            minHeight="180px"
            onChange={() => onClearError()}
          />
        </div>

        <label class="flex items-center gap-2">
          <Checkbox bind:checked={isDefault} disabled={lockDefault} />
          <span class="text-sm">
            Set as default signature
            {#if lockDefault}
              <span class="text-xs text-muted-foreground">(first signature is always default)</span>
            {/if}
          </span>
        </label>

        {#if error}
          <Alert.Root variant="destructive">
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}
      </div>

      <div class="sig-preview">
        <div class="sig-preview-label">Preview</div>
        <div class="sig-preview-surface">
          {@html previewHtml}
        </div>
      </div>
    </div>

    <Dialog.Footer>
      <Button variant="ghost" onclick={onClose}>Cancel</Button>
      <Button onclick={onSave} disabled={saving || !name.trim()}>
        {saving ? 'Saving...' : 'Save'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<style>
  .sig-grid {
    display: grid;
    gap: 16px;
    padding: 4px 0 12px;
    grid-template-columns: 1fr;
  }
  .sig-form {
    display: grid;
    gap: 14px;
  }
  .sig-preview-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: hsl(var(--muted-foreground));
    margin-bottom: 6px;
  }
  .sig-preview-surface {
    border: 1px solid hsl(var(--border));
    border-radius: 6px;
    padding: 12px;
    background: hsl(var(--muted) / 0.3);
    font-size: 14px;
    line-height: 1.5;
    min-height: 180px;
    max-height: 320px;
    overflow-y: auto;
  }
  .sig-preview-surface :global(ul) {
    list-style: disc;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .sig-preview-surface :global(ol) {
    list-style: decimal;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }
  .sig-preview-surface :global(li) {
    margin: 0.25rem 0;
  }
  .sig-preview-surface :global(li > p) {
    margin: 0;
  }
  .sig-preview-surface :global(a) {
    color: hsl(var(--primary));
    text-decoration: underline;
  }
  .sig-preview-surface :global(p) {
    margin: 0.5rem 0;
  }
  .sig-preview-surface :global(p:empty)::before {
    content: '\00a0';
  }
  .sig-preview-surface :global(strong) {
    font-weight: 600;
  }
  .sig-preview-surface :global(em) {
    font-style: italic;
  }
  @media (min-width: 720px) {
    .sig-grid {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
  }
</style>
