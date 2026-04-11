<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Search from '@lucide/svelte/icons/search';
  import Clock from '@lucide/svelte/icons/clock';
  import X from '@lucide/svelte/icons/x';
  import { Input } from '$lib/components/ui/input';

  interface Suggestion {
    label: string;
    value: string;
    type?: string;
    color?: string;
  }

  interface Result {
    id?: string;
    Subject?: string;
    subject?: string;
    From?: { Display?: string; Email?: string };
    from?: string;
    snippet?: string;
    date?: string;
    Date?: string;
  }

  interface Props {
    query?: string;
    suggestions?: Suggestion[];
    results?: Result[];
    searching?: boolean;
    onSearch?: (val: string) => void;
    onClose?: () => void;
    onSelectResult?: (result: Result) => void;
  }

  let {
    query = '',
    suggestions = [],
    results = [],
    searching = false,
    onSearch,
    onClose,
    onSelectResult,
  }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let localQuery = $state(query);
  let closing = $state(false);

  onMount(async () => {
    await tick();
    // Auto-focus with delay for mobile keyboard
    setTimeout(() => inputEl?.focus(), 150);
  });

  const handleInput = (e: Event) => {
    localQuery = (e.target as HTMLInputElement).value;
    onSearch?.(localQuery);
  };

  const handleClear = () => {
    localQuery = '';
    onSearch?.('');
    inputEl?.focus();
  };

  const handleSuggestionClick = (suggestion: Suggestion) => {
    localQuery = suggestion.value;
    onSearch?.(suggestion.value);
  };

  const handleClose = () => {
    closing = true;
    setTimeout(() => {
      onClose?.();
    }, 200);
  };

  const handleKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') handleClose();
  };

  // Group suggestions by type for display
  const savedSuggestions = $derived(suggestions.filter((s) => s.type === 'saved'));
  const operatorSuggestions = $derived(suggestions.filter((s) => s.type === 'operator'));
  const labelSuggestions = $derived(suggestions.filter((s) => s.type === 'label'));
</script>

<div
  class="fe-search-overlay"
  class:fe-search-overlay-closing={closing}
  role="dialog"
  aria-modal="true"
  aria-label="Search mail"
  onkeydown={handleKeydown}
