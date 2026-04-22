<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Select from '$lib/components/ui/select';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import {
    saveProvider,
    getProvider,
    getProviderKey,
    type ProviderConfig,
  } from '../../../ai/keystore-web';
  import { getAIWorkerClient } from '../../../utils/ai-worker-client.js';
  import { isTauriDesktop } from '../../../utils/platform.js';
  import AIRepositoryList from './AIRepositoryList.svelte';
  import AIAuditLog from './AIAuditLog.svelte';
  import { aiEnabled, setAIEnabled } from '../../../stores/aiEnabledStore';
  import { hasProvider, refreshProviders } from '../../../stores/aiProviderStore';
  import { aiPrefs, setShowEgressPreview } from '../../../stores/aiPrefsStore';
  import { Checkbox } from '$lib/components/ui/checkbox';

  const PROVIDER_ID = 'anthropic';
  const DEFAULT_ENDPOINT = 'https://api.anthropic.com';
  const MODELS = [
    { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (recommended)' },
    { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (highest quality)' },
    { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fastest)' },
  ];

  let apiKey = $state('');
  let model = $state('claude-sonnet-4-6');
  let endpoint = $state(DEFAULT_ENDPOINT);
  let loading = $state(true);
  let saving = $state(false);
  let testing = $state(false);
  let saved = $state<ProviderConfig | null>(null);
  let testResult = $state<{ ok: boolean; error?: string } | null>(null);
  let message = $state<{ kind: 'success' | 'error'; text: string } | null>(null);

  const modelLabel = $derived(MODELS.find((m) => m.value === model)?.label ?? model);
  const hasKey = $derived(apiKey.trim().length > 0);

  onMount(async () => {
    try {
      const existing = await getProvider(PROVIDER_ID);
      if (existing) {
        saved = existing;
        model = existing.model ?? model;
        endpoint = existing.endpoint ?? endpoint;
        const existingKey = getProviderKey(PROVIDER_ID);
        if (existingKey) apiKey = existingKey;
      }
    } catch (err) {
      console.warn('[AISettings] load failed', err);
    } finally {
      loading = false;
    }
  });

  const handleSave = async () => {
    if (!hasKey) {
      message = { kind: 'error', text: 'Paste an API key first.' };
      return;
    }
    saving = true;
    message = null;
    testResult = null;
    try {
      saved = await saveProvider(
        {
          id: PROVIDER_ID,
          kind: 'anthropic',
          label: 'Anthropic Claude',
          endpoint: endpoint.trim() || DEFAULT_ENDPOINT,
          model,
        },
        apiKey.trim(),
      );
      await refreshProviders();
      message = { kind: 'success', text: 'Saved.' };
    } catch (err) {
      message = { kind: 'error', text: err instanceof Error ? err.message : String(err) };
    } finally {
      saving = false;
    }
  };

  const handleTest = async () => {
    if (!hasKey) {
      message = { kind: 'error', text: 'Paste an API key first.' };
      return;
    }
    testing = true;
    testResult = null;
    message = null;
    try {
      const client = getAIWorkerClient();
      const result = await client.validate({
        providerConfig: {
          id: PROVIDER_ID,
          kind: 'anthropic',
          endpoint: endpoint.trim() || DEFAULT_ENDPOINT,
          model,
        },
        apiKey: apiKey.trim(),
      });
      testResult = result as { ok: boolean; error?: string };
    } catch (err) {
      const asErr = err as { message?: string; user_message?: string };
      testResult = { ok: false, error: asErr.user_message ?? asErr.message ?? String(err) };
    } finally {
      testing = false;
    }
  };
</script>

<div class="space-y-4">
  <Card.Root>
    <Card.Header>
      <Card.Title>AI features (preview)</Card.Title>
      <Card.Description>
        Off by default. When enabled, an "Ask AI" action appears on messages and you can attach
        local git repositories so the AI can grep and read code when drafting replies. Nothing is
        sent to an AI provider until you configure one below and trigger a request.
      </Card.Description>
    </Card.Header>
    <Card.Content>
      <label class="flex items-start gap-3 text-sm">
        <Checkbox
          checked={$aiEnabled}
          onCheckedChange={(v) => setAIEnabled(v === true)}
          aria-label="Enable AI features"
        />
        <div class="space-y-1">
          <div class="font-medium">
            {$aiEnabled ? 'AI features are enabled' : 'Enable AI features'}
          </div>
          <p class="text-xs text-muted-foreground">
            Turning this off immediately hides every AI surface and stops new requests. Provider
            keys and repository registrations are preserved — flipping this back on restores your
            configuration exactly.
          </p>
        </div>
      </label>
    </Card.Content>
  </Card.Root>

  {#if !$aiEnabled}
    <p class="text-xs text-muted-foreground">
      Enable above to configure providers, attach repositories, and see the "Ask AI" action on
      messages.
    </p>
  {/if}

  {#if $aiEnabled}
    {#if !$hasProvider}
      <Alert.Root>
        <AlertCircle class="h-4 w-4" />
        <Alert.Description>
          Add an API key below to start using AI. Until a provider is configured, the "Ask AI"
          actions stay hidden from messages — you won't see anything in the mailbox yet.
        </Alert.Description>
      </Alert.Root>
    {/if}
    <Card.Root>
      <Card.Header>
        <Card.Title>Anthropic Claude</Card.Title>
        <Card.Description>
          Bring your own API key. Keys are stored locally and encrypted when app-lock is enabled.
        </Card.Description>
      </Card.Header>
      <Card.Content class="space-y-4">
        {#if loading}
          <div class="text-sm text-muted-foreground">Loading…</div>
        {:else}
          <div class="space-y-2">
            <Label for="ai-api-key">API key</Label>
            <Input
              id="ai-api-key"
              type="password"
              placeholder="sk-ant-…"
              bind:value={apiKey}
              autocomplete="off"
              spellcheck={false}
            />
            <p class="text-xs text-muted-foreground">
              Get one from <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                class="underline">console.anthropic.com</a
              >.
            </p>
          </div>

          <div class="space-y-2">
            <Label for="ai-model">Default model</Label>
            <Select.Root type="single" bind:value={model}>
              <Select.Trigger id="ai-model">{modelLabel}</Select.Trigger>
              <Select.Content>
                {#each MODELS as m (m.value)}
                  <Select.Item value={m.value}>{m.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>

          <div class="space-y-2">
            <Label for="ai-endpoint">Endpoint</Label>
            <Input id="ai-endpoint" type="text" bind:value={endpoint} />
            <p class="text-xs text-muted-foreground">
              Override for self-hosted proxies. Leave as default for Anthropic.
            </p>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button onclick={handleSave} disabled={saving || !hasKey}>
              {saving ? 'Saving…' : saved ? 'Update' : 'Save'}
            </Button>
            <Button variant="outline" onclick={handleTest} disabled={testing || !hasKey}>
              {testing ? 'Testing…' : 'Test connection'}
            </Button>
          </div>

          {#if message}
            <Alert.Root variant={message.kind === 'error' ? 'destructive' : 'default'}>
              {#if message.kind === 'error'}
                <AlertCircle class="h-4 w-4" />
              {:else}
                <CheckCircle class="h-4 w-4" />
              {/if}
              <Alert.Description>{message.text}</Alert.Description>
            </Alert.Root>
          {/if}

          {#if testResult}
            <Alert.Root variant={testResult.ok ? 'default' : 'destructive'}>
              {#if testResult.ok}
                <CheckCircle class="h-4 w-4" />
                <Alert.Description>Connected. Claude responded successfully.</Alert.Description>
              {:else}
                <AlertCircle class="h-4 w-4" />
                <Alert.Description
                  >Connection failed: {testResult.error ?? 'unknown error'}</Alert.Description
                >
              {/if}
            </Alert.Root>
          {/if}

          {#if saved}
            <p class="text-xs text-muted-foreground">
              Saved {new Date(saved.updatedAt).toLocaleString()}.
            </p>
          {/if}
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Repositories</Card.Title>
        <Card.Description>
          Attach local git repositories so the AI can grep and read code when drafting support
          replies. Files never leave your device unless you send a request to a remote provider;
          under local-only mode (coming soon) they stay on-device always.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        {#if isTauriDesktop}
          <AIRepositoryList />
        {:else}
          <div class="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
            Repository access requires the desktop app — web and mobile can't read local
            filesystems. Registration is still available here for testing, but the AI tools that use
            it won't work until you open the app in the desktop build.
          </div>
          <div class="mt-3">
            <AIRepositoryList />
          </div>
        {/if}
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Privacy</Card.Title>
        <Card.Description>Review what's going out before it leaves the device.</Card.Description>
      </Card.Header>
      <Card.Content>
        <label class="flex items-start gap-3 text-sm">
          <Checkbox
            checked={$aiPrefs.showEgressPreview}
            onCheckedChange={(v) => setShowEgressPreview(v === true)}
            aria-label="Show egress preview before sending"
          />
          <div class="space-y-1">
            <div class="font-medium">Preview every remote request</div>
            <p class="text-xs text-muted-foreground">
              When on, a modal shows the destination, what content is being sent, approximate token
              count, and which tools the model can call — <em>before</em> the request leaves. Off by default;
              turn on when you want to double-check what's happening.
            </p>
          </div>
        </label>
      </Card.Content>
    </Card.Root>

    <Card.Root>
      <Card.Header>
        <Card.Title>Audit log</Card.Title>
        <Card.Description>
          Every AI request and tool call is recorded locally for 30 days. No bodies, no full
          arguments — just summaries. Nothing leaves this device.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <AIAuditLog />
      </Card.Content>
    </Card.Root>

    <p class="text-xs text-muted-foreground">
      More providers, local models, and privacy controls arrive in later phases. This is an early
      preview — your feedback shapes what ships.
    </p>
  {/if}
</div>
