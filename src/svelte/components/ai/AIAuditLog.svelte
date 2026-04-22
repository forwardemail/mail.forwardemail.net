<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import Download from '@lucide/svelte/icons/download';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import Sparkles from '@lucide/svelte/icons/sparkles';
  import Wrench from '@lucide/svelte/icons/wrench';
  import {
    auditEvents,
    refreshAuditEvents,
    clearAudit,
    exportAuditAsJSON,
    type AuditEvent,
  } from '../../../stores/aiAuditStore';

  let busy = $state(false);

  onMount(() => {
    void refreshAuditEvents();
  });

  const doRefresh = async () => {
    busy = true;
    try {
      await refreshAuditEvents();
    } finally {
      busy = false;
    }
  };

  const doClear = async () => {
    const ok = window.confirm(
      'Clear the AI audit log?\n\nThis removes every locally-recorded AI request and tool call. Your provider keys, repositories, and chat drafts are not affected.',
    );
    if (!ok) return;
    busy = true;
    try {
      await clearAudit();
    } finally {
      busy = false;
    }
  };

  const doExport = () => {
    const json = exportAuditAsJSON($auditEvents);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ai-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const iconFor = (kind: AuditEvent['kind']) => {
    if (kind === 'chat_start') return Sparkles;
    if (kind === 'chat_done') return CheckCircle;
    if (kind === 'chat_error' || kind === 'tool_error') return AlertCircle;
    return Wrench;
  };

  const colorFor = (kind: AuditEvent['kind']): string => {
    if (kind === 'chat_error' || kind === 'tool_error') return 'text-destructive';
    if (kind === 'chat_done') return 'text-green-600 dark:text-green-500';
    return 'text-muted-foreground';
  };

  const relative = (ms: number): string => {
    const delta = Date.now() - ms;
    const m = Math.round(delta / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    return new Date(ms).toLocaleDateString();
  };
</script>

<div class="space-y-3">
  <div class="flex items-center justify-between">
    <div class="text-sm text-muted-foreground">
      {$auditEvents.length} event{$auditEvents.length === 1 ? '' : 's'} logged
      <span class="text-xs">(last 30 days, local only)</span>
    </div>
    <div class="flex gap-2">
      <Button variant="ghost" size="sm" onclick={doRefresh} disabled={busy}>
        <RefreshCw class="mr-1 h-4 w-4 {busy ? 'animate-spin' : ''}" />
        Refresh
      </Button>
      <Button
        variant="outline"
        size="sm"
        onclick={doExport}
        disabled={busy || $auditEvents.length === 0}
      >
        <Download class="mr-1 h-4 w-4" />
        Export JSON
      </Button>
      <Button
        variant="outline"
        size="sm"
        onclick={doClear}
        disabled={busy || $auditEvents.length === 0}
      >
        <Trash2 class="mr-1 h-4 w-4" />
        Clear
      </Button>
    </div>
  </div>

  {#if $auditEvents.length === 0}
    <div class="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
      Nothing here yet. Every chat request and tool call will be logged — no bodies, no full
      arguments, just summaries. The log is local to this device.
    </div>
  {:else}
    <ul class="divide-y rounded-md border bg-muted/10">
      {#each $auditEvents as event (event.timestamp + ':' + event.kind + ':' + event.session_id)}
        {@const Icon = iconFor(event.kind)}
        <li class="flex items-start gap-3 px-3 py-2 text-sm">
          <Icon class="mt-[3px] h-4 w-4 shrink-0 {colorFor(event.kind)}" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span class="font-mono">{event.kind}</span>
              {#if event.feature}
                <span>·</span>
                <span>{event.feature}</span>
              {/if}
              {#if event.scope_kind}
                <span>·</span>
                <span>scope: {event.scope_kind}</span>
              {/if}
              {#if event.tool_name}
                <span>·</span>
                <span class="font-mono">{event.tool_name}</span>
              {/if}
              <span class="ml-auto">{relative(event.timestamp)}</span>
            </div>
            <div class="truncate">{event.summary}</div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</div>
