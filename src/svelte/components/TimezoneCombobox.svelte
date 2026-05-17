<script lang="ts">
  import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover';
  import { Input } from '$lib/components/ui/input';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Check from '@lucide/svelte/icons/check';
  import { cn } from '$lib/utils.js';

  interface Props {
    value?: string;
    onChange?: (next: string) => void;
    id?: string;
    placeholder?: string;
    disabled?: boolean;
  }

  let {
    value = $bindable(''),
    onChange,
    id,
    placeholder = 'Select a time zone',
    disabled = false,
  }: Props = $props();

  // Source the full IANA list when the runtime supports it. Fall back to a
  // hand-curated short list for older browsers / web views so the dropdown
  // is never empty.
  const FALLBACK_ZONES = [
    'UTC',
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'America/Anchorage',
    'Pacific/Honolulu',
    'America/Toronto',
    'America/Vancouver',
    'America/Mexico_City',
    'America/Sao_Paulo',
    'Europe/London',
    'Europe/Paris',
    'Europe/Berlin',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Amsterdam',
    'Europe/Stockholm',
    'Europe/Moscow',
    'Africa/Cairo',
    'Africa/Johannesburg',
    'Asia/Dubai',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Bangkok',
    'Asia/Singapore',
    'Asia/Hong_Kong',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Asia/Seoul',
    'Australia/Perth',
    'Australia/Sydney',
    'Pacific/Auckland',
  ];

  const allZones: string[] = (() => {
    try {
      const intlAny = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
      if (typeof intlAny.supportedValuesOf === 'function') {
        const zones = intlAny.supportedValuesOf('timeZone');
        if (Array.isArray(zones) && zones.length > 0) return zones;
      }
    } catch {
      // ignore — use fallback
    }
    return FALLBACK_ZONES;
  })();

  let open = $state(false);
  let query = $state('');
  let searchInputEl: HTMLInputElement | null = $state(null);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allZones.slice(0, 200);
    const matches: string[] = [];
    for (const z of allZones) {
      if (z.toLowerCase().includes(q)) {
        matches.push(z);
        if (matches.length >= 200) break;
      }
    }
    return matches;
  });

  // Try to surface the browser's local zone for quick selection.
  const localZone: string = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();

  function select(zone: string) {
    value = zone;
    onChange?.(zone);
    open = false;
    query = '';
  }

  $effect(() => {
    // Focus the search input when the popover opens so users can type immediately.
    if (open && searchInputEl) {
      // Microtask: bits-ui mounts the content asynchronously.
      queueMicrotask(() => searchInputEl?.focus());
    }
  });
</script>

<Popover bind:open>
  <PopoverTrigger
    {id}
    {disabled}
    class={cn(
      'border-input bg-background text-foreground placeholder:text-muted-foreground flex h-9 w-full items-center justify-between rounded-md border px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
    )}
  >
    <span class={cn('truncate', !value && 'text-muted-foreground')}>
      {value || placeholder}
    </span>
    <ChevronDown class="ml-2 size-4 shrink-0 opacity-50" />
  </PopoverTrigger>

  <PopoverContent class="z-[10000] w-(--bits-popover-anchor-width) min-w-[260px] p-0" align="start">
    <div class="border-b border-border p-2">
      <Input
        bind:ref={searchInputEl}
        type="text"
        placeholder="Search time zones…"
        bind:value={query}
        class="h-8"
      />
    </div>
    <div class="max-h-72 overflow-y-auto py-1">
      {#if localZone && (!query || localZone.toLowerCase().includes(query.toLowerCase()))}
        <button
          type="button"
          class={cn(
            'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent',
            value === localZone && 'bg-accent/60',
          )}
          onclick={() => select(localZone)}
        >
          <span class="truncate">
            {localZone} <span class="text-muted-foreground text-xs">(local)</span>
          </span>
          {#if value === localZone}
            <Check class="size-3.5 shrink-0" />
          {/if}
        </button>
        <div class="my-1 border-t border-border"></div>
      {/if}

      {#each filtered as zone (zone)}
        <button
          type="button"
          class={cn(
            'flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent',
            value === zone && 'bg-accent/60',
          )}
          onclick={() => select(zone)}
        >
          <span class="truncate">{zone}</span>
          {#if value === zone}
            <Check class="size-3.5 shrink-0" />
          {/if}
        </button>
      {/each}

      {#if filtered.length === 0}
        <div class="px-3 py-4 text-center text-xs text-muted-foreground">
          No matching time zones
        </div>
      {/if}
    </div>
  </PopoverContent>
</Popover>
