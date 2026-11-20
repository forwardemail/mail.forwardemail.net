<script lang="ts">
  /**
   * An account's own outgoing (SMTP) server.
   *
   * A Forward Email account sends through Forward Email unless one is saved
   * here. An account on a custom IMAP server cannot send until one is. The
   * settings are saved on this device with the account (smtp-account.ts) and
   * are checked against the server before they are saved.
   *
   * Desktop only, and only where the email frame is isolated from the app,
   * for the same reason as signing in to a custom IMAP server (Login.svelte).
   */
  import { untrack } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Card from '$lib/components/ui/card';
  import { isTauriDesktop } from '../../utils/platform.js';
  import { probeOpaqueFrameSupport } from '../../utils/frame-isolation-probe';
  import { imapSettingsFor, type MailSecurity } from '../../backends/imap-account';
  import {
    cleanSmtpSettings,
    saveSmtpSettings,
    smtpSettingsFor,
    type SmtpSettings,
  } from '../../backends/smtp-account';
  import { closeSmtpAccount, testSmtpSettings } from '../../backends/smtp-engine';
  import { imapSignInErrorText } from '../../backends/imap-errors';
  import { mailEngineEnabled } from '../../backends/engine-bridge';

  interface Props {
    account: string;
    onToast?: (message: string, type?: string) => void;
  }

  const { account, onToast }: Props = $props();

  let allowed = $state<boolean | null>(isTauriDesktop ? null : false);
  if (isTauriDesktop) {
    Promise.all([mailEngineEnabled(), probeOpaqueFrameSupport()])
      .then(([enabled, supported]) => {
        allowed = enabled && supported;
      })
      .catch(() => {
        allowed = false;
      });
  }

  let saved = $state<SmtpSettings | null>(null);
  let incoming = $state<SmtpSettings | null>(null);
  let editing = $state(false);
  let host = $state('');
  let port = $state('465');
  let security = $state<MailSecurity>('tls');
  let username = $state('');
  let password = $state('');
  let allowLocal = $state(false);
  let busy = $state<'' | 'test' | 'save'>('');
  let error = $state('');
  let tested = $state(false);

  // The saved password is never put back into the field. Leaving the field
  // empty keeps it, or for a new server on an IMAP account uses the incoming
  // one, which is the same password on most servers.
  const fallbackPassword = $derived(saved?.password || incoming?.password || '');

  const fillForm = () => {
    const from = saved;
    // A first guess for an IMAP account: imap.example.com is very often
    // smtp.example.com with the same sign-in.
    const guessedHost = incoming?.host.replace(/^imap\./i, 'smtp.') || '';
    host = from?.host ?? guessedHost;
    port = String(from?.port ?? 465);
    security = from?.security ?? 'tls';
    username = from?.username ?? incoming?.username ?? account;
    password = '';
    allowLocal = from?.allowLocal ?? incoming?.allowLocal ?? false;
    error = '';
    tested = false;
  };

  // Read again whenever the account on screen changes, and only then. The
  // body reads the state it has just written (fillForm reads `saved`), so it
  // runs untracked: tracked, every run would schedule the next one.
  $effect(() => {
    const shown = account;
    untrack(() => {
      saved = smtpSettingsFor(shown);
      incoming = imapSettingsFor(shown);
      editing = false;
      busy = '';
      fillForm();
    });
  });

  const setSecurity = (value: string) => {
    const next: MailSecurity = value === 'starttls' ? 'starttls' : 'tls';
    // Follow the usual port for the choice unless the user typed their own.
    if (port === '465' || port === '587' || !port) port = next === 'tls' ? '465' : '587';
    security = next;
    tested = false;
  };

  const formSettings = (): SmtpSettings | null =>
    cleanSmtpSettings({
      host,
      port: Number(port),
      security,
      username: username.trim() || account,
      password: password || fallbackPassword,
      allowLocal,
    });

  const check = async (): Promise<SmtpSettings | null> => {
    const settings = formSettings();
    if (!settings) {
      error = 'Enter the server name, port, username and password.';
      return null;
    }
    try {
      await testSmtpSettings(settings);
      return settings;
    } catch (err) {
      error = imapSignInErrorText(err);
      return null;
    }
  };

  const test = async () => {
    error = '';
    tested = false;
    busy = 'test';
    try {
      tested = Boolean(await check());
    } finally {
      busy = '';
    }
  };

  const save = async () => {
    error = '';
    tested = false;
    busy = 'save';
    try {
      const settings = await check();
      if (!settings) return;
      if (!saveSmtpSettings(account, settings)) {
        error = 'The settings could not be saved. Unlock the app and try again.';
        return;
      }
      // The engine still holds the old server under this account's handle.
      await closeSmtpAccount(account);
      saved = settings;
      editing = false;
      password = '';
      onToast?.(`${account} now sends through ${settings.host}`, 'success');
    } finally {
      busy = '';
    }
  };

  const remove = async () => {
    const consequence = incoming
      ? `${account} will not be able to send mail until another one is added.`
      : `${account} will send through Forward Email again.`;
    if (!confirm(`Remove the outgoing server? ${consequence}`)) return;
    if (!saveSmtpSettings(account, null)) {
      onToast?.('The settings could not be changed. Unlock the app and try again.', 'error');
      return;
    }
    await closeSmtpAccount(account);
    saved = null;
    editing = false;
    fillForm();
    onToast?.('Outgoing server removed', 'success');
  };
