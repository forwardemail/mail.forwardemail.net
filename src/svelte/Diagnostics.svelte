<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { StatusLog, StatusLine } from '$lib/components/ui/status-log';
  import { MonoLabel } from '$lib/components/ui/mono-label';
  import { Badge } from '$lib/components/ui/badge';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy';
  import Mail from '@lucide/svelte/icons/mail';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import {
    runDiagnostics,
    formatReportText,
    summarizeReport,
    type DiagnosticsReport,
  } from '../utils/diagnostics';
  import {
    buildReportAttachments,
    sendSupportReport,
    SUPPORT_ADDRESS,
    type SendDeps,
  } from '../utils/support-report';
  import { openExternalUrl } from '../utils/external-links.js';
  import { isTauri } from '../utils/platform.js';

  interface Props {
    /** Opens the in-app composer with this prefill; false when it cannot */
    openComposer?: SendDeps['openComposer'];
  }

  let { openComposer }: Props = $props();

  let report = $state<DiagnosticsReport | null>(null);
  let running = $state(false);
  let copied = $state(false);
  let sending = $state(false);
  let sendNote = $state('');

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

  // The app's own log (redacted when written) helps with crashes the page
  // itself never sees. Not available on the web.
  const readAppLog = async () => {
    if (!isTauri) return '';
    try {
      const { readRecentLogs } = await import('../utils/tauri-bridge.js');
      return await readRecentLogs(65536);
    } catch {
      return '';
    }
  };

  const emailReport = async () => {
    if (!reportText || sending) return;
    sending = true;
    sendNote = '';
    try {
      const attachments = buildReportAttachments(reportJson, await readAppLog());
      const route = await sendSupportReport(reportText, attachments, {
        openComposer,
        share: navigator.share ? (data) => navigator.share(data) : undefined,
        canShare: navigator.canShare ? (data) => navigator.canShare(data) : undefined,
        openMailto: async (url) => {
          if (isTauri) await openExternalUrl(url);
          else globalThis.location.href = url;
        },
      });
      if (route === 'mailto') {
        sendNote = `Opened your mail app. If nothing appeared, copy the report and send it to ${SUPPORT_ADDRESS}.`;
      }
    } catch {
      sendNote = `Could not open a way to send it. Copy the report and send it to ${SUPPORT_ADDRESS}.`;
    } finally {
      sending = false;
    }
  };

  /** Diagnostics statuses map onto the StatusLog glyph vocabulary (§3.3). */
  const lineStatus = (s: string) =>
    s === 'pass' ? 'success' : s === 'fail' ? 'danger' : s === 'warn' ? 'caution' : 'info';

  /**
   * The page is a bare route with no chrome of its own, and the desktop app
   * has no browser back button, so without this the only way out was a
   * reload. Pop the entry that brought us here; when the page was opened
   * directly there is nothing to pop, so go to the mailbox instead.
   */
  const goBack = () => {
    // The in-app entry points stamp fromApp on their history entry. A deep
    // link or a reload has no such entry, and history.back() there would
    // leave the app (web) or do nothing (Tauri), so route to the mailbox.
    const state = globalThis.history.state as { fromApp?: boolean } | null;
    if (state?.fromApp) {
      globalThis.history.back();
      return;
    }
    globalThis.history.pushState({ route: 'mailbox' }, '', '/mailbox');
    globalThis.dispatchEvent(new PopStateEvent('popstate'));
  };

  onMount(() => {
    void run();
  });
</script>

<div class="mx-auto max-w-3xl p-6">
  <header class="mb-6 flex items-baseline justify-between gap-4">
    <div>
      <Button variant="ghost" size="sm" class="-ml-2 mb-2" onclick={goBack}>
        <ArrowLeft class="mr-1 h-4 w-4" />
        Back
      </Button>
      <h1 class="text-2xl font-semibold">Diagnostics</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Probes the network, storage, memory, and OS-integration surfaces. Email it to support with
        the button below, or copy the report into a message of your own.
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
        <span class="text-foreground font-semibold">{r.label}:</span>
        <span class="text-fg-muted">{r.message}</span>
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
        <Button variant="outline" size="sm" onclick={emailReport} disabled={sending}>
          <Mail class="mr-1 h-3.5 w-3.5" />
          {sending ? 'Preparing…' : 'Email to support'}
        </Button>
      </div>
      {#if sendNote}
        <p class="mb-2 text-sm text-muted-foreground" role="status">{sendNote}</p>
      {/if}
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
