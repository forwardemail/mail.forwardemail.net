<script lang="ts">
  import { fade } from 'svelte/transition';
  import { Button } from '$lib/components/ui/button';
  import X from '@lucide/svelte/icons/x';
  import type { Readable } from 'svelte/store';

  interface ToastAction {
    label: string;
    callback?: () => void;
  }

  interface Toast {
    id: string;
    message: string;
    type?: 'success' | 'error' | 'warning' | 'info' | string;
    action?: ToastAction;
  }

  interface Props {
    items: Readable<Toast[]>;
    dismiss?: (id: string) => void;
  }

  let { items, dismiss = () => {} }: Props = $props();

  // Subscribe to the store and track the value
  let toastList: Toast[] = $state([]);

  // Guard to prevent multiple subscriptions
  let toastSubscribed = false;
  $effect(() => {
    if (items?.subscribe && !toastSubscribed) {
      toastSubscribed = true;
      const unsub = items.subscribe((value) => {
        toastList = value || [];
      });
      return () => {
        toastSubscribed = false;
        unsub();
      };
    }
  });

  const handleDismiss = (id: string) => {
    dismiss?.(id);
  };

  const getToastClasses = (type?: string) => {
    const base = 'flex items-center justify-between gap-3 border p-4 shadow-lg';
    switch (type) {
      case 'success':
        return `${base} border-state-success/30 bg-state-success/10 text-state-success`;
      case 'error':
        return `${base} border-destructive/30 bg-destructive/10 text-destructive`;
      case 'warning':
        return `${base} border-state-caution/30 bg-state-caution/10 text-state-caution`;
      default:
        return `${base} border-border bg-background text-foreground`;
    }
  };
</script>

<div
  class="fixed bottom-4 right-4 flex flex-col gap-2"
  style="z-index: 10010;"
  aria-live="polite"
  data-testid="toast-list"
>
  {#each toastList as toast (toast.id)}
    <div
      class={getToastClasses(toast.type)}
      transition:fade={{ duration: 200 }}
      data-testid="toast"
      data-toast-type={toast.type || 'info'}
    >
      <span class="text-sm" data-testid="toast-message">{toast.message}</span>
      <div class="flex items-center gap-1">
        {#if toast.action}
          <Button
            variant="ghost"
            size="sm"
            onclick={() => {
              toast.action?.callback?.();
              handleDismiss(toast.id);
            }}
          >
            {toast.action.label}
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          onclick={() => handleDismiss(toast.id)}
        >
          <X class="h-4 w-4" />
        </Button>
      </div>
    </div>
  {/each}
</div>
