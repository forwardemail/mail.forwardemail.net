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
  import { getPrompt, type AIFeature } from '../../../ai/prompts/system';
  import { buildThreadContext, buildReplyPrefill } from '../../../ai/context/thread-context';
  import { selectedMessage, messageBody } from '../../../stores/messageStore';
  import type { Message } from '../../../types';

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
  let textarea: HTMLTextAreaElement | undefined = $state();
  let activeFeature = $state<AIFeature>('summarize');
  let includeContext = $state(true);

  let currentMessage = $state<Message | null>(null);
  let currentBody = $state<string>('');

  const unsubMsg = selectedMessage.subscribe((m) => {
    currentMessage = m;
  });
  const unsubBody = messageBody.subscribe((b) => {
    currentBody = b || '';
  });
  onDestroy(() => {
    unsubMsg();
    unsubBody();
  });

  let draftFlowActive = $state(false);

  const context = $derived(
    buildThreadContext(activeFeature, { message: currentMessage, body: currentBody }),
  );
  // Draft-reply flow enables the Compose handoff button. Summarize / Ask don't.
  const showDraftHandoff = $derived(
    Boolean(
      mailboxView?.composeModal?.open && output.trim().length > 0 && !streaming && draftFlowActive,
    ),
  );

  const PRESETS: {
    id: AIFeature | 'ask';
    label: string;
    icon: typeof Sparkles;
    starter: string;
    draft?: boolean;
  }[] = [
    {
      id: 'summarize',
      label: 'Summarize',
      icon: FileText,
      starter: 'Summarize this thread in 2-3 sentences. Lead with the outcome if there is one.',
    },
    {
      id: 'summarize' as AIFeature,
      label: 'Draft reply',
      icon: PencilLine,
      starter:
        'Draft a concise reply to this email. Keep the tone friendly and professional. Do not include greetings or signatures — just the body.',
      draft: true,
    },
    {
      id: 'summarize' as AIFeature,
      label: 'Ask',
      icon: MessageSquareQuote,
      starter: '',
    },
  ];

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    activeFeature = preset.id as AIFeature;
    draftFlowActive = Boolean(preset.draft);
    prompt = preset.starter;
    setTimeout(() => textarea?.focus(), 0);
  };

  const toggle = () => {
    open = !open;
    if (open) {
      error = null;
      setTimeout(() => textarea?.focus(), 50);
    }
  };

  const stop = async () => {
    if (cancelFn) await cancelFn();
    cancelFn = null;
  };

  const run = async () => {
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

    const systemPrompt = getPrompt(activeFeature).system;
    const userParts: string[] = [];
    if (includeContext && context.hasContext) {
      userParts.push(context.promptText);
    }
    userParts.push(prompt.trim());

    streaming = true;
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
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userParts.join('\n\n') },
          ],
          max_tokens: 2048,
        },
      },
      {
        onToken: (text: string) => {
          output += text;
        },
        onError: (err: { user_message?: string; message?: string }) => {
          error = err.user_message ?? err.message ?? 'Unknown error';
        },
        onDone: (d: { finish_reason: string }) => {
          lastFinishReason = d.finish_reason;
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
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      if (streaming) void stop();
      else open = false;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !streaming) {
      e.preventDefault();
      void run();
    }
  };
</script>

<svelte:window onkeydown={onKeyDown} />

<button
  type="button"
  onclick={toggle}
  class="fixed bottom-4 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  <div
    class="fixed bottom-20 right-4 z-40 flex max-h-[min(80vh,42rem)] w-[min(30rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-lg border bg-background shadow-2xl"
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

    <!-- Context chip -->
    {#if context.hasContext}
      <div class="border-b bg-muted/30 px-3 py-1.5 text-xs">
        <label class="flex items-center gap-2">
          <input type="checkbox" bind:checked={includeContext} class="h-3.5 w-3.5 accent-primary" />
          <span class="text-muted-foreground">Include thread:</span>
          <span class="font-medium truncate">{context.chip}</span>
        </label>
      </div>
    {/if}

    <div class="flex-1 space-y-3 overflow-y-auto p-4">
      {#if output}
        <div class="whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{output}</div>
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
          class="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-sm text-destructive"
        >
          {error}
        </div>
      {/if}

      {#if output && !streaming && !error}
        <div class="flex flex-wrap gap-2 pt-1">
          {#if showDraftHandoff}
            <Button size="sm" onclick={openAsDraft}>Open as draft</Button>
          {/if}
          <Button variant="outline" size="sm" onclick={copyOutput}>Copy</Button>
        </div>
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
