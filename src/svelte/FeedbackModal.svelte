<script lang="ts">
  import { downloadFile } from '../utils/download';
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import * as Select from '$lib/components/ui/select';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import * as Alert from '$lib/components/ui/alert';
  import CheckIcon from '@lucide/svelte/icons/check';
  import CopyIcon from '@lucide/svelte/icons/copy';
  import { Local } from '../utils/storage';
  import { Remote } from '../utils/remote';
  import { isOnline } from '../utils/network-status';
  import { isTauri } from '../utils/platform';
  import { readRecentLogs } from '../utils/tauri-bridge';
  import {
    buildPayload,
    buildEmailSubject,
    buildEmailBody,
    generateCorrelationId,
    type FeedbackType,
    type FeedbackConsents,
    type FeedbackSources,
    type SystemInfo,
    type LogEntry,
  } from '../utils/feedback-payload';

  interface Props {
    onClose?: () => void;
  }

  let { onClose = () => {} }: Props = $props();

  let feedbackType = $state<FeedbackType>('bug');
  let subject = $state('');
  let description = $state('');

  // All consent toggles default to OFF — the user opts in per category, and
  // the preview pane shows exactly what each toggle adds before send.
  let consentSystem = $state(false);
  let consentJsErrors = $state(false);
  let consentNativeLogs = $state(false);
  let consentNetworkErrors = $state(false);
  let showPreview = $state(false);

  let submitting = $state(false);
  let submitError = $state('');
  let submitSuccess = $state(false);
  let copied = $state(false);

  // Correlation ID is generated once per modal open and stays stable so the
  // preview matches the submitted payload byte-for-byte.
  const correlationId = generateCorrelationId();

  let systemInfo = $state<SystemInfo>({});
  let jsErrors = $state<LogEntry[]>([]);
  let networkErrors = $state<LogEntry[]>([]);
  let nativeLogs = $state<string>('');
  let nativeLogsLoading = $state(false);
  let nativeLogsError = $state('');

  const showNativeLogsToggle = isTauri;

  $effect(() => {
    collectSystemInfo();
    collectJsErrors();
    collectNetworkErrors();
  });

  // Lazy-load native logs only when the user opts in (and only on Tauri).
  $effect(() => {
    if (consentNativeLogs && isTauri && !nativeLogs && !nativeLogsLoading) {
      nativeLogsLoading = true;
      nativeLogsError = '';
      readRecentLogs(65536)
        .then((tail: string) => {
          nativeLogs = tail || '(log file is empty)';
        })
        .catch((e: unknown) => {
          nativeLogsError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => {
          nativeLogsLoading = false;
        });
    }
  });

  function collectSystemInfo() {
    const activeEmail = Local.get('email') || 'unknown';
    const info: SystemInfo = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      online: isOnline(),
      appVersion: import.meta.env.VITE_PKG_VERSION || '0.0.0',
      activeEmail,
    };

    if (navigator.serviceWorker?.controller) {
      info.serviceWorker = {
        active: true,
        scope: navigator.serviceWorker.controller.scriptURL,
      };
    } else {
      info.serviceWorker = { active: false };
    }

    systemInfo = info;

    if (navigator.storage?.estimate) {
      navigator.storage.estimate().then((estimate) => {
        const usage = estimate.usage ?? 0;
        const quota = estimate.quota ?? 0;
        systemInfo = {
          ...systemInfo,
          storageQuota: {
            usage,
            quota,
            percentUsed: quota > 0 ? ((usage / quota) * 100).toFixed(2) : '0',
          },
        };
      });
    }
  }

  function collectJsErrors() {
    try {
      const stored = sessionStorage.getItem('app_logs');
      if (stored) jsErrors = (JSON.parse(stored) as LogEntry[]).slice(-50);
    } catch {
      jsErrors = [];
    }
  }

  function collectNetworkErrors() {
    try {
      const apiErrors = sessionStorage.getItem('api_errors');
      const dbErrors = sessionStorage.getItem('db_errors');
      const a: LogEntry[] = apiErrors ? JSON.parse(apiErrors) : [];
      const d: LogEntry[] = dbErrors ? JSON.parse(dbErrors) : [];
      networkErrors = [...a.slice(-20), ...d.slice(-10)];
    } catch {
      networkErrors = [];
    }
  }

  const consents = $derived<FeedbackConsents>({
    systemInfo: consentSystem,
    jsErrors: consentJsErrors,
    nativeLogs: consentNativeLogs,
    networkErrors: consentNetworkErrors,
  });

  const sources = $derived<FeedbackSources>({
    systemInfo,
    jsErrors,
    nativeLogs,
    networkErrors,
  });

  const previewPayload = $derived(
    buildPayload({
      type: feedbackType,
      subject,
      description,
      correlationId,
      consents,
      sources,
    }),
  );

  const previewJson = $derived(JSON.stringify(previewPayload, null, 2));

  async function copyCorrelationId() {
    try {
      await navigator.clipboard.writeText(correlationId);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // ignore — clipboard may be unavailable in some webview contexts
    }
  }

  async function handleSubmit() {
    if (!description.trim()) {
      submitError = 'Please provide a description';
      return;
    }

    submitting = true;
    submitError = '';

    try {
      const payload = previewPayload;
      const emailSubject = buildEmailSubject(payload, subject);
      const emailBody = buildEmailBody(payload);

      const aliasAuth = Local.get('alias_auth') || '';
      const aliasEmail = aliasAuth.includes(':') ? aliasAuth.split(':')[0] : aliasAuth;
      const from = aliasEmail || Local.get('email') || 'webmail-feedback@forwardemail.net';

      await Remote.request(
        'Emails',
        {
          from,
          to: ['support@forwardemail.net'],
          subject: emailSubject,
          text: emailBody,
          has_attachment: false,
        },
        { method: 'POST' },
      );

      submitSuccess = true;
      setTimeout(onClose, 5000);
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      submitError = (error as Error).message || 'Failed to submit feedback. Please try again.';
    } finally {
      submitting = false;
    }
  }

  function downloadDiagnostics() {
    downloadFile(previewJson, `webmail-feedback-${correlationId}.json`, 'application/json');
  }

  const feedbackTypeOptions: { value: FeedbackType; label: string }[] = [
    { value: 'bug', label: 'Bug Report' },
    { value: 'feature', label: 'Feature Request' },
    { value: 'question', label: 'Question' },
    { value: 'other', label: 'Other' },
  ];
