<script lang="ts">
  import { fade } from 'svelte/transition';
  import { Button } from '$lib/components/ui/button';
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
        return `${base} border-green-100 bg-green-50/70 text-green-800 dark:border-green-700 dark:bg-green-900/50 dark:text-green-200`;
      case 'error':
        return `${base} border-destructive/50 bg-destructive/10 text-destructive dark:border-destructive dark:bg-destructive/20`;
      case 'warning':
        return `${base} border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100`;
      default:
        return `${base} border-border bg-background text-foreground`;
    }
  };
</script>

<div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2" aria-live="polite">
  {#each toastList as toast (toast.id)}
    <div class={getToastClasses(toast.type)} transition:fade={{ duration: 200 }}>
      <span class="text-sm">{toast.message}</span>
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
