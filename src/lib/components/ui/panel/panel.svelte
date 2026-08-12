<script lang="ts" module>
  import { cn, type WithElementRef } from '$lib/utils.js';
  import type { HTMLAttributes } from 'svelte/elements';

  export type PanelSurface = 'default' | 'inverse';

  export type PanelProps = WithElementRef<HTMLAttributes<HTMLElement>> & {
    /**
     * `inverse` marks technical or recommended content by inverting the panel's
     * surface relative to the page. This is emphasis, not theme: it is
     * independent of the user's light/dark preference.
     */
    surface?: PanelSurface;
  };
</script>

<script lang="ts">
  /**
   * Panel, specification §3.4.
   *
   * Use surface="inverse" for API examples, raw editors, protocol logs and the
   * recommended tier of a comparison. Two constraints from the specification,
   * both checked below in development builds: never nest two inverse panels, and
   * never place one inside a modal. The signal only works when it is rare.
   */
  let {
    ref = $bindable(null),
    class: className,
    surface = 'default',
    children,
    ...restProps
  }: PanelProps = $props();

  /**
   * Development-only misuse check. The CSS carries a nesting guard so a nested
   * panel degrades to "no emphasis" rather than inverting back and looking
   * correct, but a warning explains why the emphasis vanished.
   */
  $effect(() => {
    if (!import.meta.env.DEV || surface !== 'inverse' || !ref) return;
    if (ref.parentElement?.closest('[data-surface="inverse"]')) {
      console.warn(
        '[Panel] An inverse panel is nested inside another. The emphasis inversion ' +
          'only reads when it is rare, so the inner one is neutralised. Drop the inner ' +
          'panel or move it out.',
      );
    }
    if (ref.closest('[role="dialog"], [data-slot="dialog-content"]')) {
      console.warn(
        '[Panel] An inverse panel is inside a modal. A modal is already an emphasis ' +
          'layer, so inverting inside it competes with the scrim. Use surface="default".',
      );
    }
  });
</script>

<section
  bind:this={ref}
  data-slot="panel"
  data-surface={surface === 'inverse' ? 'inverse' : undefined}
  class={cn(
    'rounded-fe-lg border-border border p-5',
    surface === 'default' && 'bg-card text-card-foreground',
    surface === 'inverse' && 'dark:shadow-none [box-shadow:var(--elev-inset)]',
    className,
  )}
  {...restProps}
>
  {@render children?.()}
</section>
