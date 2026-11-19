<script lang="ts">
  /**
   * Setting for the system-wide "show Forward Email" shortcut.
   *
   * Shown on the desktop app's Keyboard Shortcuts page. The combo is applied
   * as soon as the user records a new one; turning the checkbox off releases
   * it so other apps (Chrome's profile switcher, on macOS) get the keys back.
   */
  import { onDestroy, onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Card from '$lib/components/ui/card';
  import { isTauriMacOS, nativePlatform } from '../../utils/platform.js';
  import {
    captureFromKeyboardEvent,
    formatAccelerator,
    getGlobalShortcut,
    setGlobalShortcut,
    type GlobalShortcutStatus,
    type ShortcutPlatform,
  } from '../../utils/global-shortcut';

  let {
    onToast,
  }: {
    onToast?: (message: string, type?: string) => void;
  } = $props();

  const platform: ShortcutPlatform = isTauriMacOS
    ? 'macos'
    : nativePlatform === 'windows'
      ? 'windows'
      : 'linux';

  let shortcut = $state<GlobalShortcutStatus | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let capturing = $state(false);
  let message = $state('');
  let messageTone = $state<'success' | 'error'>('success');
  let listener: ((event: KeyboardEvent) => void) | null = null;

  const comboLabel = $derived(shortcut ? formatAccelerator(shortcut.accelerator, platform) : '');
  const usingDefault = $derived(
    Boolean(
      shortcut &&
      shortcut.accelerator === shortcut.defaultAccelerator &&
      shortcut.enabled &&
      shortcut.registered,
    ),
  );

  function stopCapture() {
    if (listener) {
      window.removeEventListener('keydown', listener, true);
      listener = null;
    }
    capturing = false;
  }

  onDestroy(stopCapture);

  async function load() {
    loading = true;
    try {
      shortcut = await getGlobalShortcut();
      if (!shortcut) {
        message = "Couldn't read the global shortcut.";
        messageTone = 'error';
      }
    } catch (err) {
      message = err instanceof Error ? err.message : "Couldn't read the global shortcut.";
      messageTone = 'error';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  async function commit(input: { enabled: boolean; accelerator?: string }) {
    if (busy) return;
    busy = true;
    message = '';
    try {
      const next = await setGlobalShortcut(input);
      shortcut = next;
      const text = next.enabled
        ? `Global shortcut set to ${formatAccelerator(next.accelerator, platform)}.`
        : 'Global shortcut turned off. Other apps can use that combination again.';
      message = text;
      messageTone = 'success';
      onToast?.(text, 'success');
    } catch (err) {
      const text = err instanceof Error ? err.message : "Couldn't update the global shortcut.";
      message = text;
      messageTone = 'error';
      onToast?.(text, 'error');
      // The native side keeps the previous combo when registration fails.
      try {
        const current = await getGlobalShortcut();
        if (current) shortcut = current;
      } catch {
        // The message above is the part the user needs.
      }
    } finally {
      busy = false;
    }
  }

  function onEnabledChange() {
    if (!shortcut || busy) return;
    stopCapture();
    // Flip from the value we last showed. The checkbox reports its next state
    // in a couple of shapes; the saved setting is the one that matters.
    void commit({ enabled: !shortcut.enabled });
  }

  function startCapture() {
    if (busy || capturing) return;
    message = '';
    capturing = true;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const result = captureFromKeyboardEvent(event);
      if (result.type === 'pending') return;
      stopCapture();
      if (result.type === 'cancel') return;
      if (result.type === 'invalid') {
        message = result.message;
        messageTone = 'error';
        return;
      }
      void commit({ enabled: true, accelerator: result.accelerator });
    };
    listener = onKey;
    window.addEventListener('keydown', onKey, true);
  }

  function useDefault() {
    if (!shortcut || busy) return;
    stopCapture();
    void commit({ enabled: true, accelerator: shortcut.defaultAccelerator });
  }
</script>

<Card.Root data-testid="global-shortcut-card">
  <Card.Header>
    <Card.Title>Show Forward Email</Card.Title>
    <Card.Description>
      A system-wide shortcut that opens or focuses this app from any other program. The default is
      Command+Shift+M on macOS and Ctrl+Shift+M on Windows and Linux. On macOS that default is also
      Chrome's profile switcher, so you can choose a different combination or turn the shortcut off.
    </Card.Description>
  </Card.Header>
  <Card.Content class="space-y-4">
    {#if loading}
      <p class="text-sm text-muted-foreground">Loading the current shortcut…</p>
    {:else if shortcut}
      <label class="flex items-center gap-3">
        <Checkbox
          checked={shortcut.enabled}
          disabled={busy}
          onCheckedChange={onEnabledChange}
          aria-label="Use a global shortcut to show Forward Email"
        />
        <span>Use a global shortcut to show Forward Email</span>
      </label>

      {#if shortcut.enabled}
        <div class="flex flex-wrap items-center gap-2">
          {#if capturing}
            <code
              class="animate-pulse bg-muted px-2 py-1 text-sm"
              data-testid="global-shortcut-capture"
            >
              Press a shortcut… Esc to cancel
            </code>
            <Button variant="ghost" size="sm" onclick={stopCapture}>Cancel</Button>
          {:else}
            <code class="bg-muted px-2 py-1 text-sm" data-testid="global-shortcut-combo">
              {comboLabel || '—'}
            </code>
            <Button variant="outline" size="sm" disabled={busy} onclick={startCapture}
              >Change</Button
            >
            <Button variant="ghost" size="sm" disabled={busy || usingDefault} onclick={useDefault}>
              Use default
            </Button>
          {/if}
        </div>
        {#if !shortcut.registered && !shortcut.error && !message}
          <p class="text-sm text-muted-foreground">This shortcut is saved, but it isn't active.</p>
        {/if}
      {:else}
        <p class="text-sm text-muted-foreground">
          The shortcut is off, so other apps keep {comboLabel || 'that combination'}.
        </p>
      {/if}
    {/if}

    {#if message}
      <p
        class="text-sm {messageTone === 'error' ? 'text-destructive' : 'text-state-success'}"
        role={messageTone === 'error' ? 'alert' : 'status'}
        data-testid="global-shortcut-message"
      >
        {message}
      </p>
    {:else if shortcut?.error}
      <p class="text-sm text-destructive" role="alert" data-testid="global-shortcut-message">
        {shortcut.error}
      </p>
    {/if}
  </Card.Content>
</Card.Root>
