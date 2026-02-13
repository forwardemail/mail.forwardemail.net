<script lang="ts">
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Badge } from '$lib/components/ui/badge';
  import { formatCompactDate } from '../utils/date';
  import { extractDisplayName } from '../utils/address.ts';
  import { truncatePreview } from '../utils/preview';
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

  const lastMessage = $derived(threaded ? (item as ConversationItem)?.messages?.slice?.(-1)?.[0] : item as Message);
  const from = $derived(extractDisplayName((lastMessage as Message)?.from || (lastMessage as Record<string, unknown>)?.From as string));
  const subject = $derived((lastMessage as Message)?.subject || '(No subject)');
  const snippet = $derived(truncatePreview((lastMessage as Message)?.snippet || ''));
  const date = $derived(formatCompactDate((lastMessage as Message)?.date || (lastMessage as Message)?.dateMs || Date.now()));
  const unread = $derived(threaded ? (item as ConversationItem)?.is_unread : (lastMessage as Message)?.is_unread);
  const starred = $derived(threaded ? (item as ConversationItem)?.is_starred : (lastMessage as Message)?.is_starred);
  const hasAttachment = $derived(threaded ? (item as ConversationItem)?.has_attachment : (lastMessage as Message)?.has_attachment);
  const labels = $derived((threaded ? (item as ConversationItem)?.labels : (lastMessage as Message)?.labels) || []);
</script>

<div
  class="grid cursor-pointer grid-cols-[28px_1fr_auto] gap-2 border-b border-border px-3 py-2.5 transition-colors hover:bg-accent/50 {unread ? 'bg-primary/5' : ''} {isSelected ? 'bg-primary/10' : ''}"
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
      <div class="flex items-center gap-1.5 font-semibold text-foreground">
        {#if starred}
          <LucideStar class="h-3.5 w-3.5 fill-yellow-400 text-yellow-400" />
        {/if}
        <span class="truncate">{from}</span>
      </div>
      <span class="shrink-0 text-xs text-muted-foreground">{date}</span>
    </div>

    <div class="truncate font-medium text-foreground">{subject}</div>

    <div class="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
      {#if hasAttachment}
        <LucidePaperclip class="h-3.5 w-3.5 shrink-0 opacity-70" />
      {/if}
      {#if labels && labels.length > 0}
        <span class="flex items-center gap-1">
          {#each labels.slice(0, 3) as lbl}
            {#if labelMap.get(lbl)}
              <Badge
                variant="secondary"
                class="h-5 px-1.5 text-xs"
                style={labelMap.get(lbl)?.color ? `background:${labelMap.get(lbl)?.color}; color:#fff;` : ''}
              >
                {labelMap.get(lbl)?.name || labelMap.get(lbl)?.label || labelMap.get(lbl)?.value || lbl}
              </Badge>
            {/if}
          {/each}
        </span>
      {/if}
      <span class="truncate">{snippet}</span>
    </div>
  </div>

  {#if threaded && showThreadCount}
    <div class="self-center text-xs text-muted-foreground">
      {(item as ConversationItem)?.messageCount || (item as ConversationItem)?.messages?.length || 1}
    </div>
  {/if}
</div>