</script>

<Dialog.Root open={true} onOpenChange={(open) => !open && onClose()}>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>Send Feedback</Dialog.Title>
    </Dialog.Header>

    <div class="py-4">
      {#if submitSuccess}
        <div class="flex flex-col items-center justify-center py-10 text-center">
          <div
            class="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600"
          >
            <CheckIcon class="h-6 w-6" />
          </div>
          <h3 class="mb-2 text-lg font-semibold">Thank you for your feedback!</h3>
          <p class="text-muted-foreground">
            Reference: <code class="font-mono">{correlationId}</code>
          </p>
          <p class="mt-2 text-muted-foreground">
            We've received your message and will get back to you soon.
          </p>
        </div>
      {:else}
        <form
          onsubmit={(e) => {
            e.preventDefault();
            handleSubmit();
          }}
          class="grid gap-4"
        >
          <div class="grid gap-2">
            <Label for="feedback-type">What kind of feedback?</Label>
            <Select.Root type="single" name="feedback-type" bind:value={feedbackType}>
              <Select.Trigger class="w-full">
                {feedbackTypeOptions.find((o) => o.value === feedbackType)?.label || 'Select type'}
              </Select.Trigger>
              <Select.Content>
                {#each feedbackTypeOptions as option}
                  <Select.Item value={option.value}>{option.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          <div class="grid gap-2">
            <Label for="feedback-subject">
              Subject <span class="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="feedback-subject"
              type="text"
              bind:value={subject}
              placeholder="Brief summary of your feedback"
              maxlength={100}
            />
          </div>

          <div class="grid gap-2">
            <Label for="feedback-description">
              Description <span class="text-destructive">*</span>
            </Label>
            <Textarea
              id="feedback-description"
              bind:value={description}
              placeholder="Please describe your feedback in detail..."
              rows={6}
              required
            />
            <p class="text-xs text-muted-foreground">
              {description.length}/2000 characters
              {#if feedbackType === 'bug'}
                - Please include steps to reproduce the issue
              {/if}
            </p>
          </div>

          <div class="grid gap-3 rounded-md border p-3">
            <p class="text-sm font-medium">Optional diagnostics — all off by default</p>
            <p class="text-xs text-muted-foreground">
              Pick what you're comfortable sharing. Sensitive values (tokens, email addresses, home
              directory paths) are redacted before send. Use "Preview" below to see exactly what
              will be transmitted.
            </p>

            <div class="flex items-start gap-3">
              <Checkbox id="consent-system" bind:checked={consentSystem} />
              <div class="grid gap-1">
                <Label for="consent-system" class="cursor-pointer">System information</Label>
                <p class="text-xs text-muted-foreground">
                  App version, browser, OS, viewport, storage usage.
                </p>
              </div>
            </div>

            <div class="flex items-start gap-3">
              <Checkbox id="consent-js-errors" bind:checked={consentJsErrors} />
              <div class="grid gap-1">
                <Label for="consent-js-errors" class="cursor-pointer">
                  Recent JS errors ({jsErrors.length})
                </Label>
                <p class="text-xs text-muted-foreground">
                  Last 50 unhandled errors and rejections from this session.
                </p>
              </div>
            </div>

            <div class="flex items-start gap-3">
              <Checkbox id="consent-network-errors" bind:checked={consentNetworkErrors} />
              <div class="grid gap-1">
                <Label for="consent-network-errors" class="cursor-pointer">
                  Network &amp; database errors ({networkErrors.length})
                </Label>
                <p class="text-xs text-muted-foreground">
                  Failed API calls and IndexedDB operations from this session.
                </p>
              </div>
            </div>

            {#if showNativeLogsToggle}
              <div class="flex items-start gap-3">
                <Checkbox id="consent-native-logs" bind:checked={consentNativeLogs} />
                <div class="grid gap-1">
                  <Label for="consent-native-logs" class="cursor-pointer">
                    Native log tail
                    {#if nativeLogsLoading}<span class="text-muted-foreground">(loading…)</span
                      >{/if}
                  </Label>
                  <p class="text-xs text-muted-foreground">
                    Last 64 KB of the desktop/mobile log file (updater, plugins, Rust panics).
                  </p>
                  {#if nativeLogsError}
                    <p class="text-destructive text-xs">{nativeLogsError}</p>
                  {/if}
                </div>
              </div>
            {/if}
          </div>

          <div class="rounded-md border bg-muted/30 p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs text-muted-foreground">Reference (for support)</span>
              <button
                type="button"
                onclick={copyCorrelationId}
                class="hover:text-foreground text-xs text-muted-foreground inline-flex items-center gap-1"
                title="Copy reference"
              >
                <code class="font-mono text-foreground">{correlationId}</code>
                {#if copied}
                  <CheckIcon class="h-3 w-3" />
                {:else}
                  <CopyIcon class="h-3 w-3" />
                {/if}
              </button>
            </div>
          </div>

          <details
            class="rounded-md border p-3"
            ontoggle={(e) => (showPreview = (e.currentTarget as HTMLDetailsElement).open)}
          >
            <summary class="cursor-pointer text-sm font-medium">
              Preview what will be sent
            </summary>
            {#if showPreview}
              <pre class="mt-2 max-h-64 overflow-auto rounded bg-background p-2 text-xs"><code
                  >{previewJson}</code
                ></pre>
            {/if}
          </details>

          {#if submitError}
            <Alert.Root variant="destructive">
              <Alert.Description>{submitError}</Alert.Description>
            </Alert.Root>
          {/if}
        </form>
      {/if}
    </div>

    {#if !submitSuccess}
      <Dialog.Footer class="flex-col gap-2 sm:flex-row sm:justify-between">
        <Button variant="outline" onclick={downloadDiagnostics} disabled={submitting}>
          Download Preview
        </Button>
        <div class="flex gap-2">
          <Button variant="ghost" onclick={onClose} disabled={submitting}>Cancel</Button>
          <Button onclick={handleSubmit} disabled={submitting}>
            {submitting ? 'Sending...' : 'Send Feedback'}
          </Button>
        </div>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
