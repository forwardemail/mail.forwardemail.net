<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import X from '@lucide/svelte/icons/x';
  import Square from '@lucide/svelte/icons/square';
  import PencilLine from '@lucide/svelte/icons/pencil-line';
  import FileText from '@lucide/svelte/icons/file-text';
  import MessageSquareQuote from '@lucide/svelte/icons/message-square-quote';
  import { getProvider, getProviderKey } from '../../../ai/keystore-web';
  import { getAIWorkerClient } from '../../../utils/ai-worker-client.js';
  import { getPrompt, buildScopeAnnouncement, type AIFeature } from '../../../ai/prompts/system';
  import {
    buildThreadContext,
    buildFullThreadContext,
    buildReplyPrefill,
    type ThreadContextOutput,
  } from '../../../ai/context/thread-context';
  import { loadThreadMessages, type LoadedThread } from '../../../ai/context/thread-loader';
  import { dbClient } from '../../../utils/db-worker-client.js';
  import {
    appendAuditEvent,
    newAuditSessionId,
    type AuditEvent,
  } from '../../../stores/aiAuditStore';
  import { aiPrefs } from '../../../stores/aiPrefsStore';
  import EgressPreviewModal from './EgressPreviewModal.svelte';
  import { getAllowedTools } from '../../../ai/tools/registry';
  import { estimateRequestCost } from '../../../ai/pricing';
  import { renderMarkdownSafe } from '../../../ai/markdown';
  const renderedOutput = $derived(renderMarkdownSafe(output));
  import { extractParticipants, type ContextScope, type RepoRef } from '../../../ai/context/scope';
  import { listRepositories } from '../../../ai/repositories/store';
  import type { RepositorySummary } from '../../../ai/repositories/types';
  import { selectedMessage, messageBody, attachments } from '../../../stores/messageStore';
  import { collectImageBlocks } from '../../../ai/context/images';
  import Image from '@lucide/svelte/icons/image';
  import {
    aiPanelIntent,
    consumeAIPanelIntent,
    type AIPanelPreset,
  } from '../../../stores/aiPanelStore';
  import { Local } from '../../../utils/storage';
  import type { Message } from '../../../types';
  import FolderGit2 from '@lucide/svelte/icons/folder-git-2';
  import Code2 from '@lucide/svelte/icons/code-2';

  interface Props {
    mailboxView?: {
      composeModal?: {
        open: (prefill: Record<string, unknown>) => unknown;
      };
    };
  }

  let { mailboxView }: Props = $props();

  const PROVIDER_ID = 'anthropic';

  let open = $state(false);
  let prompt = $state('');
  let output = $state('');
  let streaming = $state(false);
  let lastFinishReason = $state<string | null>(null);
  let error = $state<string | null>(null);
  let cancelFn: (() => Promise<void>) | null = null;
  let textarea = $state<HTMLTextAreaElement | null>(null);
  let activeFeature = $state<AIFeature>('summarize');
  let includeContext = $state(true);

  let currentMessage = $state<Message | null>(null);
  let currentBody = $state<string>('');
  let currentAttachments = $state<unknown[]>([]);
  let includeImages = $state(true);

  // Images the model will actually see — derived from the current message's
  // attachments store, filtered + base64-decoded once for reuse.
  const availableImages = $derived(collectImageBlocks(currentAttachments as never));
  let loadedThread = $state<LoadedThread | null>(null);
  let loadingThread = $state(false);
  let loadedForMessageId = $state<string | null>(null);

  const unsubMsg = selectedMessage.subscribe((m) => {
    currentMessage = m;
    // Invalidate the loaded thread when the selection changes.
    if (!m || m.id !== loadedForMessageId) {
      loadedThread = null;
      loadedForMessageId = null;
    }
  });
  const unsubBody = messageBody.subscribe((b) => {
    currentBody = b || '';
  });
  const unsubAtts = attachments.subscribe((a) => {
    currentAttachments = (a as unknown[]) ?? [];
  });
  // Listen for external open requests (message action bar, keyboard shortcuts).
  const unsubIntent = aiPanelIntent.subscribe((intent) => {
    if (!intent) return;
    if (!open) {
      open = true;
      resetSession();
      void refreshAvailableRepos();
      void loadSelectedBody();
    }
    if (intent.preset) applyPresetById(intent.preset);
    consumeAIPanelIntent();
    setTimeout(() => textarea?.focus(), 50);
  });
  onDestroy(() => {
    unsubMsg();
    unsubBody();
    unsubAtts();
    unsubIntent();
  });

  const applyPresetById = (id: AIPanelPreset) => {
    const byId: Record<AIPanelPreset, (typeof PRESETS)[number] | undefined> = {
      summarize: PRESETS.find((p) => p.label === 'Summarize'),
      draft_reply: PRESETS.find((p) => p.label === 'Draft reply'),
      draft_with_code: PRESETS.find((p) => p.label === 'Draft w/ code'),
      ask: PRESETS.find((p) => p.label === 'Ask'),
    };
    const preset = byId[id];
    if (preset) applyPreset(preset);
  };

  /**
   * Load just the selected message's body when the panel opens on a thread
   * whose body hasn't been hydrated yet (e.g., user opened Ask AI from the
   * list row without scrolling into the message). Without this, the panel
   * would only send subject + snippet; with it, Claude sees the actual body.
   */
  const loadSelectedBody = async (): Promise<void> => {
    if (!currentMessage || currentBody) return;
    try {
      const account = Local.get('email') || 'default';
      const row = (await dbClient.messageBodies.get([account, currentMessage.id])) as
        | { body?: string; textContent?: string }
        | undefined;
      if (row) {
        const text = row.textContent ?? row.body ?? '';
        if (text) currentBody = text;
      }
    } catch (err) {
      console.warn('[AskAI] loadSelectedBody failed', err);
    }
  };

  const loadFullThread = async (): Promise<LoadedThread | null> => {
    if (!currentMessage) return null;
    if (loadedThread && loadedForMessageId === currentMessage.id) return loadedThread;
    const account = Local.get('email') || 'default';
    loadingThread = true;
    try {
      const result = await loadThreadMessages(account, currentMessage);
      loadedThread = result;
      loadedForMessageId = currentMessage.id;
      return result;
    } catch (err) {
      console.warn('[AskAI] loadThreadMessages failed', err);
      return null;
    } finally {
      loadingThread = false;
    }
  };

  let draftFlowActive = $state(false);
  // Egress preview modal state. When non-null the modal is shown; `resolve`
  // fires with true on Proceed / false on Cancel and tears the modal down.
  // The last complete assistant draft — kept around after a turn finishes so
  // the user can ask for a regeneration with a hint. Cleared on resetSession
  // and overwritten on each successful run.
  let lastDraft = $state<string>('');
  let lastUserPrompt = $state<string>('');
  let regenHint = $state('');
  let regenOpen = $state(false);

  let pendingEgress = $state<{
    endpoint: string;
    feature: string;
    scopeKind: string;
    scopeDetail?: string;
    sections: Array<{ label: string; chars: number; detail: string }>;
    toolNames: string[];
    model: string;
    cost: { display: string; input_tokens: number; output_tokens: number };
    resolve: (proceed: boolean) => void;
  } | null>(null);
  // Session-local scope override. Resets on panel open. User-initiated expand
  // from thread → participants or mailbox flips this; never persisted.
  let scopeOverride = $state<'participants' | 'mailbox' | null>(null);
  let toolActivity = $state<Array<{ id: string; name: string; summary?: string; ok?: boolean }>>(
    [],
  );

  // Available repos loaded from Dexie; attached repos are the subset the user
  // has opted into for this session. Both reset on panel open.
  let availableRepos = $state<RepositorySummary[]>([]);
  let attachedRepoIds = $state<Set<string>>(new Set());
  let repoPickerOpen = $state(false);
  let sourcesRead = $state<Set<string>>(new Set());

  const attachedRepos: RepoRef[] = $derived(
    availableRepos
      .filter((r) => attachedRepoIds.has(r.id))
      .map((r) => ({ id: r.id, label: r.label })),
  );

  const refreshAvailableRepos = async () => {
    try {
      availableRepos = await listRepositories();
    } catch (err) {
      console.warn('[AskAI] list repos failed', err);
    }
  };

  const scope: ContextScope = $derived.by(() => {
    const account = Local.get('email') || 'default';
    const msg = currentMessage;
    const repos = attachedRepos.length > 0 ? attachedRepos : undefined;
    if (scopeOverride === 'mailbox') {
      return { kind: 'mailbox' as const, account, confirmed: true, repos };
    }
    if (scopeOverride === 'participants' && loadedThread) {
      const participants = Array.from(
        new Set(
          loadedThread.messages
            .flatMap((m) => [m.message.from, m.message.to, m.message.cc])
            .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []))
            .map((s) => String(s).toLowerCase().trim())
            .filter(Boolean),
        ),
      );
      return { kind: 'participants' as const, account, participants, repos };
    }
    if (!msg) return { kind: 'mailbox' as const, account, confirmed: false, repos };
    const threadId = msg.thread_id ?? msg.root_id ?? null;
    return {
      kind: 'thread' as const,
      account,
      threadId,
      rootId: msg.root_id ?? null,
      repos,
    };
  });

  // The rendered context depends on whether we've loaded a full thread yet.
  // If the full thread is loaded, use it. Otherwise fall back to the single
  // currently-selected message (cheaper, available immediately).
  const context: ThreadContextOutput = $derived.by(() => {
    if (loadedThread && loadedThread.messages.length > 1) {
      return buildFullThreadContext(activeFeature, {
        messages: loadedThread.messages.map((m) => ({ message: m.message, body: m.body })),
        truncated: loadedThread.truncated,
        totalAvailable: loadedThread.totalAvailable,
      });
    }
    return buildThreadContext(activeFeature, { message: currentMessage, body: currentBody });
  });
  // Draft-reply flow enables the Compose handoff button. Summarize / Ask don't.
  const showDraftHandoff = $derived(
    Boolean(
      mailboxView?.composeModal?.open && output.trim().length > 0 && !streaming && draftFlowActive,
    ),
  );

  const PRESETS: {
    id: AIFeature;
    label: string;
    icon: typeof Sparkles;
    starter: string;
    draft?: boolean;
    /** When true, auto-attach every registered repo to the session. */
    autoAttachRepos?: boolean;
  }[] = [
    {
      id: 'summarize',
      label: 'Summarize',
      icon: FileText,
      starter: 'Summarize this thread in 2-3 sentences. Lead with the outcome if there is one.',
    },
    {
      id: 'summarize',
      label: 'Draft reply',
      icon: PencilLine,
      starter:
        'Draft a concise reply to this email. Keep the tone friendly and professional. Do not include greetings or signatures — just the body.',
      draft: true,
    },
    {
      id: 'draft_support_reply',
      label: 'Draft w/ code',
      icon: Code2,
      starter:
        'Draft a reply to this support question. Use the attached repositories to verify anything technical before drafting.',
      draft: true,
      autoAttachRepos: true,
    },
    {
      id: 'summarize',
      label: 'Ask',
      icon: MessageSquareQuote,
      starter: '',
    },
  ];

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    activeFeature = preset.id;
    draftFlowActive = Boolean(preset.draft);
    prompt = preset.starter;
    if (preset.autoAttachRepos && availableRepos.length > 0) {
      attachedRepoIds = new Set(availableRepos.map((r) => r.id));
    }
    setTimeout(() => textarea?.focus(), 0);
  };

  /**
   * Fresh session each time the panel opens. Clears prior prompt, output,
   * errors, and any cached loaded thread. The scope design treats each open
   * as a new session — no prior context carries over.
   */
  const resetSession = () => {
    error = null;
    output = '';
    prompt = '';
    lastFinishReason = null;
    loadedThread = null;
    loadedForMessageId = null;
    draftFlowActive = false;
    activeFeature = 'summarize';
    scopeOverride = null;
    toolActivity = [];
    attachedRepoIds = new Set();
    repoPickerOpen = false;
    sourcesRead = new Set();
    lastDraft = '';
    lastUserPrompt = '';
    regenHint = '';
    regenOpen = false;
  };

  /**
   * Regenerate the last draft with a user hint ("shorter", "more technical",
   * "drop the greeting"). Under the hood: continue the same conversation —
   * assistant says the prior draft, user says "please revise: <hint>", and
   * Claude produces a new draft with that guidance.
   */
  const regenerate = async () => {
    if (!lastDraft || streaming) return;
    const hint = regenHint.trim();
    if (!hint) {
      error = 'Add a hint (e.g. "shorter", "more technical", "drop the greeting").';
      return;
    }
    // Stash the original user prompt + prior draft and synthesize a
    // conversation follow-up. The new `prompt` becomes the revision ask.
    const followUp = `Please revise the draft above. Guidance: ${hint}`;
    prompt = followUp;
    regenOpen = false;
    regenHint = '';
    await run({ revisionOf: { previousDraft: lastDraft, originalPrompt: lastUserPrompt } });
  };

  const expandScope = (kind: 'participants' | 'mailbox') => {
    if (kind === 'mailbox') {
      const confirmed = window.confirm(
        'Expand to full mailbox?\n\nThe AI will be able to search every message in this account, including unrelated threads and other customers. This lasts only for this session — close and reopen the panel to go back to thread-only scope.',
      );
      if (!confirmed) return;
    }
    scopeOverride = kind;
  };

  const toggle = () => {
    open = !open;
    if (open) {
      resetSession();
      void refreshAvailableRepos();
      void loadSelectedBody();
      setTimeout(() => textarea?.focus(), 50);
    }
  };

  const toggleRepo = (id: string) => {
    const next = new Set(attachedRepoIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    attachedRepoIds = next;
  };

  const stop = async () => {
    if (cancelFn) await cancelFn();
    cancelFn = null;
  };

  interface RunOptions {
    revisionOf?: { previousDraft: string; originalPrompt: string };
  }

  const run = async (opts: RunOptions = {}) => {
    if (!prompt.trim() || streaming) return;
    error = null;
    output = '';
    lastFinishReason = null;

    const provider = await getProvider(PROVIDER_ID);
    if (!provider) {
      error = 'Configure an Anthropic API key in Settings → AI first.';
      return;
    }
    const apiKey = getProviderKey(PROVIDER_ID);
    if (!apiKey) {
      error = 'API key is locked or missing. Unlock the app or re-enter the key in Settings → AI.';
      return;
    }

    // Load the full thread if we have a thread id and haven't yet — this is
    // what makes Draft reply / Summarize see the conversation history, not
    // just the single visible message. We also pre-load when the user has
    // expanded to participants scope so the derived participant list is ready.
    if ((scope.kind === 'thread' && scope.threadId) || scope.kind === 'participants') {
      await loadFullThread();
    }

    // Re-read after possible load, since `scope` depends on loadedThread.
    const activeScope = scope;
    const scopeDetail =
      activeScope.kind === 'thread' && loadedThread
        ? `${loadedThread.messages.length} message${loadedThread.messages.length === 1 ? '' : 's'}`
        : activeScope.kind === 'participants'
          ? `${activeScope.participants.length} participants`
          : undefined;
    const announcement = buildScopeAnnouncement(activeScope.kind, scopeDetail);

    const systemPrompt = getPrompt(activeFeature).system;
    const userParts: string[] = [announcement];
    if (includeContext && context.hasContext) {
      userParts.push(context.promptText);
    }
    userParts.push(prompt.trim());

    // Egress preview — show the user what's about to leave the device.
    // Only when the user has opted in (Settings → AI preferences) and the
    // endpoint is non-loopback.
    const endpoint = provider.endpoint ?? 'https://api.anthropic.com';
    const isLoopback = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(endpoint);
    if ($aiPrefs.showEgressPreview && !isLoopback) {
      const ctxChars = includeContext && context.hasContext ? context.promptText.length : 0;
      const imageBytes = includeImages
        ? availableImages.summaries.reduce((n, s) => n + s.approxBytes, 0)
        : 0;
      const sections = [
        {
          label: 'System prompt',
          chars: systemPrompt.length,
          detail: `Instructions for ${activeFeature}, scope rules, injection preamble`,
        },
        {
          label: 'Context scope announcement',
          chars: announcement.length,
          detail: `Tells the model this is ${activeScope.kind} scope${scopeDetail ? ` (${scopeDetail})` : ''}`,
        },
        ...(ctxChars > 0
          ? [
              {
                label: 'Thread content',
                chars: ctxChars,
                detail: context.chip || 'Email thread wrapped in <email>…</email> delimiters',
              },
            ]
          : []),
        ...(imageBytes > 0
          ? [
              {
                label: 'Image attachments',
                chars: imageBytes,
                detail: `${availableImages.summaries.length} image${
                  availableImages.summaries.length === 1 ? '' : 's'
                }: ${availableImages.summaries.map((s) => s.filename).join(', ')}`,
              },
            ]
          : []),
        {
          label: 'Your prompt',
          chars: prompt.trim().length,
          detail: 'Free-text you typed in the panel',
        },
      ];
      const toolNames = getAllowedTools(activeScope).map((t) => t.name);
      const totalInput = sections.reduce((n, s) => n + s.chars, 0);
      const chosenModel = provider.model ?? 'claude-sonnet-4-6';
      const costInfo = estimateRequestCost(chosenModel, totalInput, 2048);
      const proceed = await new Promise<boolean>((resolve) => {
        pendingEgress = {
          endpoint,
          feature: activeFeature,
          scopeKind: activeScope.kind,
          scopeDetail,
          sections,
          toolNames,
          model: chosenModel,
          cost: {
            display: costInfo.display,
            input_tokens: costInfo.input_tokens,
            output_tokens: costInfo.output_tokens,
          },
          resolve,
        };
      });
      pendingEgress = null;
      if (!proceed) return;
    }

    streaming = true;
    toolActivity = [];
    const sessionId = newAuditSessionId();
    const emit = (ev: Omit<AuditEvent, 'session_id' | 'timestamp'>) =>
      void appendAuditEvent({
        ...ev,
        session_id: sessionId,
        timestamp: Date.now(),
      });
    emit({
      kind: 'chat_start',
      feature: activeFeature,
      provider_id: PROVIDER_ID,
      scope_kind: activeScope.kind,
      summary: `Started ${activeFeature} (${activeScope.kind} scope${
        activeScope.kind === 'thread' && loadedThread ? `, ${loadedThread.messages.length} msg` : ''
      })`,
    });
    const client = getAIWorkerClient();
    const handle = client.chat(
      {
        providerConfig: {
          id: PROVIDER_ID,
          kind: 'anthropic',
          endpoint: provider.endpoint,
          model: provider.model,
        },
        apiKey,
        options: {
          model: provider.model ?? 'claude-sonnet-4-6',
          messages: opts.revisionOf
            ? [
                { role: 'system' as const, content: systemPrompt },
                {
                  role: 'user' as const,
                  content: opts.revisionOf.originalPrompt || userParts.join('\n\n'),
                },
                { role: 'assistant' as const, content: opts.revisionOf.previousDraft },
                { role: 'user' as const, content: prompt.trim() },
              ]
            : [
                { role: 'system' as const, content: systemPrompt },
                {
                  role: 'user' as const,
                  // Use a content-block array when images are attached so the
                  // adapter emits Anthropic's vision `image` blocks alongside
                  // the text. Otherwise keep a plain string for simplicity.
                  content:
                    includeImages && availableImages.blocks.length > 0
                      ? [
                          ...availableImages.blocks,
                          { type: 'text' as const, text: userParts.join('\n\n') },
                        ]
                      : userParts.join('\n\n'),
                },
              ],
          max_tokens: 2048,
        },
        context: activeScope,
      },
      {
        onToken: (text: string) => {
          output += text;
        },
        onToolStart: (ev: { id: string; name: string; args?: unknown }) => {
          toolActivity = [...toolActivity, { id: ev.id, name: ev.name }];
          // Track repo files the model read — powers the Sources panel.
          const args = ev.args as { repo_id?: string; path?: string } | undefined;
          if (ev.name === 'read_repo_file' && args?.repo_id && args?.path) {
            const key = `${args.repo_id}:${args.path}`;
            if (!sourcesRead.has(key)) {
              const next = new Set(sourcesRead);
              next.add(key);
              sourcesRead = next;
            }
          }
        },
        onToolResult: (ev: { id: string; name: string; summary: string; ok: boolean }) => {
          toolActivity = toolActivity.map((a) =>
            a.id === ev.id ? { ...a, summary: ev.summary, ok: ev.ok } : a,
          );
          emit({
            kind: ev.ok ? 'tool_call' : 'tool_error',
            feature: activeFeature,
            tool_name: ev.name,
            scope_kind: activeScope.kind,
            summary: ev.summary,
          });
        },
        onError: (err: {
          user_message?: string;
          message?: string;
          code?: string;
          retryable?: boolean;
        }) => {
          const msg = err.user_message ?? err.message ?? 'Unknown error';
          // Transient errors during retry backoff surface briefly in the
          // tool activity area so the user knows why the stream is stalled,
          // but don't replace the persistent error banner.
          if (err.retryable) {
            toolActivity = [
              ...toolActivity,
              {
                id: `retry-${Date.now()}`,
                name: 'retry',
                summary: msg,
                ok: false,
              },
            ];
            return;
          }
          error = msg;
          emit({
            kind: 'chat_error',
            feature: activeFeature,
            provider_id: PROVIDER_ID,
            scope_kind: activeScope.kind,
            summary: msg,
            error_code: err.code,
          });
        },
        onDone: (d: { finish_reason: string }) => {
          lastFinishReason = d.finish_reason;
          // Capture the completed draft + original user prompt so the
          // Regenerate-with-hint flow can feed Claude the prior draft as
          // an assistant turn and ask for a revision.
          if (output.trim()) {
            lastDraft = output;
            if (!opts.revisionOf) {
              lastUserPrompt = userParts.join('\n\n');
            }
          }
          emit({
            kind: 'chat_done',
            feature: activeFeature,
            provider_id: PROVIDER_ID,
            scope_kind: activeScope.kind,
            summary: `Finished (${d.finish_reason})`,
          });
        },
      },
    );
    cancelFn = handle.cancel;

    try {
      await handle.finished;
    } finally {
      streaming = false;
      cancelFn = null;
    }
  };

  const openAsDraft = () => {
    if (!mailboxView?.composeModal?.open || !output.trim()) return;
    const prefill = buildReplyPrefill(currentMessage, output.trim());
    mailboxView.composeModal.open({
      to: prefill.to,
      subject: prefill.subject,
      body: prefill.body,
      inReplyTo: prefill.inReplyTo,
      aiDraft: true,
    });
  };

  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(output);
    } catch (err) {
      console.warn('[AskAI] clipboard copy failed', err);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Global open shortcut — ⌘⇧A (mac) / Ctrl⇧A elsewhere. Works from
    // anywhere in the app except inside editable fields so users can still
    // type the character.
    if (e.key === 'A' && e.shiftKey && (e.metaKey || e.ctrlKey) && !e.altKey) {
      const target = e.target as HTMLElement | null;
      const inEditable =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (!inEditable) {
        e.preventDefault();
        if (!open) {
          open = true;
          resetSession();
          void refreshAvailableRepos();
          void loadSelectedBody();
          setTimeout(() => textarea?.focus(), 50);
        } else {
          textarea?.focus();
        }
        return;
      }
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      if (streaming) void stop();
      else open = false;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !streaming && open) {
      e.preventDefault();
      void run();
    }
  };