</script>

{#if allowed}
  <Card.Root data-testid="outgoing-server">
    <Card.Header>
      <Card.Title>Outgoing server</Card.Title>
      <Card.Description>
        {#if incoming}
          {account} is on a custom IMAP server, so it needs an SMTP server to send mail.
        {:else}
          {account} sends through Forward Email. Add an SMTP server to send through it instead.
        {/if}
      </Card.Description>
    </Card.Header>
    <Card.Content class="space-y-3">
      {#if saved && !editing}
        <div
          class="flex items-center justify-between gap-2 border border-border px-3 py-2"
          data-testid="outgoing-server-saved"
        >
          <div class="min-w-0">
            <p class="truncate font-mono text-sm">{saved.host}:{saved.port}</p>
            <p class="truncate text-sm text-muted-foreground">
              {saved.security === 'tls' ? 'SSL/TLS' : 'STARTTLS'}, signed in as {saved.username}
            </p>
          </div>
          <!-- Set by the provider's sign-in. There is no password to change. -->
          <div class="flex shrink-0 gap-2" hidden={saved.auth === 'xoauth2'}>
            <Button
              variant="outline"
              onclick={() => {
                fillForm();
                editing = true;
              }}
            >
              Change
            </Button>
            <Button variant="ghost" onclick={remove}>Remove</Button>
          </div>
        </div>
      {:else if editing || incoming}
        <form
          class="space-y-3"
          onsubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div class="space-y-1.5">
            <Label for="smtp-host">SMTP server</Label>
            <Input
              id="smtp-host"
              placeholder="smtp.example.com"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              bind:value={host}
              oninput={() => (tested = false)}
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label for="smtp-security">Security</Label>
              <select
                id="smtp-security"
                class="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={security}
                onchange={(e) => setSecurity((e.currentTarget as HTMLSelectElement).value)}
              >
                <option value="tls">SSL/TLS</option>
                <option value="starttls">STARTTLS</option>
              </select>
            </div>
            <div class="space-y-1.5">
              <Label for="smtp-port">Port</Label>
              <Input
                id="smtp-port"
                inputmode="numeric"
                autocomplete="off"
                bind:value={port}
                oninput={() => (tested = false)}
              />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label for="smtp-username">Username</Label>
            <Input
              id="smtp-username"
              placeholder={account}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              bind:value={username}
              oninput={() => (tested = false)}
            />
          </div>
          <div class="space-y-1.5">
            <Label for="smtp-password">Password</Label>
            <Input
              id="smtp-password"
              type="password"
              autocomplete="off"
              placeholder={saved
                ? 'Leave empty to keep the saved password'
                : incoming
                  ? 'Leave empty to use the incoming mail password'
                  : ''}
              bind:value={password}
              oninput={() => (tested = false)}
            />
          </div>
          <div class="flex items-center gap-2">
            <Checkbox id="smtp-local" bind:checked={allowLocal} />
            <Label for="smtp-local" class="cursor-pointer text-sm text-muted-foreground">
              This server is on my own network
            </Label>
          </div>
          {#if error}
            <p class="text-sm text-destructive" role="alert">{error}</p>
          {:else if tested}
            <p class="text-sm text-muted-foreground" role="status">
              The server accepted the sign-in.
            </p>
          {/if}
          <div class="flex flex-wrap gap-2">
            {#if editing}
              <Button
                type="button"
                variant="ghost"
                disabled={busy !== ''}
                onclick={() => {
                  editing = false;
                  fillForm();
                }}
              >
                Cancel
              </Button>
            {/if}
            <Button type="button" variant="outline" disabled={busy !== ''} onclick={test}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </Button>
            <Button type="submit" disabled={busy !== '' || !host.trim()}>
              {busy === 'save' ? 'Checking…' : 'Save'}
            </Button>
          </div>
        </form>
      {:else}
        <Button
          variant="outline"
          data-testid="outgoing-server-add"
          onclick={() => {
            fillForm();
            editing = true;
          }}
        >
          Add an SMTP server
        </Button>
      {/if}

      <p class="text-sm text-muted-foreground">
        The settings are checked when you save them and kept on this device only, protected by App
        Lock. Mail sent through your own server is not scheduled on a server, so a scheduled message
        goes out only while this app is open.
      </p>
    </Card.Content>
  </Card.Root>
{/if}
