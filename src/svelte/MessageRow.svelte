<script lang="ts">
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Badge } from '$lib/components/ui/badge';
  import Star from '@lucide/svelte/icons/star';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import { formatCompactDate } from '../utils/date';
  import { extractDisplayName } from '../utils/address.ts';
  import { truncatePreview } from '../utils/preview';
  import { canonicalizeLabelKeyword } from '../utils/labels.js';
  import type { Message } from '$types';

  interface ConversationItem {
    messages?: Message[];
    is_unread?: boolean;
    is_starred?: boolean;
    has_attachment?: boolean;
    labels?: string[];
    messageCount?: number;
  }

  interface LabelInfo {
    name?: string;
    label?: string;
    value?: string;
    color?: string;
  }

  interface Props {
    item: Message | ConversationItem;
    threaded?: boolean;
    isSelected?: boolean;
    isSentFolder?: boolean;
    onSelect?: (item: Message | ConversationItem) => void;
    onToggle?: (item: Message | ConversationItem, event: Event) => void;
    onContext?: (event: MouseEvent, item: Message | ConversationItem) => void;
    showThreadCount?: boolean;
    labelMap?: Map<string, LabelInfo>;
  }

  let {
    item,
    threaded = false,
    isSelected = false,
    isSentFolder = false,
    onSelect = () => {},
    onToggle = () => {},
    onContext = () => {},
    showThreadCount = false,
    labelMap = new Map(),
  }: Props = $props();

  const handleClick = (event: MouseEvent) => {
    event?.preventDefault?.();
    onSelect?.(item);
  };

  const handleKeydown = (event: KeyboardEvent) => {
    if (event?.key === 'Enter' || event?.key === ' ') {
      event.preventDefault();
      onSelect?.(item);
    }
  };

  const handleToggle = (checked: boolean) => {
    onToggle?.(item, { target: { checked } } as unknown as Event);
  };

  const handleContext = (event: MouseEvent) => {
    event?.preventDefault?.();
    onContext?.(event, item);
  };

  // Walk back through the thread to the most recent message that actually
  // has a usable `from` (or `to` in sent folder). This guards against the
  // common case where the latest message is a calendar response, MDN/DSN,
  // or any auto-generated reply with a missing/unparseable from header —
  // we'd otherwise render the entire conversation as "(no sender)".
  const pickLatestWithField = (
    messages: Message[] | undefined,
    field: 'from' | 'to',
  ): Message | undefined => {
    if (!Array.isArray(messages) || messages.length === 0) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as Message & Record<string, unknown>;
      const value = m?.[field] || (m?.[field === 'from' ? 'From' : 'To'] as unknown);
      if (typeof value === 'string' ? value.trim() : value) return m;
    }
    return messages[messages.length - 1];
  };

  const fromMessage = $derived(
    threaded
      ? pickLatestWithField((item as ConversationItem)?.messages, 'from')
      : (item as Message),
  );
  const toMessage = $derived(
    threaded ? pickLatestWithField((item as ConversationItem)?.messages, 'to') : (item as Message),
  );
  const fromName = $derived(
    extractDisplayName(
      (fromMessage as Message)?.from || ((fromMessage as Record<string, unknown>)?.From as string),
    ),
  );
  const toName = $derived(
    extractDisplayName(
      (toMessage as Message)?.to || ((toMessage as Record<string, unknown>)?.To as string),
    ),
  );
  // Display the raw stored `from` as a secondary fallback so a bare email
  // string still shows up instead of "(no sender)".
  const rawFrom = $derived(
    (fromMessage as Message)?.from ||
      ((fromMessage as Record<string, unknown>)?.From as string) ||
      '',
  );
  const from = $derived(
    isSentFolder
      ? `To: ${toName || fromName || rawFrom || '(no sender)'}`
      : fromName || rawFrom || '(no sender)',
  );
  // Keep `lastMessage` for any downstream references to the trailing message
  // even if it has no sender data of its own.
  const lastMessage = $derived(
    threaded ? (item as ConversationItem)?.messages?.slice?.(-1)?.[0] : (item as Message),
  );
  const subject = $derived((lastMessage as Message)?.subject || '(No subject)');
  const snippet = $derived(truncatePreview((lastMessage as Message)?.snippet || ''));
  // Do NOT fall back to Date.now() for a missing date — that's the bug where a
  // bulk sync made every message read as if it arrived now. Show nothing when
  // there's genuinely no timestamp (the normalizer leaves dateMs = 0).
  const dateTs = $derived((lastMessage as Message)?.date || (lastMessage as Message)?.dateMs || 0);
  const date = $derived(dateTs ? formatCompactDate(dateTs) : '');
  const unread = $derived(
    threaded ? (item as ConversationItem)?.is_unread : (lastMessage as Message)?.is_unread,
  );
  const starred = $derived(
    threaded ? (item as ConversationItem)?.is_starred : (lastMessage as Message)?.is_starred,
  );
  const hasAttachment = $derived(
    threaded
      ? (item as ConversationItem)?.has_attachment
      : (lastMessage as Message)?.has_attachment,
  );
  const labels = $derived(
    (threaded ? (item as ConversationItem)?.labels : (lastMessage as Message)?.labels) || [],
  );
</script>

<div
  class="grid cursor-pointer grid-cols-[28px_1fr_auto] gap-2 border-b border-border px-3 py-2.5 transition-colors hover:bg-accent/50 {unread
    ? 'bg-primary/5'
    : ''} {isSelected ? 'bg-primary/10' : ''}"
  data-testid="message-row"
  data-message-id={item.id}
  data-unread={unread ? 'true' : 'false'}
  onclick={handleClick}
  oncontextmenu={handleContext}
  role="button"
  tabindex="0"
  onkeydown={handleKeydown}
>
  <div class="flex items-center justify-center">
    <Checkbox
      checked={isSelected}
      onCheckedChange={handleToggle}
      onclick={(e) => e.stopPropagation()}
    />
  </div>

  <div class="flex min-w-0 flex-col gap-1">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-1.5 text-foreground {unread ? 'font-bold' : 'font-normal'}">
        {#if starred}
          <Star class="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
        {/if}
        <span class="truncate">{from}</span>
      </div>
      <span class="shrink-0 text-xs text-muted-foreground">{date}</span>
    </div>

    <div class="truncate text-foreground {unread ? 'font-semibold' : 'font-normal'}">
      {subject}
    </div>

    <div class="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
      {#if hasAttachment}
        <Paperclip class="h-3.5 w-3.5 shrink-0 opacity-70" />
      {/if}
      {#if labels && labels.length > 0}
        <span class="flex items-center gap-1">
          {#each labels.slice(0, 3) as lbl}
            {@const def = labelMap.get(canonicalizeLabelKeyword(lbl))}
            <!-- Render even when the definition isn't loaded on this client so a
                 persisted tag never silently disappears; fall back to the keyword. -->
            <Badge
              variant="secondary"
              class="h-5 px-1.5 text-xs"
              style={def?.color ? `background:${def.color}; color:#fff;` : ''}
            >
              {def?.name || def?.label || def?.value || lbl}
            </Badge>
          {/each}
        </span>
      {/if}
      <span class="truncate">{snippet}</span>
    </div>
  </div>

  {#if threaded && showThreadCount}
    <div class="self-center text-xs text-muted-foreground">
      {(item as ConversationItem)?.messageCount ||
        (item as ConversationItem)?.messages?.length ||
        1}
    </div>
  {/if}
</div>