>
  <!-- Sticky header with back + search input -->
  <div class="fe-search-overlay-header">
    <button
      type="button"
      class="fe-search-overlay-back"
      aria-label="Close search"
      onclick={handleClose}
    >
      <ChevronLeft class="h-5 w-5" />
    </button>
    <div class="fe-search-overlay-input-wrap">
      <input
        type="search"
        class="fe-search-overlay-input"
        placeholder="Search mail"
        value={localQuery}
        bind:this={inputEl}
        oninput={handleInput}
      />
      {#if searching}
        <span class="fe-search-overlay-spinner"></span>
      {:else if localQuery && localQuery.trim().length > 0}
        <button
          type="button"
          class="fe-search-overlay-clear"
          aria-label="Clear search"
          onclick={handleClear}
        >
          <X class="h-4 w-4" />
        </button>
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="fe-search-overlay-body">
    {#if !localQuery.trim()}
      <!-- No query: show saved searches + operators -->
      {#if savedSuggestions.length > 0}
        <div class="fe-search-section">
          <h3 class="fe-search-section-title">Recent searches</h3>
          {#each savedSuggestions as suggestion}
            <button
              type="button"
              class="fe-search-suggestion-row"
              onclick={() => handleSuggestionClick(suggestion)}
            >
              <Clock class="h-4 w-4 text-muted-foreground shrink-0" />
              <span class="truncate">{suggestion.label}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="fe-search-section">
        <h3 class="fe-search-section-title">Search operators</h3>
        <div class="fe-search-chips">
          {#each operatorSuggestions as suggestion}
            <button
              type="button"
              class="fe-search-chip"
              onclick={() => handleSuggestionClick(suggestion)}
            >
              {suggestion.label}
            </button>
          {/each}
        </div>
      </div>

      {#if labelSuggestions.length > 0}
        <div class="fe-search-section">
          <h3 class="fe-search-section-title">Labels</h3>
          <div class="fe-search-chips">
            {#each labelSuggestions as suggestion}
              <button
                type="button"
                class="fe-search-chip"
                style={suggestion.color
                  ? `border-color: ${suggestion.color}; color: ${suggestion.color}`
                  : ''}
                onclick={() => handleSuggestionClick(suggestion)}
              >
                {suggestion.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <!-- Has query: show filtered suggestions -->
      {#each suggestions as suggestion}
        <button
          type="button"
          class="fe-search-suggestion-row"
          onclick={() => handleSuggestionClick(suggestion)}
        >
          <Search class="h-4 w-4 text-muted-foreground shrink-0" />
          <span class="truncate">{suggestion.label}</span>
          {#if suggestion.type === 'saved'}
            <span class="text-xs text-muted-foreground ml-auto">saved</span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>
</div>

<style>
  .fe-search-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: var(--color-background, hsl(var(--background)));
    display: flex;
    flex-direction: column;
    animation: fe-search-slide-down 0.2s ease-out forwards;
  }

  .fe-search-overlay-closing {
    animation: fe-search-slide-up 0.2s ease-in forwards;
  }

  @keyframes fe-search-slide-down {
    from {
      transform: translateY(-100%);
    }
    to {
      transform: translateY(0);
    }
  }

  @keyframes fe-search-slide-up {
    from {
      transform: translateY(0);
    }
    to {
      transform: translateY(-100%);
    }
  }

  .fe-search-overlay-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    padding-top: calc(8px + var(--sai-top, env(safe-area-inset-top, 0px)));
    border-bottom: 1px solid var(--color-border, hsl(var(--border)));
    background: var(--color-background, hsl(var(--background)));
  }

  .fe-search-overlay-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border: none;
    background: transparent;
    color: var(--color-foreground, hsl(var(--foreground)));
    cursor: pointer;
    border-radius: 8px;
    -webkit-tap-highlight-color: transparent;
  }

  .fe-search-overlay-back:active {
    background: var(--color-accent, hsl(var(--accent)));
  }

  .fe-search-overlay-input-wrap {
    flex: 1;
    position: relative;
    display: flex;
    align-items: center;
  }

  .fe-search-overlay-input {
    width: 100%;
    height: 44px;
    padding: 0 40px 0 14px;
    border: 1px solid var(--color-border, hsl(var(--border)));
    border-radius: 8px;
    background: var(--color-background, hsl(var(--background)));
    color: var(--color-foreground, hsl(var(--foreground)));
    font-size: 16px; /* Prevents iOS zoom on focus */
    outline: none;
  }

  .fe-search-overlay-input:focus {
    border-color: var(--color-primary, hsl(var(--primary)));
  }

  .fe-search-overlay-spinner {
    position: absolute;
    right: 12px;
    width: 16px;
    height: 16px;
    border: 2px solid var(--color-border, hsl(var(--border)));
    border-top-color: var(--color-primary, hsl(var(--primary)));
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .fe-search-overlay-clear {
    position: absolute;
    right: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border: none;
    background: transparent;
    color: var(--color-muted-foreground, hsl(var(--muted-foreground)));
    cursor: pointer;
    border-radius: 50%;
    -webkit-tap-highlight-color: transparent;
  }

  .fe-search-overlay-body {
    flex: 1;
    overflow-y: auto;
    padding: 8px 0;
    -webkit-overflow-scrolling: touch;
  }

  .fe-search-section {
    padding: 8px 16px;
  }

  .fe-search-section-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-muted-foreground, hsl(var(--muted-foreground)));
    margin-bottom: 8px;
  }

  .fe-search-suggestion-row {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 12px 16px;
    border: none;
    background: transparent;
    color: var(--color-foreground, hsl(var(--foreground)));
    font-size: 14px;
    text-align: left;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .fe-search-suggestion-row:active {
    background: var(--color-accent, hsl(var(--accent)));
  }

  .fe-search-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .fe-search-chip {
    padding: 6px 12px;
    border: 1px solid var(--color-border, hsl(var(--border)));
    border-radius: 16px;
    background: transparent;
    color: var(--color-foreground, hsl(var(--foreground)));
    font-size: 13px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }

  .fe-search-chip:active {
    background: var(--color-accent, hsl(var(--accent)));
  }
</style>