</script>

<svelte:window onkeydown={onKeyDown} />

<button
  type="button"
  onclick={toggle}
  class="fixed bottom-4 right-4 z-[120] flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  aria-label={open ? 'Close Ask AI' : 'Open Ask AI'}
  title="Ask AI (preview)"
>
  {#if open}
    <X class="h-5 w-5" />
  {:else}
    <Sparkles class="h-5 w-5" />
  {/if}
</button>

{#if open}
  <!-- Dim the rest of the screen so the panel is unmistakable when it opens -->
  <div
    class="fixed inset-0 z-[110] bg-black/10"
    onclick={() => (open = false)}
    role="presentation"
  ></div>
  <div
    class="ai-panel-enter fixed bottom-[4.5rem] right-4 z-[120] flex max-h-[min(85vh,48rem)] w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border-2 border-primary/40 bg-background shadow-2xl"
  >
    <div class="flex items-center justify-between border-b px-4 py-2">
      <div class="flex items-center gap-2 text-sm font-medium">
        <Sparkles class="h-4 w-4" />
        Ask AI
        <span class="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide"
          >preview</span
        >
      </div>
      <button
        type="button"
        onclick={toggle}
        class="rounded p-1 text-muted-foreground hover:bg-muted"
        aria-label="Close"
      >
        <X class="h-4 w-4" />
      </button>
    </div>

    <!-- Preset row -->
    <div class="flex flex-wrap gap-1 border-b px-3 py-2">
      {#each PRESETS as preset (preset.label)}
        {@const Icon = preset.icon}
        <button
          type="button"
          onclick={() => applyPreset(preset)}
          class="flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs hover:bg-muted"
        >
          <Icon class="h-3 w-3" />
          {preset.label}
        </button>
      {/each}
    </div>

    <!-- Scope + context chip -->
    <div class="space-y-1 border-b bg-muted/30 px-3 py-1.5 text-xs">
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary"
          title="The AI can only reference messages inside this scope."
        >
          Scope: {scope.kind === 'thread'
            ? 'Thread only'
            : scope.kind === 'mailbox'
              ? 'Mailbox'
              : 'Participants'}
        </span>
        {#if loadingThread}
          <span class="text-muted-foreground">loading thread…</span>
        {/if}
        {#if !streaming}
          {#if scope.kind === 'thread'}
            <button
              type="button"
              onclick={() => expandScope('participants')}
              class="rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
              title="Let the AI search messages with the same participants as this thread"
            >
              Expand to participants
            </button>
            <button
              type="button"
              onclick={() => expandScope('mailbox')}
              class="rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
              title="Let the AI search the entire mailbox (confirmation required)"
            >
              Expand to mailbox
            </button>
          {:else}
            <button
              type="button"
              onclick={() => (scopeOverride = null)}
              class="rounded border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
              title="Restrict back to the current thread"
            >
              Reset to thread
            </button>
          {/if}
        {/if}
      </div>
      {#if context.hasContext}
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={includeContext} class="h-3.5 w-3.5 accent-primary" />
          <span class="text-muted-foreground">Include:</span>
          <span class="truncate font-medium">{context.chip}</span>
        </label>
      {:else}
        <div class="text-muted-foreground">No thread selected — responses are general.</div>
      {/if}

      {#if availableImages.blocks.length > 0}
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={includeImages} class="h-3.5 w-3.5 accent-primary" />
          <Image class="h-3 w-3 text-muted-foreground" />
          <span class="text-muted-foreground">Include</span>
          <span class="font-medium">
            {availableImages.blocks.length} image{availableImages.blocks.length === 1 ? '' : 's'}
          </span>
          <span class="text-muted-foreground">
            · {availableImages.summaries
              .map((s) => s.filename)
              .slice(0, 2)
              .join(', ')}{availableImages.summaries.length > 2
              ? `, +${availableImages.summaries.length - 2}`
              : ''}
          </span>
        </label>
      {/if}

      <!-- Repo chips -->
      {#if availableRepos.length > 0 || attachedRepos.length > 0}
        <div class="flex flex-wrap items-center gap-1 pt-1">
          <FolderGit2 class="h-3 w-3 text-muted-foreground" />
          {#if attachedRepos.length === 0}
            <span class="text-muted-foreground">No repositories attached</span>
          {:else}
            {#each attachedRepos as repo (repo.id)}
              <button
                type="button"
                onclick={() => toggleRepo(repo.id)}
                class="flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-primary hover:bg-primary/20"
                title="Detach this repository from this session"
              >
                <span class="font-mono">{repo.label}</span>
                <X class="h-3 w-3" />
              </button>
            {/each}
          {/if}
          {#if availableRepos.length > attachedRepos.length && !streaming}
            <button
              type="button"
              onclick={() => (repoPickerOpen = !repoPickerOpen)}
              class="rounded-full border px-2 py-0.5 text-muted-foreground hover:bg-muted"
              title="Attach a repository to this session"
            >
              + Attach repo
            </button>
          {/if}
        </div>
        {#if repoPickerOpen}
          <div class="mt-1 space-y-1 rounded-md border bg-background p-2">
            {#each availableRepos.filter((r) => !attachedRepoIds.has(r.id)) as repo (repo.id)}
              <button
                type="button"
                onclick={() => {
                  toggleRepo(repo.id);
                  repoPickerOpen = false;
                }}
                class="flex w-full items-start gap-2 rounded px-2 py-1 text-left hover:bg-muted"
              >
                <FolderGit2 class="mt-[2px] h-3 w-3 shrink-0 text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <div class="truncate font-medium">{repo.label}</div>
                  <div class="truncate font-mono text-[10px] text-muted-foreground">
                    {repo.path}
                  </div>
                </div>
              </button>
            {:else}
              <div class="text-muted-foreground">All repositories attached.</div>
            {/each}
          </div>
        {/if}
      {/if}
    </div>

    <div class="flex-1 space-y-3 overflow-y-auto p-4">
      {#if toolActivity.length > 0}
        <div class="space-y-1">
          {#each toolActivity as activity (activity.id)}
            <div class="flex items-start gap-2 rounded-md border bg-muted/20 px-2 py-1 text-xs">
              <span
                class="mt-[3px] inline-block h-2 w-2 rounded-full {activity.summary === undefined
                  ? 'animate-pulse bg-primary'
                  : activity.ok
                    ? 'bg-green-500'
                    : 'bg-destructive'}"
              ></span>
              <div class="flex-1">
                <div class="font-mono">{activity.name}</div>
                {#if activity.summary}
                  <div class="text-muted-foreground">{activity.summary}</div>
                {:else}
                  <div class="text-muted-foreground">running…</div>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}

      {#if output}
        <!-- Claude writes in markdown; renderMarkdownSafe passes through
             DOMPurify so any hostile HTML echoed from an email is stripped. -->
        <div class="ai-output rounded-md border bg-muted/30 p-3 text-sm">
          {@html renderedOutput}
        </div>
      {:else if streaming}
        <div class="text-sm text-muted-foreground">Waiting for first token…</div>
      {:else}
        <div class="text-sm text-muted-foreground">
          {#if context.hasContext && includeContext}
            Pick a preset or type a question about the selected thread.
          {:else}
            Pick a preset or ask anything. ⌘+Enter to send.
          {/if}
        </div>
      {/if}

      {#if error}
        <div
          class="flex items-start justify-between gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive"
        >
          <div class="flex-1">{error}</div>
          <button
            type="button"
            onclick={() => (error = null)}
            class="text-xs underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      {/if}

      {#if sourcesRead.size > 0}
        <div class="space-y-1 rounded-md border bg-muted/10 p-2 text-xs">
          <div class="flex items-center gap-1 text-muted-foreground">
            <FolderGit2 class="h-3 w-3" />
            <span class="font-medium">Sources used</span>
          </div>
          <ul class="space-y-0.5">
            {#each [...sourcesRead] as source (source)}
              {@const [repoId, path] = source.split(/:(.+)/, 2)}
              <li class="font-mono">
                <span class="text-muted-foreground">{repoId}:</span>{path}
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#if output && !streaming && !error}
        <div class="flex flex-wrap gap-2 pt-1">
          {#if showDraftHandoff}
            <Button size="sm" onclick={openAsDraft}>Open as draft</Button>
          {/if}
          <Button variant="outline" size="sm" onclick={copyOutput}>Copy</Button>
          <Button
            variant="outline"
            size="sm"
            onclick={() => (regenOpen = !regenOpen)}
            title="Regenerate with a hint (shorter, more technical, drop greeting, ...)"
          >
            Regenerate
          </Button>
        </div>

        {#if regenOpen}
          <div class="space-y-2 rounded-md border bg-muted/20 p-2 text-sm">
            <div class="text-xs text-muted-foreground">
              What should the revision change? Short hints work best.
            </div>
            <Textarea
              bind:value={regenHint}
              rows={2}
              placeholder="e.g. shorter · more technical · drop the greeting · keep the code reference"
              class="resize-none"
            />
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onclick={() => (regenOpen = false)}>Cancel</Button>
              <Button size="sm" onclick={regenerate} disabled={!regenHint.trim()}>
                Regenerate with this hint
              </Button>
            </div>
          </div>
        {/if}
      {/if}
    </div>

    <div class="border-t p-3">
      <Textarea
        bind:ref={textarea}
        bind:value={prompt}
        rows={3}
        placeholder="Type a question… (⌘+Enter to send, Esc to close)"
        disabled={streaming}
        class="resize-none"
      />
      <div class="mt-2 flex items-center justify-between gap-2">
        <div class="text-[11px] text-muted-foreground">
          {#if context.hasContext && includeContext}
            ~{Math.ceil(context.approximateBytes / 1000)}k chars of thread context attached
          {/if}
        </div>
        <div class="flex gap-2">
          {#if streaming}
            <Button variant="outline" size="sm" onclick={stop}>
              <Square class="mr-1 h-3 w-3 fill-current" />
              Stop
            </Button>
          {:else}
            <Button size="sm" onclick={run} disabled={!prompt.trim()}>Send</Button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if pendingEgress}
  <EgressPreviewModal
    endpoint={pendingEgress.endpoint}
    feature={pendingEgress.feature}
    scopeKind={pendingEgress.scopeKind}
    scopeDetail={pendingEgress.scopeDetail}
    sections={pendingEgress.sections}
    toolNames={pendingEgress.toolNames}
    model={pendingEgress.model}
    cost={pendingEgress.cost}
    onProceed={() => pendingEgress?.resolve(true)}
    onCancel={() => pendingEgress?.resolve(false)}
  />
{/if}

<style>
  .ai-output :global(p) {
    margin: 0 0 0.6em 0;
  }
  .ai-output :global(p:last-child) {
    margin-bottom: 0;
  }
  .ai-output :global(ul),
  .ai-output :global(ol) {
    margin: 0 0 0.6em 1.25em;
    padding: 0;
  }
  .ai-output :global(li) {
    margin-bottom: 0.25em;
  }
  .ai-output :global(code) {
    background: rgba(127, 127, 127, 0.15);
    padding: 0.1em 0.3em;
    border-radius: 3px;
    font-size: 0.9em;
  }
  .ai-output :global(pre) {
    background: rgba(127, 127, 127, 0.1);
    padding: 0.6em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0 0 0.6em 0;
  }
  .ai-output :global(pre code) {
    background: transparent;
    padding: 0;
  }
  .ai-output :global(h1),
  .ai-output :global(h2),
  .ai-output :global(h3),
  .ai-output :global(h4) {
    margin: 0.5em 0 0.3em 0;
    font-weight: 600;
  }
  .ai-output :global(blockquote) {
    border-left: 3px solid hsl(var(--muted-foreground, 0 0% 60%) / 0.4);
    padding-left: 0.8em;
    margin: 0 0 0.6em 0;
    color: hsl(var(--muted-foreground, 0 0% 60%));
  }
  .ai-output :global(a) {
    color: hsl(var(--primary, 199 89% 49%));
    text-decoration: underline;
  }
  .ai-panel-enter {
    animation: aiPanelEnter 160ms ease-out;
  }
  @keyframes aiPanelEnter {
    from {
      transform: translateY(12px) scale(0.96);
      opacity: 0;
    }
    to {
      transform: translateY(0) scale(1);
      opacity: 1;
    }
  }
</style>
