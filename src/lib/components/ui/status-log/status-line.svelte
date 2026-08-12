<script lang="ts" module>
  import { cn, type WithElementRef } from '$lib/utils.js';
  import type { HTMLLiAttributes } from 'svelte/elements';

  /** The glyph vocabulary from specification §3.3. */
  export type StatusLineStatus = 'success' | 'active' | 'caution' | 'danger' | 'info';

  export type StatusLineProps = WithElementRef<HTMLLiAttributes, HTMLLIElement> & {
    status?: StatusLineStatus;
    /** Right-aligned metadata, e.g. a duration or an SMTP code. Monospaced and
     *  tabular so a column of them aligns. */
    meta?: string | number;
  };
</script>

<script lang="ts">
  /**
   * One line of a StatusLog.
   *
   * The glyph is the non-colour cue: state must stay legible without colour
   * (specification §1 and §6), so the glyph and the screen-reader word carry the
   * meaning and the colour only reinforces it.
   */
  let {
    ref = $bindable(null),
    class: className,
    status = 'info',
    meta,
    children,
    ...restProps
  }: StatusLineProps = $props();

  const GLYPH = {
    success: '✓',
    active: '→',
    caution: '!',
    danger: '✕',
    info: '#',
  } as const;

  const TONE = {
    success: 'text-state-success',
    active: 'text-state-active',
    caution: 'text-state-caution',
    danger: 'text-destructive',
    info: 'text-fg-muted',
  } as const;

  /** Spoken equivalent of the glyph, so the state is not colour- or glyph-only. */
  const SPOKEN = {
    success: 'Passed',
    active: 'In progress',
    caution: 'Warning',
    danger: 'Failed',
    info: 'Information',
  } as const;
</script>

<li
  bind:this={ref}
  data-slot="status-line"
  data-status={status}
  class={cn('flex items-start gap-3 px-3 py-2', className)}
  {...restProps}
>
  <span aria-hidden="true" class={cn('shrink-0 select-none font-semibold', TONE[status])}>
    {GLYPH[status]}
  </span>
  <span class="sr-only">{SPOKEN[status]}:</span>
  <span class="min-w-0 flex-1 break-words">{@render children?.()}</span>
  {#if meta !== undefined && meta !== ''}
    <span class="fe-numeral text-fg-muted shrink-0">{meta}</span>
  {/if}
</li>
