<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { StatusLog, StatusLine } from '$lib/components/ui/status-log';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import { Badge } from '$lib/components/ui/badge';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import Mail from '@lucide/svelte/icons/mail';
  import {
    runDiagnostics,
    formatReportText,
    summarizeReport,
    type DiagnosticsReport,
  } from '../utils/diagnostics';
  import CameraSpike from './components/CameraSpike.svelte';

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

  /** Diagnostics statuses map onto the StatusLog glyph vocabulary (§3.3). */
  const lineStatus = (s: string) =>
    s === 'pass' ? 'success' : s === 'fail' ? 'danger' : s === 'warn' ? 'caution' : 'info';

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
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <Badge variant="success" mono>{summary.pass} pass</Badge>
      {#if summary.fail > 0}
        <Badge variant="destructive" mono>{summary.fail} fail</Badge>
      {/if}
      {#if summary.warn > 0}
        <Badge variant="caution" mono>{summary.warn} warn</Badge>
      {/if}
      {#if summary.skip > 0}
        <Badge variant="secondary" mono>{summary.skip} skipped</Badge>
      {/if}
    </div>
  {/if}

  <MonoLabel tick class="mb-2">Probe results</MonoLabel>

  <!-- Connection and integration diagnostics are exactly what the terminal
       block is for (§3.3): one status line per probe, glyph first, duration in
       tabular numerals so the column aligns. -->
  <StatusLog label="Diagnostics probe results">
    {#if !report && !running}
      <StatusLine status="info">No results yet.</StatusLine>
    {/if}
    {#if running && !report}
      <StatusLine status="active">Running probes…</StatusLine>
    {/if}
    {#each report?.results ?? [] as r (r.id)}
      <StatusLine status={lineStatus(r.status)} meta={`${r.durationMs}ms`}>
        <span class="text-foreground font-semibold">{r.label}</span>
        <span class="text-fg-muted"> — {r.message}</span>
      </StatusLine>
    {/each}
  </StatusLog>

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

  <CameraSpike />
</div>
