<script lang="ts">
  /**
   * MessageTab — Self-contained message reader for desktop tabs.
   *
   * Each instance manages its own state (no shared stores).
   * Loads message body via mailService, renders via EmailIframe.
   * Reply/Forward opens a compose window with context.
   */
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import type { Readable } from 'svelte/store';

  // UI components
  import { Button } from '$lib/components/ui/button';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import EmailIframe from './EmailIframe.svelte';

  // Icons
  import Reply from '@lucide/svelte/icons/reply';
  import ReplyAll from '@lucide/svelte/icons/reply-all';
  import Forward from '@lucide/svelte/icons/forward';
  import Archive from '@lucide/svelte/icons/archive';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import MailIcon from '@lucide/svelte/icons/mail';
  import Eye from '@lucide/svelte/icons/eye';
  import Download from '@lucide/svelte/icons/download';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Loader2 from '@lucide/svelte/icons/loader-2';

  // Services
  import { mailService } from '../../stores/mailService';
  import { Remote } from '../../utils/remote';
  import { Local } from '../../utils/storage';
  import { processQuotedContent } from '../../utils/quote-collapse.js';
  import { formatFriendlyDate } from '../../utils/date';
  import { extractDisplayName } from '../../utils/address.ts';
  import { openComposeWindow } from '../../utils/compose-window';
  import { closeTab } from '../../stores/tabStore';
  import { normalizeEmail, extractAddressList } from '../../utils/address.ts';
  import { getMessageApiId } from '../../utils/sync-helpers';
  import { getEffectiveSettingValue } from '../../stores/settingsStore';
  import {
    buildReplyQuotedBody,
    buildForwardQuotedBody,
    addReplyPrefix,
    addForwardPrefix,
    stripQuoteCollapseMarkup,
  } from '../../stores/mailboxActions';
  import type { Message, Attachment } from '../../types';

  // ─── Props ──────────────────────────────────────────────────────────

  interface Props {
    tabId: string;
    messageId: string;
    accountEmail: string;
    folder: string;
    initialMessage?: Message | null;
    mailboxView?: unknown;
  }

  let {
    tabId,
    messageId,
    accountEmail,
    folder,
    initialMessage = null,
    mailboxView,
  }: Props = $props();

  // ─── Local State (NOT shared stores) ────────────────────────────────

  let message = $state<Message | null>(initialMessage || null);
  let body = $state('');
  let attachmentList = $state<Attachment[]>([]);
  let loading = $state(true);
  let pgpLocked = $state(false);
  let hasBlockedImages = $state(false);
  let blockedImageCount = $state(0);
  let trackingPixelCount = $state(0);
  let showAllImages = $state(false);
  let showEmailDetails = $state(false);
  let showAllRecipients = $state(false);
  let showAllCc = $state(false);
  let error = $state('');

  // Metadata from body load
  let messageMeta = $state<Record<string, unknown> | null>(null);

  // ─── Derived ────────────────────────────────────────────────────────

  const fromDisplay = $derived(message?.from ? extractDisplayName(message.from) : '');
  const toDisplay = $derived(() => {
    const to = message?.to || message?.envelope_to || '';
    if (typeof to === 'string') return to;
    if (Array.isArray(to)) return to.join(', ');
    return '';
  });
  const ccDisplay = $derived(() => {
    const cc = message?.cc || '';
    if (typeof cc === 'string') return cc;
    if (Array.isArray(cc)) return cc.join(', ');
    return '';
  });
  const dateDisplay = $derived(
    message?.date || message?.created_at
      ? formatFriendlyDate(message?.date || message?.created_at)
      : '',
  );
  const hasAttachments = $derived(attachmentList.length > 0 || message?.has_attachment);

  // ─── Message Loading ────────────────────────────────────────────────

  let abortController: AbortController | null = null;

  async function loadMessageBody() {
    if (!message) return;
    loading = true;
    error = '';
    abortController = new AbortController();

    try {
      await mailService.loadMessageDetail(message, {
        onLoading: (val: boolean) => {
          loading = val;
          if (val) {
            body = '';
            attachmentList = [];
          }
        },
        onBody: (html: string) => {
          body = processQuotedContent(html, { collapseByDefault: true });
          loading = false;
        },
        onAttachments: (atts: Attachment[]) => {
          attachmentList = atts || [];
        },
        onImageStatus: (status: {
          hasBlockedImages?: boolean;
          trackingPixelCount?: number;
          blockedRemoteImageCount?: number;
        }) => {
          hasBlockedImages = status.hasBlockedImages || false;
          trackingPixelCount = status.trackingPixelCount || 0;
          blockedImageCount = status.blockedRemoteImageCount || 0;
        },
        onPgpStatus: (status: { locked?: boolean }) => {
          pgpLocked = status.locked || false;
        },
        onMeta: (meta: Record<string, unknown>) => {
          messageMeta = meta;
          // Enrich message with parsed metadata
          if (meta?.nodemailer) {
            message = { ...message!, nodemailer: meta.nodemailer };
          }
        },
        onError: (err: string) => {
          error = err || 'Failed to load message';
          loading = false;
        },
        signal: abortController.signal,
      });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        error = (err as Error)?.message || 'Failed to load message';
        loading = false;
      }
    }
  }

  // Mark as read on open
  function markAsRead() {
    if (!message?.is_unread) return;
    const apiId = getMessageApiId(message as Parameters<typeof getMessageApiId>[0]) || message?.id;
    if (!apiId) return;
    Remote.request(
      'MessageUpdate',
      { flags: { add: ['\\Seen'] } },
      {
        method: 'PUT',
        pathOverride: `/v1/messages/${encodeURIComponent(String(apiId))}`,
      },
    ).catch(() => {});
    message = { ...message!, is_unread: false };
  }

  // ─── Actions ────────────────────────────────────────────────────────

  function handleReply(replyAll = false) {
    if (!message) return;
    const from = message.from || '';
    const to = replyAll ? message.to || '' : '';
    const cc = replyAll ? message.cc || '' : '';
    // Strip quote-collapse viewing markup before encoding for reply
    const cleanBody = stripQuoteCollapseMarkup(body);
    const quotedBody = buildReplyQuotedBody(message, cleanBody);
    openComposeWindow({
      action: 'reply',
      prefill: {
        subject: addReplyPrefix(message.subject),
        from,
        to: replyAll ? to : from,
        cc: replyAll ? cc : undefined,
        date: message.date || message.created_at,
        html: quotedBody,
        inReplyTo: message.header_message_id || message.msgid || message.id,
        replyToMessageId: message.id || null,
        replyToMessageFolder: message.folder || null,
      },
    });
  }

  function handleForward() {
    if (!message) return;
    // Strip quote-collapse viewing markup before encoding for forward
    const cleanBody = stripQuoteCollapseMarkup(body);
    const quotedBody = buildForwardQuotedBody(message, cleanBody);
    openComposeWindow({
      action: 'forward',
      prefill: {
        subject: addForwardPrefix(message.subject),
        html: quotedBody,
      },
    });
  }

  async function handleDelete() {
    if (!message) return;
    const apiId = getMessageApiId(message as Parameters<typeof getMessageApiId>[0]) || message?.id;
    if (!apiId) return;
    try {
      await Remote.request(
        'MessageDelete',
        {},
        {
          method: 'DELETE',
          pathOverride: `/v1/messages/${encodeURIComponent(String(apiId))}`,
        },
      );
      closeTab(tabId);
    } catch (err) {
      error = (err as Error)?.message || 'Failed to delete message';
    }
  }

  async function handleArchive() {
    if (!message) return;
    const archiveFolder = getEffectiveSettingValue('archive_folder') || 'Archive';
    const apiId = getMessageApiId(message as Parameters<typeof getMessageApiId>[0]) || message?.id;
    if (!apiId) return;
    try {
      await Remote.request(
        'MessageUpdate',
        { folder: archiveFolder },
        {
          method: 'PUT',
          pathOverride: `/v1/messages/${encodeURIComponent(String(apiId))}`,
        },
      );
      closeTab(tabId);
    } catch (err) {
      error = (err as Error)?.message || 'Failed to archive message';
    }
  }

  function handleDownloadAttachment(att: Attachment) {
    if (!message) return;
    mailService.downloadAttachment(att, message);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  onMount(() => {
    markAsRead();
    loadMessageBody();
  });

  onDestroy(() => {
    abortController?.abort();
  });
</script>

<div class="flex flex-col h-full bg-background overflow-hidden">
  <!-- Toolbar -->
  <header class="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 shrink-0">
    <div class="flex items-center gap-1">
      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button variant="ghost" size="sm" onclick={() => handleReply(false)}>
            <Reply class="h-4 w-4 mr-1" />
            Reply
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content><p>Reply to sender</p></Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button variant="ghost" size="sm" onclick={() => handleReply(true)}>
            <ReplyAll class="h-4 w-4 mr-1" />
            Reply All
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content><p>Reply to all recipients</p></Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button variant="ghost" size="sm" onclick={handleForward}>
            <Forward class="h-4 w-4 mr-1" />
            Forward
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content><p>Forward message</p></Tooltip.Content>
      </Tooltip.Root>
    </div>

    <div class="flex-1"></div>

    <div class="flex items-center gap-1">
      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button variant="ghost" size="icon" onclick={handleArchive}>
            <Archive class="h-4 w-4" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content><p>Archive</p></Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger>
          <Button
            variant="ghost"
            size="icon"
            class="text-destructive hover:text-destructive"
            onclick={handleDelete}
          >
            <Trash2 class="h-4 w-4" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content><p>Delete</p></Tooltip.Content>
      </Tooltip.Root>
    </div>
  </header>

  <!-- Message Content -->
  <div class="flex-1 overflow-y-auto">
    {#if loading && !body}
      <div class="flex items-center justify-center h-32">
        <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    {:else if error}
      <div class="p-6 text-center text-destructive">
        <p>{error}</p>
        <Button variant="outline" size="sm" class="mt-2" onclick={loadMessageBody}>Retry</Button>
      </div>
    {:else if message}
      <div class="p-6">
        <!-- Subject -->
        <h1 class="text-xl font-semibold mb-4">{message.subject || '(No subject)'}</h1>

        <!-- Sender & Recipients -->
        <div class="flex items-start justify-between mb-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium">{fromDisplay}</span>
              <span class="text-xs text-muted-foreground">{message.from || ''}</span>
            </div>
            <div class="text-sm text-muted-foreground mt-1">
              <span>To: {toDisplay()}</span>
              {#if ccDisplay()}
                <span class="ml-2">Cc: {ccDisplay()}</span>
              {/if}
            </div>
          </div>
          <span class="text-sm text-muted-foreground shrink-0 ml-4">{dateDisplay}</span>
        </div>

        <!-- Blocked Images Warning -->
        {#if hasBlockedImages && !showAllImages}
          <div
            class="flex items-center gap-2 p-3 mb-4 bg-yellow-500/10 border border-yellow-500/25 text-sm"
          >
            <ImageIcon class="h-4 w-4 text-yellow-600 shrink-0" />
            <span>Remote images blocked ({blockedImageCount})</span>
            <Button
              variant="outline"
              size="sm"
              onclick={() => {
                showAllImages = true;
              }}
            >
              Load Images
            </Button>
          </div>
        {/if}

        <!-- PGP Warning -->
        {#if pgpLocked}
          <div
            class="flex items-center gap-2 p-3 mb-4 bg-orange-500/10 border border-orange-500/25 text-sm"
          >
            <ShieldAlert class="h-4 w-4 text-orange-600 shrink-0" />
            <span>This message is encrypted. Enter your PGP passphrase to decrypt.</span>
          </div>
        {/if}

        <!-- Email Body -->
        {#if body}
          <div class="mb-6">
            <EmailIframe html={body} {messageId} />
          </div>
        {/if}

        <!-- Attachments -->
        {#if attachmentList.length > 0}
          <div class="border-t border-border pt-4">
            <div class="flex items-center gap-2 mb-3 text-sm text-muted-foreground">
              <Paperclip class="h-4 w-4" />
              <span>{attachmentList.length} attachment{attachmentList.length !== 1 ? 's' : ''}</span
              >
            </div>
            <div class="flex flex-wrap gap-2">
              {#each attachmentList as att}
                <button
                  type="button"
                  class="flex items-center gap-2 px-3 py-2 border border-border bg-muted/30 hover:bg-muted text-sm transition-colors"
                  onclick={() => handleDownloadAttachment(att)}
                >
                  <Download class="h-3.5 w-3.5 shrink-0" />
                  <span class="truncate max-w-[200px]"
                    >{att.filename || att.name || 'Attachment'}</span
                  >
                  {#if att.size}
                    <span class="text-xs text-muted-foreground">
                      ({Math.round((att.size as number) / 1024)} KB)
                    </span>
                  {/if}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
