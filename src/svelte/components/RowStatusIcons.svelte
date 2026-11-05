<script lang="ts">
  /**
   * Status icons at the end of a message list row: replied, attachments and
   * the star toggle.
   *
   * Labels use the data-tooltip CSS tooltips (no component per icon, which
   * matters in a long list). A touch screen has no hover, so there a tap on
   * a status icon shows its label for a moment and does not open the message.
   */
  import { onDestroy } from 'svelte';
  import Star from '@lucide/svelte/icons/star';
  import StarOff from '@lucide/svelte/icons/star-off';

  interface Props {
    replied?: boolean;
    attachments?: boolean;
    starred?: boolean;
    onToggleStar: () => void;
    iconClass?: string;
  }

  let {
    replied = false,
    attachments = false,
    starred = false,
    onToggleStar,
    iconClass = 'h-3 w-3',
  }: Props = $props();

  const TAP_TOOLTIP_MS = 1500;
  let openTip = $state('');
  let tipTimer: ReturnType<typeof setTimeout> | null = null;

  const showTip = (event: MouseEvent, tip: string) => {
    // With a mouse the label shows on hover, and a click on the icon opens or
    // selects the row like a click anywhere else in it.
    if (!globalThis.matchMedia?.('(hover: none)').matches) return;
    event.stopPropagation();
    openTip = tip;
    if (tipTimer) clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      openTip = '';
      tipTimer = null;
    }, TAP_TOOLTIP_MS);
  };

  onDestroy(() => {
    if (tipTimer) clearTimeout(tipTimer);
  });

  // The tooltip says what the star means, the label what a click does.
  const starTip = $derived(starred ? 'Starred' : 'Not starred');
  const starLabel = $derived(starred ? 'Unstar' : 'Star');
</script>

{#if replied}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <span
    class="shrink-0 inline-flex text-muted-foreground transition-colors hover:text-foreground"
    role="img"
    aria-label="Replied to"
    data-tooltip="Replied to"
    data-tooltip-position="left"
    data-tooltip-open={openTip === 'replied' ? '' : undefined}
    onclick={(e) => showTip(e, 'replied')}
  >
    <svg viewBox="0 0 24 24" class={iconClass} aria-hidden="true">
      <path
        d="M9 17l-5-5 5-5"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
      <path
        d="M20 18v-2a4 4 0 0 0-4-4H4"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
    </svg>
  </span>
{/if}
{#if attachments}
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <span
    class="shrink-0 inline-flex text-muted-foreground transition-colors hover:text-foreground"
    role="img"
    aria-label="Has attachments"
    data-tooltip="Has attachments"
    data-tooltip-position="left"
    data-tooltip-open={openTip === 'attachments' ? '' : undefined}
    onclick={(e) => showTip(e, 'attachments')}
  >
    <svg viewBox="0 0 24 24" class={iconClass} aria-hidden="true">
      <path
        d="M21.44 11.05l-8.49 8.49a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 1 1 4.24 4.24l-9.19 9.19a1 1 0 1 1-1.41-1.41l8.49-8.49"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      ></path>
    </svg>
  </span>
{/if}
<button
  type="button"
  class="shrink-0 inline-flex rounded-sm text-muted-foreground transition hover:text-foreground active:scale-90 active:opacity-70"
  aria-label={starLabel}
  data-tooltip={starTip}
  data-tooltip-position="left"
  onclick={(e) => {
    e.stopPropagation();
    onToggleStar();
  }}
>
  {#if starred}
    <Star class="{iconClass} fill-state-starred text-state-starred" />
  {:else}
    <StarOff class={iconClass} />
  {/if}
</button>
