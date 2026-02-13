<script lang="ts">
  import { onDestroy, onMount } from 'svelte';

  interface Action {
    label: string;
    icon?: typeof X;
    onclick: () => void;
    variant?: 'default' | 'destructive';
    disabled?: boolean;
  }

  interface Props {
    open?: boolean;
    title?: string;
    actions?: Action[];
    onClose?: () => void;
  }

  let { open = false, title = '', actions = [], onClose = () => {} }: Props = $props();

  let sheetEl: HTMLDivElement | null = $state(null);
  let startY = 0;
  let currentY = 0;
  let isDragging = false;

  const handleTouchStart = (e: TouchEvent) => {
    if (!sheetEl) return;
    startY = e.touches[0].clientY;
    currentY = 0;
    isDragging = true;
  };

  const handleTouchMove = (e: TouchEvent) => {
    if (!isDragging || !sheetEl) return;
    const deltaY = e.touches[0].clientY - startY;
    // Only allow dragging down
    if (deltaY > 0) {
      currentY = deltaY;
      sheetEl.style.transform = `translateY(${deltaY}px)`;
    }
  };

  const handleTouchEnd = () => {
    if (!isDragging || !sheetEl) return;
    isDragging = false;

    // If dragged more than 100px down, close the sheet
    if (currentY > 100) {
      onClose();
    }

    // Reset position
    sheetEl.style.transform = '';
    currentY = 0;
  };

  const handleBackdropClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    }
  };

  onMount(() => {
    if (open) {
      document.addEventListener('keydown', handleKeydown);
      document.body.style.overflow = 'hidden';
    }
  });

  onDestroy(() => {
    document.removeEventListener('keydown', handleKeydown);
    document.body.style.overflow = '';
  });

  $effect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeydown);
      document.body.style.overflow = 'hidden';
    } else {
      document.removeEventListener('keydown', handleKeydown);
      document.body.style.overflow = '';
    }
  });
</script>

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fe-bottom-sheet-backdrop"
    onclick={handleBackdropClick}
  >
    <div
      class="fe-bottom-sheet"
      bind:this={sheetEl}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'bottom-sheet-title' : undefined}
      ontouchstart={handleTouchStart}
      ontouchmove={handleTouchMove}
      ontouchend={handleTouchEnd}
    >
      <!-- Drag handle -->
      <div class="fe-bottom-sheet-handle">
        <div class="fe-bottom-sheet-handle-bar"></div>
      </div>

      <!-- Header -->
      {#if title}
        <div class="fe-bottom-sheet-header">
          <h2 id="bottom-sheet-title" class="fe-bottom-sheet-title">{title}</h2>
          <button
            type="button"
            class="fe-bottom-sheet-close"
            aria-label="Close"
            onclick={onClose}
          >
            <X class="h-5 w-5" />
          </button>
        </div>
      {/if}

      <!-- Actions -->
      <div class="fe-bottom-sheet-content">
        {#each actions as action}
          <button
            type="button"
            class="fe-bottom-sheet-action"
            class:fe-bottom-sheet-action--destructive={action.variant === 'destructive'}
            disabled={action.disabled}
            onclick={() => {
              action.onclick();
              onClose();
            }}
          >
            {#if action.icon}
              <svelte:component this={action.icon} class="h-5 w-5" />
            {/if}
            <span>{action.label}</span>
          </button>
        {/each}
      </div>

      <!-- Cancel button -->
      <div class="fe-bottom-sheet-footer">
        <button
          type="button"
          class="fe-bottom-sheet-cancel"
          onclick={onClose}
        >
          Cancel
        </button>
      </div>
    </div>
  </div>
{/if}
