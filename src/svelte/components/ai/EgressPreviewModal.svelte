<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import Globe from '@lucide/svelte/icons/globe';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';

  interface Section {
    label: string;
    /** Approximate character count. */
    chars: number;
    /** Short line describing what's in this section. */
    detail: string;
  }

  interface CostInfo {
    display: string;
    input_tokens: number;
    output_tokens: number;
  }

  interface Props {
    endpoint: string;
    feature: string;
    scopeKind: string;
    scopeDetail?: string;
    sections: Section[];
    toolNames: string[];
    model?: string;
    cost?: CostInfo;
    onProceed: () => void;
    onCancel: () => void;
  }

  let {
    endpoint,
    feature,
    scopeKind,
    scopeDetail,
    sections,
    toolNames,
    model,
    cost,
    onProceed,
    onCancel,
  }: Props = $props();

  const totalChars = $derived(sections.reduce((n, s) => n + s.chars, 0));
  const approxTokens = $derived(Math.ceil(totalChars / 4));

  const host = $derived.by(() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  });
</script>

<div
  class="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-4"
  role="dialog"
  aria-modal="true"
  aria-labelledby="egress-preview-title"
>
  <div class="w-full max-w-lg rounded-lg border bg-background shadow-2xl">
    <div class="flex items-center gap-2 border-b px-4 py-3">
      <ShieldAlert class="h-5 w-5 text-primary" />
      <h2 id="egress-preview-title" class="text-base font-semibold">About to send to {host}</h2>
    </div>

    <div class="space-y-3 p-4 text-sm">
      <div class="flex items-start gap-2 rounded-md border bg-muted/30 p-2 text-xs">
        <Globe class="mt-[3px] h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div class="flex-1">
          <div class="font-mono">{endpoint}</div>
          <div class="text-muted-foreground">
            Feature: <strong>{feature}</strong> · Scope: <strong>{scopeKind}</strong>{scopeDetail
              ? ` (${scopeDetail})`
              : ''}
          </div>
        </div>
      </div>

      <div>
        <div class="mb-1 text-xs font-medium text-muted-foreground">What's going out</div>
        <ul class="divide-y rounded-md border">
          {#each sections as section (section.label)}
            <li class="flex items-start justify-between gap-3 px-3 py-2">
              <div class="flex-1">
                <div class="font-medium">{section.label}</div>
                <div class="text-xs text-muted-foreground">{section.detail}</div>
              </div>
              <div class="whitespace-nowrap font-mono text-xs text-muted-foreground">
                {section.chars.toLocaleString()} chars
              </div>
            </li>
          {/each}
        </ul>
        <div class="mt-1 text-xs text-muted-foreground">
          Total ~{approxTokens.toLocaleString()} tokens · {totalChars.toLocaleString()} chars
          {#if cost}
            · est. cost <strong>{cost.display}</strong>
            {#if model}
              <span class="text-[10px]">({model})</span>
            {/if}
          {/if}
        </div>
      </div>

      {#if toolNames.length > 0}
        <div>
          <div class="mb-1 text-xs font-medium text-muted-foreground">
            Tools available to the model
          </div>
          <div class="flex flex-wrap gap-1">
            {#each toolNames as name (name)}
              <span class="rounded-full border px-2 py-0.5 font-mono text-xs">{name}</span>
            {/each}
          </div>
        </div>
      {/if}

      <div class="rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
        The model may call tools that read further data (messages, repository files). Those calls
        are logged in the audit log and are bounded by the declared scope.
      </div>
    </div>

    <div class="flex justify-end gap-2 border-t px-4 py-3">
      <Button variant="outline" onclick={onCancel}>Cancel</Button>
      <Button onclick={onProceed}>Send</Button>
    </div>
  </div>
</div>
