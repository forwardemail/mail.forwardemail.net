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
    // Toasts float over arbitrary mailbox content, so the surface must be
    // OPAQUE. The old bg-state-*/10 backgrounds were 90% transparent, which
    // read as a faint wash over whatever was underneath, unreadable in light
    // mode especially on mobile. bg-popover supplies the solid elevated base
    // (same token as dropdowns and popovers); the tint is layered on top via
    // a flat gradient, since background-image paints over background-color in
    // the same element.
    const base =
      'flex items-center justify-between gap-3 border p-4 shadow-lg bg-popover bg-gradient-to-b';
    switch (type) {
      case 'success':
        return `${base} from-state-success/10 to-state-success/10 border-state-success/30 text-state-success`;
      case 'error':
        return `${base} from-destructive/10 to-destructive/10 border-destructive/30 text-destructive`;
      case 'warning':
        return `${base} from-state-caution/10 to-state-caution/10 border-state-caution/30 text-state-caution`;
      default:
        return `${base} from-transparent to-transparent border-border text-foreground`;
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
