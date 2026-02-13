<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import * as Select from '$lib/components/ui/select';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import * as Alert from '$lib/components/ui/alert';
  import { Local } from '../utils/storage';
  import { Remote } from '../utils/remote';

  interface Props {
    onClose?: () => void;
  }

  let { onClose = () => {} }: Props = $props();

  let feedbackType = $state<'bug' | 'feature' | 'question' | 'other'>('bug');
  let subject = $state('');
  let description = $state('');
  let includeSystemInfo = $state(true);
  let includeLogs = $state(true);
  let submitting = $state(false);
  let submitError = $state('');
  let submitSuccess = $state(false);

  // Collect diagnostic data
  interface SystemInfo {
    userAgent: string;
    platform: string;
    language: string;
    screenResolution: string;
    viewportSize: string;
    online: boolean;
    cookiesEnabled: boolean;
    doNotTrack: string | null;
    timestamp: string;
    url: string;
    appVersion: string;
    account: string;
    activeEmail: string;
    storageQuota?: {
      usage: number | undefined;
      quota: number | undefined;
      percentUsed: string;
    };
    serviceWorker?: {
      active: boolean;
      scope?: string;
    };
  }

  interface LogEntry {
    timestamp?: string;
    message?: string;
    url?: string;
    error?: string;
    [key: string]: unknown;
  }

  let systemInfo = $state<SystemInfo>({} as SystemInfo);
  let recentLogs = $state<LogEntry[]>([]);
  let infoCollected = false;

  $effect(() => {
    // Only collect once to avoid infinite loop
    if (!infoCollected) {
      infoCollected = true;
      collectSystemInfo();
      collectRecentLogs();
    }
  });

  function collectSystemInfo() {
    const activeEmail = Local.get('email') || 'unknown';
    systemInfo = {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      screenResolution: `${window.screen.width}x${window.screen.height}`,
      viewportSize: `${window.innerWidth}x${window.innerHeight}`,
      online: navigator.onLine,
      cookiesEnabled: navigator.cookieEnabled,
      doNotTrack: navigator.doNotTrack,
      timestamp: new Date().toISOString(),
      url: window.location.href,
      appVersion: import.meta.env.VITE_PKG_VERSION || '0.0.0',
      account: activeEmail,
      activeEmail: activeEmail,
    };

    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then((estimate) => {
        systemInfo.storageQuota = {
          usage: estimate.usage,
          quota: estimate.quota,
          percentUsed: ((estimate.usage! / estimate.quota!) * 100).toFixed(2),
        };
      });
    }

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      systemInfo.serviceWorker = {
        active: true,
        scope: navigator.serviceWorker.controller.scriptURL,
      };
    } else {
      systemInfo.serviceWorker = { active: false };
    }
  }

  function collectRecentLogs() {
    try {
      const storedLogs = sessionStorage.getItem('app_logs');
      if (storedLogs) {
        const logs = JSON.parse(storedLogs);
        recentLogs = logs.slice(-50);
      }

      const dbErrors = sessionStorage.getItem('db_errors');
      if (dbErrors) {
        const errors = JSON.parse(dbErrors);
        recentLogs = [...recentLogs, ...errors.slice(-20)];
      }

      const apiErrors = sessionStorage.getItem('api_errors');
      if (apiErrors) {
        const errors = JSON.parse(apiErrors);
        recentLogs = [...recentLogs, ...errors.slice(-20)];
      }
    } catch (error) {
      console.error('Failed to collect logs:', error);
      recentLogs = [{ timestamp: new Date().toISOString(), error: (error as Error).message }];
    }
  }

  function sanitizeLogs(logs: LogEntry[]): LogEntry[] {
    return logs.map((log) => {
      const sanitized = { ...log };

      if (sanitized.message) {
        sanitized.message = sanitized.message
          .replace(/Bearer\s+[A-Za-z0-9-._~+/]+=*/g, 'Bearer [REDACTED]')
          .replace(/password[=:]\s*["']?[^"'\s]+["']?/gi, 'password=[REDACTED]')
          .replace(/api[_-]?key[=:]\s*["']?[^"'\s]+["']?/gi, 'api_key=[REDACTED]')
          .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
      }

      if (sanitized.url) {
        try {
          const url = new URL(sanitized.url);
          sanitized.url = url.pathname + url.search;
        } catch {
          // Keep as-is if URL parsing fails
        }
      }

      return sanitized;
    });
  }

  interface FeedbackData {
    type: string;
    subject: string;
    description: string;
    systemInfo: SystemInfo | null;
    logs: LogEntry[] | null;
    timestamp: string;
  }

  async function handleSubmit() {
    if (!description.trim()) {
      submitError = 'Please provide a description';
      return;
    }

    submitting = true;
    submitError = '';

    try {
      const feedbackData: FeedbackData = {
        type: feedbackType,
        subject: subject || getFeedbackSubject(),
        description,
        systemInfo: includeSystemInfo ? systemInfo : null,
        logs: includeLogs ? sanitizeLogs(recentLogs) : null,
        timestamp: new Date().toISOString(),
      };

      const emailBody = formatFeedbackEmail(feedbackData);

      const aliasAuth = Local.get('alias_auth') || '';
      const aliasEmail = aliasAuth.includes(':') ? aliasAuth.split(':')[0] : aliasAuth;
      const from = aliasEmail || Local.get('email') || 'webmail-feedback@forwardemail.net';

      const payload = {
        from,
        to: ['support@forwardemail.net'],
        subject: feedbackData.subject,
        text: emailBody,
        has_attachment: false,
      };

      await Remote.request('Emails', payload, { method: 'POST' });

      submitSuccess = true;
      setTimeout(() => {
        onClose();
      }, 5000);
    } catch (error) {
      console.error('Failed to submit feedback:', error);
      submitError = (error as Error).message || 'Failed to submit feedback. Please try again.';
    } finally {
      submitting = false;
    }
  }

  function getFeedbackSubject(): string {
    const typeLabels: Record<string, string> = {
      bug: 'Bug Report',
      feature: 'Feature Request',
      question: 'Question',
      other: 'Feedback',
    };
    return `Webmail ${typeLabels[feedbackType]}: ${description.slice(0, 50)}...`;
  }

  function formatFeedbackEmail(data: FeedbackData): string {
    const aliasAuth = Local.get('alias_auth') || '';
    const aliasEmail = aliasAuth.includes(':') ? aliasAuth.split(':')[0] : aliasAuth;
    const userEmail = aliasEmail || Local.get('email') || 'unknown';

    let email = `Webmail Feedback Submission
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Type: ${data.type.toUpperCase()}
From: ${userEmail}
Submitted: ${data.timestamp}

${data.subject ? `Subject: ${data.subject}\n` : ''}
Description:
${data.description}

`;

    if (data.systemInfo) {
      email += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
System Information
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

User Agent: ${data.systemInfo.userAgent}
Platform: ${data.systemInfo.platform}
Language: ${data.systemInfo.language}
Screen: ${data.systemInfo.screenResolution}
Viewport: ${data.systemInfo.viewportSize}
Online: ${data.systemInfo.online}
URL: ${data.systemInfo.url}
App Version: ${data.systemInfo.appVersion}
Active Email: ${data.systemInfo.activeEmail || data.systemInfo.account}

`;

      if (data.systemInfo.storageQuota) {
        email += `Storage Quota:
  Used: ${((data.systemInfo.storageQuota.usage || 0) / 1024 / 1024).toFixed(2)} MB
  Total: ${((data.systemInfo.storageQuota.quota || 0) / 1024 / 1024).toFixed(2)} MB
  Percent: ${data.systemInfo.storageQuota.percentUsed}%

`;
      }

      if (data.systemInfo.serviceWorker) {
        email += `Service Worker:
  Active: ${data.systemInfo.serviceWorker.active}
  ${data.systemInfo.serviceWorker.scope ? `Scope: ${data.systemInfo.serviceWorker.scope}` : ''}

`;
      }
    }

    if (data.logs && data.logs.length > 0) {
      email += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Recent Logs (Last ${data.logs.length} entries)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${data.logs.map((log) => JSON.stringify(log, null, 2)).join('\n\n')}
`;
    }

    email += `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
End of Report
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    return email;
  }

  function downloadDiagnostics() {
    const data = {
      systemInfo,
      logs: sanitizeLogs(recentLogs),
      timestamp: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `webmail-diagnostics-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const feedbackTypeOptions = [
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
          <div class="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-green-100 text-green-600">
            <LucideCheck  class="h-6 w-6" />
          </div>
          <h3 class="mb-2 text-lg font-semibold">Thank you for your feedback!</h3>
          <p class="text-muted-foreground">We've received your message and will get back to you soon.</p>
        </div>
      {:else}
        <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="grid gap-4">
          <div class="grid gap-2">
            <Label for="feedback-type">What kind of feedback?</Label>
            <Select.Root type="single" name="feedback-type" bind:value={feedbackType}>
              <Select.Trigger class="w-full">
                {feedbackTypeOptions.find(o => o.value === feedbackType)?.label || 'Select type'}
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

          <div class="grid gap-3">
            <div class="flex items-start gap-3">
              <Checkbox id="include-system" bind:checked={includeSystemInfo} />
              <div class="grid gap-1">
                <Label for="include-system" class="cursor-pointer">Include system information</Label>
                <p class="text-xs text-muted-foreground">
                  Helps us debug issues (browser, OS, screen size, storage usage)
                </p>
              </div>
            </div>

            <div class="flex items-start gap-3">
              <Checkbox id="include-logs" bind:checked={includeLogs} />
              <div class="grid gap-1">
                <Label for="include-logs" class="cursor-pointer">
                  Include recent error logs ({recentLogs.length} entries)
                </Label>
                <p class="text-xs text-muted-foreground">
                  Diagnostic data is sanitized to remove sensitive information
                </p>
              </div>
            </div>
          </div>

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
          Download Diagnostics
        </Button>
        <div class="flex gap-2">
          <Button variant="ghost" onclick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onclick={handleSubmit} disabled={submitting}>
            {submitting ? 'Sending...' : 'Send Feedback'}
          </Button>
        </div>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
