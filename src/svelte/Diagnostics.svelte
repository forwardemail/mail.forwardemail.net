<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import Mail from '@lucide/svelte/icons/mail';
  import CheckCircle2 from '@lucide/svelte/icons/check-circle-2';
  import XCircle from '@lucide/svelte/icons/x-circle';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import MinusCircle from '@lucide/svelte/icons/minus-circle';
  import {
    runDiagnostics,
    formatReportText,
    summarizeReport,
    type DiagnosticsReport,
  } from '../utils/diagnostics';

  let report = $state<DiagnosticsReport | null>(null);
  let running = $state(false);
  let copied = $state(false);

  const summary = $derived(report ? summarizeReport(report) : null);
  const reportText = $derived(report ? formatReportText(report) : '');
  const reportJson = $derived(report ? JSON.stringify(report, null, 2) : '');

  const run = async () => {
    if (running) return;
    running = true;
    copied = false;
    try {
      report = await runDiagnostics();
    } finally {
      running = false;
    }
  };

  const copy = async () => {
    if (!reportText) return;
    try {
      await navigator.clipboard.writeText(reportText);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // Clipboard API unavailable — fall back to a textarea selection.
      const ta = document.createElement('textarea');
      ta.value = reportText;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        copied = true;
        setTimeout(() => (copied = false), 2000);
      } catch {
        /* truly unsupported — user can select the pre block by hand */
      } finally {
        document.body.removeChild(ta);
      }
    }
  };

  /**
   * "Email this report" — opens the user's mail client with the report
   * pre-filled. On Tauri desktop with mailto: registered to us, this is also
   * a dogfood test: it round-trips through our own deep-link handler.
   */
  const emailReport = () => {
    if (!reportText) return;
    const subject = encodeURIComponent('Forward Email diagnostics report');
    const body = encodeURIComponent(reportText);
    window.location.href = `mailto:support@forwardemail.net?subject=${subject}&body=${body}`;
  };

  const statusClass = (s: string): string => {
    switch (s) {
      case 'pass':
        return 'text-green-600 dark:text-green-400';
      case 'fail':
        return 'text-red-600 dark:text-red-400';
      case 'warn':
        return 'text-amber-600 dark:text-amber-400';
      default:
        return 'text-muted-foreground';
    }
  };

  const StatusIcon = (s: string) => {
    if (s === 'pass') return CheckCircle2;
    if (s === 'fail') return XCircle;
    if (s === 'warn') return AlertTriangle;
    return MinusCircle;
  };

  onMount(() => {
    void run();
  });
</script>

<div class="mx-auto max-w-3xl p-6">
  <header class="mb-6 flex items-baseline justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold">Diagnostics</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Probes the network, storage, and OS-integration surfaces. Paste the report into a support
        email so we can triage faster.
      </p>
    </div>
    <Button variant="outline" size="sm" onclick={run} disabled={running}>
      <RefreshCw class="mr-1 h-3.5 w-3.5 {running ? 'animate-spin' : ''}" />
      {running ? 'Running…' : 'Run again'}
    </Button>
  </header>

  {#if summary}
    <div class="mb-4 flex flex-wrap gap-3 text-sm">
      <span class="rounded-full bg-green-500/10 px-3 py-1 text-green-700 dark:text-green-400"
        >{summary.pass} pass</span
      >
      {#if summary.fail > 0}
        <span class="rounded-full bg-red-500/10 px-3 py-1 text-red-700 dark:text-red-400"
          >{summary.fail} fail</span
        >
      {/if}
      {#if summary.warn > 0}
        <span class="rounded-full bg-amber-500/10 px-3 py-1 text-amber-700 dark:text-amber-400"
          >{summary.warn} warn</span
        >
      {/if}
      {#if summary.skip > 0}
        <span class="rounded-full bg-muted px-3 py-1 text-muted-foreground"
          >{summary.skip} skipped</span
        >
      {/if}
    </div>
  {/if}

  <ul class="divide-y rounded-md border bg-card">
    {#if !report && !running}
      <li class="p-4 text-sm text-muted-foreground">No results yet.</li>
    {/if}
    {#if running && !report}
      <li class="p-4 text-sm text-muted-foreground">Running probes…</li>
    {/if}
    {#each report?.results ?? [] as r (r.id)}
      {@const Icon = StatusIcon(r.status)}
      <li class="flex items-start gap-3 p-4">
        <Icon class="mt-0.5 h-4 w-4 flex-none {statusClass(r.status)}" />
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline justify-between gap-2">
            <span class="text-sm font-medium">{r.label}</span>
            <span class="text-xs text-muted-foreground">{r.durationMs}ms</span>
          </div>
          <p class="mt-0.5 break-words text-sm text-muted-foreground">{r.message}</p>
        </div>
      </li>
    {/each}
  </ul>

  {#if report}
    <section class="mt-6">
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <Button size="sm" onclick={copy}>
          <ClipboardCopy class="mr-1 h-3.5 w-3.5" />
          {copied ? 'Copied' : 'Copy report'}
        </Button>
        <Button variant="outline" size="sm" onclick={emailReport}>
          <Mail class="mr-1 h-3.5 w-3.5" />
          Email to support
        </Button>
      </div>
      <details class="rounded-md border bg-muted/30">
        <summary class="cursor-pointer px-3 py-2 text-sm font-medium">Report (text)</summary>
        <pre
          class="overflow-x-auto whitespace-pre-wrap break-words border-t p-3 text-xs">{reportText}</pre>
      </details>
      <details class="mt-2 rounded-md border bg-muted/30">
        <summary class="cursor-pointer px-3 py-2 text-sm font-medium">Report (JSON)</summary>
        <pre
          class="overflow-x-auto whitespace-pre-wrap break-words border-t p-3 text-xs">{reportJson}</pre>
      </details>
    </section>
  {/if}
</div>
