<script lang="ts" module>
  import { cn, type WithElementRef } from '$lib/utils.js';
  import type { HTMLAttributes } from 'svelte/elements';

  export type StatusLogProps = WithElementRef<HTMLAttributes<HTMLElement>> & {
    /** Accessible name. A log is a list of facts and needs one. */
    label?: string;
  };
</script>

<script lang="ts">
  /**
   * Terminal block, specification §3.3. The most ownable element in the system.
   *
   * Use for DNS diagnostics, delivery logs, rule attribution detail and
   * connection diagnostics. Sits on --surface-sunken so it reads as a well, and
   * sets --type-code so every line is monospace.
   */
  let {
    ref = $bindable(null),
    class: className,
    label = 'Status log',
    children,
    ...restProps
  }: StatusLogProps = $props();
</script>

<ul
  bind:this={ref}
  data-slot="status-log"
  aria-label={label}
  class={cn(
    'fe-type-code bg-surface-sunken border-subtle rounded-fe-lg overflow-x-auto border',
    'divide-subtle divide-y',
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</ul>
