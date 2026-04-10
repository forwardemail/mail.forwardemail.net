<script lang="ts">
  import { onMount } from 'svelte';
  import { getBuildInfo } from '../utils/tauri-bridge';
  import { checkForUpdates } from '../utils/updater-bridge';
  import { isTauri } from '../utils/platform.js';
  import { Button } from '$lib/components/ui/button';
  import X from '@lucide/svelte/icons/x';
  import ExternalLink from '@lucide/svelte/icons/external-link';

  const openExternal = async (url: string) => {
    if (isTauri) {
      try {
        const { openUrl } = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
        return;
      } catch {
        /* fall through */
      }
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  interface Props {
    open?: boolean;
    onClose?: () => void;
  }

  let { open = $bindable(false), onClose }: Props = $props();

  let version = $state('');
  let buildDate = $state('');
  let arch = $state('');
  let os = $state('');
  let license = $state('');
  let updateStatus = $state('Checking...');
  let loaded = $state(false);

  const archLabels: Record<string, string> = {
    aarch64: 'Apple Silicon',
    x86_64: 'Intel (x64)',
    x86: 'x86',
  };

  const osLabels: Record<string, string> = {
    macos: 'macOS',
    windows: 'Windows',
    linux: 'Linux',
  };

  onMount(async () => {
    try {
      const info = await getBuildInfo();
      if (info) {
        version = info.version || '';
        buildDate = info.buildDate || '';
        arch = info.arch || '';
        os = info.os || '';
        license = info.license || '';
      }
      loaded = true;
    } catch {
      loaded = true;
    }

    try {
      const update = await checkForUpdates();
      if (update?.available) {
        updateStatus = `Update available: v${update.version}`;
      } else {
        updateStatus = 'Up to date';
      }
    } catch {
      updateStatus = 'Unable to check';
    }
  });

  const close = () => {
    open = false;
    onClose?.();
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
</script>

{#if open}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
    onkeydown={handleKeydown}
    role="dialog"
    aria-modal="true"
    aria-label="About Forward Email"
  >
    <div class="w-[420px] overflow-hidden rounded-lg border border-border bg-background shadow-xl">
      <div class="flex items-start justify-between p-5 pb-0">
        <div class="flex items-center gap-3">
          <img src="/icons/icon-256.png" alt="Forward Email" class="h-14 w-14 rounded-xl" />
          <div>
            <h2 class="text-lg font-semibold">Forward Email</h2>
            <p class="text-sm text-muted-foreground">Privacy-focused email</p>
          </div>
        </div>
        <button class="rounded-md p-1 hover:bg-accent" onclick={close} aria-label="Close">
          <X class="h-4 w-4" />
        </button>
      </div>

      {#if loaded}
        <div class="space-y-3 p-5">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt class="text-muted-foreground">Version</dt>
            <dd class="font-mono">{version}</dd>

            {#if buildDate}
              <dt class="text-muted-foreground">Built</dt>
              <dd>{buildDate}</dd>
            {/if}

            <dt class="text-muted-foreground">Platform</dt>
            <dd>{osLabels[os] || os} ({archLabels[arch] || arch})</dd>

            <dt class="text-muted-foreground">Update</dt>
            <dd>{updateStatus}</dd>

            <dt class="text-muted-foreground">License</dt>
            <dd>{license || 'BUSL-1.1'}</dd>
          </dl>

          <div class="border-t border-border pt-3 text-xs text-muted-foreground">
            <p>
              Made by the <button
                class="text-sky-500 hover:underline inline cursor-pointer"
                onclick={() => openExternal('https://forwardemail.net/about')}>Forward Email</button
              > team. Open-source, privacy-first, no tracking.
            </p>
          </div>

          <div class="flex items-center gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onclick={() =>
                openExternal('https://github.com/forwardemail/mail.forwardemail.net/releases')}
            >
              <ExternalLink class="mr-1.5 h-3.5 w-3.5" />
              Release Notes
            </Button>
            <Button
              variant="outline"
              size="sm"
              onclick={() => openExternal('https://forwardemail.net')}
            >
              <ExternalLink class="mr-1.5 h-3.5 w-3.5" />
              Website
            </Button>
          </div>
        </div>
      {:else}
        <div class="flex items-center justify-center p-10 text-sm text-muted-foreground">
          Loading...
        </div>
      {/if}
    </div>
  </div>
{/if}
