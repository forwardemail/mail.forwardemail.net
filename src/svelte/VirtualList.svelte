<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    items?: unknown[];
    itemSize?: number;
    overscan?: number;
    padding?: number;
    children: Snippet<[{ item: unknown; index: number }]>;
  }

  let { items = [], itemSize = 80, overscan = 4, padding = 0, children }: Props = $props();

  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  let container: HTMLDivElement | null = $state(null);

  // Use $effect.pre to avoid loop - only runs once per container change
  let lastContainerHeight = 0;
  $effect(() => {
    if (container) {
      const h = container.clientHeight || 0;
      if (h !== lastContainerHeight) {
        lastContainerHeight = h;
        viewportHeight = h;
      }
    }
  });

  const onScroll = (event: Event) => {
    const target = event.target as HTMLElement;
    scrollTop = target?.scrollTop || 0;
    viewportHeight = target?.clientHeight || viewportHeight;
  };

  const totalHeight = $derived((items?.length || 0) * itemSize + padding * 2);
  const startIndex = $derived(Math.max(0, Math.floor((scrollTop - padding) / itemSize) - overscan));
  const endIndex = $derived(
    Math.min(
      items?.length || 0,
      Math.ceil((scrollTop + viewportHeight + padding) / itemSize) + overscan,
    ),
  );
  const visible = $derived((items || []).slice(startIndex, endIndex));
  const offsetY = $derived(startIndex * itemSize + padding);
</script>

<div class="h-full overflow-y-auto" onscroll={onScroll} bind:this={container}>
  <div class="relative w-full" style={`height:${totalHeight}px;`}>
    <div
      class="absolute inset-x-0 top-0 will-change-transform"
      style={`transform: translateY(${offsetY}px);`}
    >
      {#each visible as item, i}
        {@render children({ item, index: startIndex + i })}
      {/each}
    </div>
  </div>
</div>
