<script lang="ts" module>
  import { cn, type WithElementRef } from '$lib/utils.js';
  import type { HTMLAttributes } from 'svelte/elements';

  export type MonoLabelProps = WithElementRef<HTMLAttributes<HTMLElement>> & {
    /** Element to render. Use a heading tag when this labels a document section. */
    as?: 'div' | 'span' | 'h2' | 'h3' | 'h4' | 'legend';
    /** Leading accent tick, per specification §3.1. */
    tick?: boolean;
    /** Tint the tick with a state colour instead of the default active accent. */
    tone?: 'active' | 'success' | 'caution' | 'danger' | 'encrypted';
  };
</script>

<script lang="ts">
  /**
   * The mono label, specification §3.1.
   *
   * Uppercase, 0.14em tracking, 11px, monospace. The system's highest-frequency
   * brand element: sidebar section headers, column headers, card eyebrows and
   * metadata group labels.
   *
   * Named MonoLabel rather than the specification's `<Label>` because shadcn
   * already ships a form-control Label in this directory and the two are
   * unrelated. Renaming avoids an import that silently resolves to the wrong
   * component.
   */
  let {
    ref = $bindable(null),
    class: className,
    as = 'div',
    tick = false,
    tone = 'active',
    children,
    ...restProps
  }: MonoLabelProps = $props();

  const TICK_TONE = {
    active: 'bg-state-active',
    success: 'bg-state-success',
    caution: 'bg-state-caution',
    danger: 'bg-destructive',
    encrypted: 'bg-state-encrypted',
  } as const;
</script>

<svelte:element
  this={as}
  bind:this={ref}
  data-slot="mono-label"
  class={cn('fe-type-label flex items-center gap-2', className)}
  {...restProps}
>
  {#if tick}
    <!-- Decorative: the label text already carries the meaning. -->
    <span aria-hidden="true" class={cn('h-px w-3 shrink-0', TICK_TONE[tone])}></span>
  {/if}
  {@render children?.()}
</svelte:element>
