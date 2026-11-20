<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import * as Alert from '$lib/components/ui/alert';
  import * as Card from '$lib/components/ui/card';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Play from '@lucide/svelte/icons/play';
  import QrCodeIcon from '@lucide/svelte/icons/qr-code';
  import ScanPairingCode from './components/ScanPairingCode.svelte';
  import { isTauriMobile, isTauriDesktop } from '../utils/platform.js';
  import { shouldHidePurchaseLinks } from '../utils/store-policy.js';
  import { signInWithAliasPassword, signInWithImap, signInWithOAuth } from '../utils/alias-sign-in';
  import { listOAuthProviders, OAUTH_SERVERS, type OAuthProvider } from '../backends/oauth';
  import { probeOpaqueFrameSupport } from '../utils/frame-isolation-probe';
  import { imapSignInErrorText } from '../backends/imap-errors';
  import { mailEngineEnabled } from '../backends/engine-bridge';
  import {
    findMailSettings,
    suggestionSourceText,
    type MailSuggestion,
  } from '../backends/autoconfig';
  import { Local, Accounts } from '../utils/storage';
  import { activateDemoMode, isDemoMode } from '../utils/demo-mode';
  import { DEMO_EMAIL, DEMO_ALIAS_AUTH } from '../utils/demo-data';

  // App Store and Google Play builds hide billing and sign-up links (store-policy.js).
  const hidePurchaseLinks = shouldHidePurchaseLinks();

  interface Props {
    onSuccess?: (path: string) => void;
  }

  let { onSuccess = () => {} }: Props = $props();

  // Setting up PGP by hand is the worst part of onboarding, and it bites before
  // there is any Settings page to visit, so pairing has to be reachable from
  // the sign-in screen, not only from inside a signed-in session.
  let pairingScannerOpen = $state(false);

  // Client-side login rate limiting to prevent brute-force
  let loginAttempts = 0;
  let loginLockoutUntil = 0;
  const MAX_LOGIN_ATTEMPTS = 5;
  const LOGIN_LOCKOUT_MS = 30_000; // 30 seconds

  // Check if we're in "add account" mode via URL parameter
  const getIsAddingAccount = () =>
    new URLSearchParams(window.location.search).get('add_account') === 'true';
  let isAddingAccount = $state(getIsAddingAccount());

  // Prefill email from ?email= param (even in add-account mode), otherwise from storage
  const getInitialEmail = () => {
    const params = new URLSearchParams(window.location.search);
    const emailParam = params.get('email');
    if (emailParam) return emailParam;
    if (getIsAddingAccount()) return '';
    return Local.get('email') || '';
  };
  let email = $state(getInitialEmail());
  let password = $state('');

  // Signing in to a custom IMAP server. Desktop only, and only where the
  // email frame is isolated from the app: the mail engine can open network
  // connections, so it is not offered where an email could reach it.
  let customServer = $state(false);
  let customServerAllowed = $state<boolean | null>(isTauriDesktop ? null : false);
  let imapHost = $state('');
  let imapPort = $state('993');
  let imapSecurity = $state<'tls' | 'starttls'>('tls');
  let imapUsername = $state('');
  let imapAllowLocal = $state(false);

  // Sign-in through a provider's own page (Gmail, Microsoft 365). Offered
  // under the same rule as a custom server, and only for the providers this
  // build was given a client id for.
  let oauthProviders = $state<OAuthProvider[]>([]);
  let oauthWaiting = $state<OAuthProvider | null>(null);

  // A build that has the engine switched off offers nothing and says nothing
  // about it. The note about the operating system is for a build that has it.
  let engineEnabled = $state(false);

  if (isTauriDesktop) {
    mailEngineEnabled()
      .then(async (enabled) => {
        engineEnabled = enabled;
        if (!enabled) {
          customServerAllowed = false;
          return;
        }
        const supported = await probeOpaqueFrameSupport();
        customServerAllowed = supported;
        if (supported) oauthProviders = await listOAuthProviders();
      })
      .catch(() => {
        customServerAllowed = false;
      });
  }

  const handleOAuth = async (provider: OAuthProvider) => {
    if (submitRequest || oauthWaiting) return;
    oauthWaiting = provider;
    submitError = '';
    submitErrorAdditional = '';
    try {
      await signInWithOAuth(provider, { staySignedIn: signMe });
      onSuccess?.('/mailbox');
    } catch (error) {
      submitError = imapSignInErrorText(error);
    } finally {
      oauthWaiting = null;
    }
  };

  // Settings looked up for the typed address. The lookup runs only when the
  // user asks for it, because it tells Thunderbird's directory the domain.
  let lookupBusy = $state(false);
  let lookupNote = $state('');
  let lookupHint = $state('');
  let suggestion = $state<{ email: string; found: MailSuggestion } | null>(null);

  const handleFindSettings = async () => {
    const address = (email || '').trim();
    if (lookupBusy || submitRequest) return;
    lookupBusy = true;
    lookupNote = '';
    lookupHint = '';
    suggestion = null;
    try {
      const found = await findMailSettings(address);
      if (!found?.imap) {
        lookupNote = 'No settings are published for this address. Enter them below.';
        return;
      }
      imapHost = found.imap.host;
      imapPort = String(found.imap.port);
      imapSecurity = found.imap.security;
      imapUsername =
        found.imap.username && found.imap.username.toLowerCase() !== address.toLowerCase()
          ? found.imap.username
          : '';
      suggestion = { email: address, found };
      lookupNote = suggestionSourceText(found, address);
      if (found.signInWith) {
        const label = OAUTH_SERVERS[found.signInWith].label;
        lookupHint = oauthProviders.includes(found.signInWith)
          ? `${label} signs in through its own page. Use "Sign in with ${label}" below.`
          : `${label} usually refuses your normal password here. Use an app password if your account has one.`;
      }
    } catch (error) {
      // The engine's own words: not a full address, or too many lookups.
      lookupNote =
        (error as Error)?.message || 'The lookup could not be run. Enter the settings below.';
    } finally {
      lookupBusy = false;
    }
  };

  // The outgoing server that came with the settings in the form, as long as
  // the user has not pointed the form at a different address or server.
  const suggestedSmtpFor = (address: string) => {
    if (!suggestion?.found.smtp || !suggestion.found.imap) return undefined;
    if (suggestion.email.toLowerCase() !== address.toLowerCase()) return undefined;
    if (suggestion.found.imap.host !== imapHost.trim().toLowerCase()) return undefined;
    return suggestion.found.smtp;
  };

  const setImapSecurity = (value: string) => {
    const next = value === 'starttls' ? 'starttls' : 'tls';
    // Follow the usual port for the choice unless the user typed their own.
    if (imapPort === '993' || imapPort === '143' || !imapPort) {
      imapPort = next === 'tls' ? '993' : '143';
    }
    imapSecurity = next;
  };

  // Guard to prevent multiple event listener attachments
  let loginEffectInitialized = false;
  // Clear email field when navigating to add_account or after sign out
  $effect(() => {
    if (loginEffectInitialized) return;
    loginEffectInitialized = true;

    const clearFields = () => {
      email = '';
      password = '';
    };
    const syncAddAccountState = () => {
      isAddingAccount = getIsAddingAccount();
    };
    const handleLoginClearFields = () => {
      const params = new URLSearchParams(window.location.search);
      const emailParam = params.get('email');
      if (emailParam) {
        email = emailParam;
        password = '';
      } else {
        clearFields();
      }
      syncAddAccountState();
    };

    const handlePrefillEmail = (e: Event) => {
      email = (e as CustomEvent).detail || '';
      syncAddAccountState();
    };

    // Listen for custom event from navigate function
    window.addEventListener('login-clear-fields', handleLoginClearFields);

    // Listen for prefill event from bootstrap (account switching flow)
    window.addEventListener('login-prefill-email', handlePrefillEmail);

    // Listen for popstate (back/forward navigation)
    const handlePopState = () => {
      // Only act when the user actually lands on the login page (pathname '/').
      // Without this guard, every hash-change popstate inside /mailbox would
      // trigger onSuccess and clobber the URL.
      if (window.location.pathname !== '/') return;

      // If user is authenticated and lands on login via back-navigation,
      // redirect them to the mailbox (defense-in-depth alongside main.ts guard)
      if (!getIsAddingAccount() && hasActiveSession()) {
        onSuccess?.('/mailbox');
        return;
      }

      if (getIsAddingAccount()) {
        const params = new URLSearchParams(window.location.search);
        const emailParam = params.get('email');
        if (!emailParam) {
          clearFields();
        }
      }
      syncAddAccountState();
    };
    window.addEventListener('popstate', handlePopState);

    // Check on mount in case we navigated here with add_account
    if (getIsAddingAccount()) {
      const params = new URLSearchParams(window.location.search);
      if (!params.get('email')) {
        clearFields();
      }
    }
    syncAddAccountState();

    return () => {
      loginEffectInitialized = false;
      window.removeEventListener('login-clear-fields', handleLoginClearFields);
      window.removeEventListener('login-prefill-email', handlePrefillEmail);
      window.removeEventListener('popstate', handlePopState);
    };
  });

  let signMe = $state(Local.get('signMe') === '1');
  let submitRequest = $state(false);
  let submitError = $state('');
  let submitErrorAdditional = $state('');
  let demoLoading = $state(false);

  const submitButtonText = $derived(submitRequest ? 'Signing in...' : 'Sign In');

  // Check if user has at least one logged-in account with usable credentials.
  // Stale account entries (left over from a previous session whose credentials
  // were cleared) should not count — otherwise the "Try Demo" button is
  // blocked with a confusing "Please sign out" error even though the user
  // has no active session.
  const hasActiveSession = (): boolean => {
    const accounts = Accounts.getAll();
    if (!Array.isArray(accounts) || accounts.length === 0) return false;

    // At least one account must have usable credentials
    const hasCredentials = accounts.some(
      (a) => a.aliasAuth || a.apiKey || (a.kind === 'imap' && a.imap),
    );
    if (hasCredentials) return true;

    // Also check the shared credential keys (single-account legacy path)
    const aliasAuth = Local.get('alias_auth');
    const authToken = Local.get('authToken');
    return Boolean(aliasAuth || authToken);
  };

  const goToMailbox = () => {
    // Use the SPA callback (which navigates with replace) instead of a hard reload
    onSuccess?.('/mailbox');
  };

  /**
   * Activate demo mode — sets up fake credentials and navigates to mailbox.
   * No real API call is made; the demo interceptor in remote.js handles everything.
   */
  const handleTryDemo = () => {
    if (demoLoading || submitRequest) return;

    // Don't allow demo if user already has a real account logged in
    if (hasActiveSession() && !isDemoMode()) {
      submitError = 'Please sign out of your current account before trying the demo.';
      return;
    }

    demoLoading = true;
    submitError = '';
    submitErrorAdditional = '';

    try {
      // Activate demo mode (sets sessionStorage flag)
      activateDemoMode();

      // Set up fake credentials so the app thinks we are logged in
      Accounts.init();
      Accounts.add(DEMO_EMAIL, { aliasAuth: DEMO_ALIAS_AUTH }, false); // session-only
      Accounts.setActive(DEMO_EMAIL);

      Local.set('email', DEMO_EMAIL);
      Local.set('alias_auth', DEMO_ALIAS_AUTH);
      Local.remove('api_token');

      // Clear form fields
      email = '';
      password = '';

      // Navigate to mailbox
      onSuccess?.('/mailbox');
    } catch (error) {
      submitError = 'Failed to start demo. Please try again.';
      console.error('[demo] Failed to activate demo mode:', error);
    } finally {
      demoLoading = false;
    }
  };

  const handleSubmit = async (event?: Event) => {
    event?.preventDefault?.();
    if (submitRequest) return;

    // Rate limiting check
    if (loginLockoutUntil > Date.now()) {
      const remaining = Math.ceil((loginLockoutUntil - Date.now()) / 1000);
      submitError = `Too many login attempts. Please try again in ${remaining} seconds.`;
      return;
    }

    const trimmedEmail = (email || '').trim();
    if (!trimmedEmail || !password) {
      submitError = 'Please enter both email and password.';
      return;
    }

    submitRequest = true;
    submitError = '';
    submitErrorAdditional = '';

    try {
      if (customServer) {
        await signInWithImap(
          trimmedEmail,
          {
            host: imapHost.trim(),
            port: Number(imapPort),
            security: imapSecurity,
            username: imapUsername.trim() || trimmedEmail,
            password,
            allowLocal: imapAllowLocal,
          },
          { staySignedIn: signMe, suggestedSmtp: suggestedSmtpFor(trimmedEmail) },
        );
      } else {
        await signInWithAliasPassword(trimmedEmail, password, { staySignedIn: signMe });
      }

      // Clear form fields after successful login
      email = '';
      password = '';

      onSuccess?.('/mailbox');
    } catch (error) {
      loginAttempts++;
      if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
        loginLockoutUntil = Date.now() + LOGIN_LOCKOUT_MS;
        loginAttempts = 0;
        submitError = `Too many failed attempts. Please try again in ${LOGIN_LOCKOUT_MS / 1000} seconds.`;
      } else {
        if (customServer) {
          submitError = imapSignInErrorText(error);
        } else if ((error as { status?: number })?.status === 408) {
          submitError =
            'Sign in timed out while loading folders for this mailbox. Please try again.';
        } else {
          submitError = (error as Error)?.message || 'Login failed. Please try again.';
        }
        if ((error as { description?: string })?.description) {
          submitErrorAdditional = (error as { description: string }).description;
        }
      }
    } finally {
      submitRequest = false;
    }
  };
</script>

<div class="flex w-full flex-col items-center gap-3">
  {#if hasActiveSession()}
    <Card.Root class="w-[92%] max-w-[480px] py-0">
      <Card.Content class="flex items-center gap-2 p-3">
        <Button variant="ghost" size="icon" onclick={goToMailbox} aria-label="Back to Mailbox">
          <ChevronLeft class="h-5 w-5" />
        </Button>
        <span class="text-sm font-semibold">
          {isAddingAccount ? 'Back to Mailbox' : 'Return to Mailbox'}
        </span>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root class="w-[92%] max-w-[480px]">
    <Card.Header class="items-center text-center">
      <div class="flex justify-center mb-4" aria-hidden="true">
        <img src="/icons/favicon.svg" alt="Forward Email logo" class="h-20 w-20" />
      </div>
      <Card.Title class="text-3xl font-bold">Forward Email</Card.Title>
    </Card.Header>

    <Card.Content>
      <form
        onsubmit={(e) => {
          e.preventDefault();
          handleSubmit(e);
        }}
        novalidate
        class="grid gap-4"
      >
        <div class="grid gap-2">
          <Input
            type="email"
            placeholder="you@example.com"
            autocomplete="username"
            bind:value={email}
            required
          />
        </div>

        <div class="grid gap-2">
          <Input
            type="password"
            placeholder="Password"
            autocomplete="current-password"
            bind:value={password}
            required
          />
        </div>

        {#if customServer}
          <div class="grid gap-2" data-testid="imap-settings">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="imap-find-settings"
              disabled={lookupBusy || submitRequest || !(email || '').includes('@')}
              onclick={handleFindSettings}
            >
              {lookupBusy ? 'Looking…' : 'Find settings for this address'}
            </Button>
            <p class="text-xs text-muted-foreground" data-testid="imap-lookup-note">
              {lookupNote ||
                "Asks your mail domain and Thunderbird's public directory. The directory is sent your domain only, not your address."}
            </p>
            {#if lookupHint}
              <p class="text-xs text-foreground" data-testid="imap-lookup-hint">{lookupHint}</p>
            {/if}
            <Label for="imap-host" class="text-xs text-muted-foreground">IMAP server</Label>
            <Input
              id="imap-host"
              type="text"
              placeholder="imap.example.com"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              bind:value={imapHost}
              required
            />
            <div class="grid grid-cols-2 gap-2">
              <div class="grid gap-1">
                <Label for="imap-security" class="text-xs text-muted-foreground">Security</Label>
                <select
                  id="imap-security"
                  class="h-9 rounded-md border border-input bg-background px-2 text-sm"
                  value={imapSecurity}
                  onchange={(e) => setImapSecurity((e.currentTarget as HTMLSelectElement).value)}
                >
                  <option value="tls">SSL/TLS</option>
                  <option value="starttls">STARTTLS</option>
                </select>
              </div>
              <div class="grid gap-1">
                <Label for="imap-port" class="text-xs text-muted-foreground">Port</Label>
                <Input
                  id="imap-port"
                  type="text"
                  inputmode="numeric"
                  autocomplete="off"
                  bind:value={imapPort}
                  required
                />
              </div>
            </div>
            <Label for="imap-username" class="text-xs text-muted-foreground">
              Username (leave empty to use the email address)
            </Label>
            <Input
              id="imap-username"
              type="text"
              placeholder={email || 'you@example.com'}
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
              bind:value={imapUsername}
            />
            <div class="flex items-center gap-2">
              <Checkbox id="imap-local" bind:checked={imapAllowLocal} />
              <Label for="imap-local" class="cursor-pointer text-xs text-muted-foreground">
                This server is on my own network
              </Label>
            </div>
          </div>
          <p class="text-center text-xs text-muted-foreground">
            Mail only. Contacts, calendar and filters need a Forward Email account.
          </p>
        {:else}
          <p class="text-center text-xs text-muted-foreground">
            Use your alias email and generated password to sign in.
          </p>
        {/if}

        {#if customServerAllowed}
          <p class="text-center text-xs">
            <button
              type="button"
              class="text-fg-link underline-offset-4 hover:underline"
              data-testid="custom-imap-toggle"
              onclick={() => {
                customServer = !customServer;
                submitError = '';
                submitErrorAdditional = '';
              }}
            >
              {customServer ? 'Sign in with Forward Email instead' : 'Use a custom IMAP server'}
            </button>
          </p>
        {:else if isTauriDesktop && engineEnabled && customServerAllowed === false}
          <p class="text-center text-xs text-muted-foreground">
            Custom IMAP servers need a newer version of this operating system.
          </p>
        {/if}

        {#if oauthProviders.length}
          <div class="grid gap-2" data-testid="oauth-sign-in">
            {#each oauthProviders as provider (provider)}
              <Button
                type="button"
                variant="outline"
                class="w-full"
                disabled={submitRequest || oauthWaiting !== null}
                onclick={() => handleOAuth(provider)}
              >
                {oauthWaiting === provider
                  ? 'Finish signing in in your browser…'
                  : `Sign in with ${OAUTH_SERVERS[provider].label}`}
              </Button>
            {/each}
          </div>
        {/if}

        <div class="flex items-center gap-2">
          <Checkbox id="stay-signed" bind:checked={signMe} />
          <Label for="stay-signed" class="cursor-pointer text-sm">Stay signed in</Label>
        </div>

        <Button type="submit" class="w-full" disabled={submitRequest}>
          {submitButtonText}
        </Button>

        {#if submitError}
          <Alert.Root variant="destructive">
            <Alert.Description>
              {submitError}
              {#if submitErrorAdditional}
                <p class="mt-1 text-xs opacity-80">{submitErrorAdditional}</p>
              {/if}
            </Alert.Description>
          </Alert.Root>
        {/if}
      </form>

      <div class="relative my-4">
        <div class="absolute inset-0 flex items-center">
          <span class="w-full border-t"></span>
        </div>
        <div class="relative flex justify-center text-xs uppercase">
          <span class="bg-card px-2 text-muted-foreground">or</span>
        </div>
      </div>

      <Button
        variant="outline"
        class="w-full"
        disabled={demoLoading || submitRequest}
        onclick={handleTryDemo}
        data-testid="try-demo-btn"
      >
        <Play class="mr-2 h-4 w-4" />
        {demoLoading ? 'Loading demo...' : 'Try Demo'}
      </Button>
      <p class="mt-2 text-center text-xs text-muted-foreground">
        Explore the interface with sample data. No account required.
      </p>

      {#if isTauriMobile}
        <Button
          variant="outline"
          class="mt-4 w-full"
          disabled={submitRequest}
          onclick={() => (pairingScannerOpen = true)}
          data-testid="scan-pairing-btn"
        >
          <QrCodeIcon class="mr-2 h-4 w-4" />
          Scan a setup code
        </Button>
        <p class="mt-2 text-center text-xs text-muted-foreground">
          Use either QR code shown with your alias password, or Sync to another device in Forward
          Email on your computer to also bring PGP keys and settings.
        </p>
      {/if}
    </Card.Content>

    <!-- App Store and Google Play builds may not link to sign-up outside the store. -->
    {#if !hidePurchaseLinks}
      <Card.Footer class="flex-col gap-1 text-center text-sm text-muted-foreground">
        <span>
          Don't have an account?
          <a
            class="text-fg-link underline-offset-4 hover:underline"
            href="https://forwardemail.net"
            target="_blank"
            rel="noopener noreferrer"
          >
            Sign up
          </a>
        </span>
      </Card.Footer>
    {/if}
  </Card.Root>
</div>

{#if pairingScannerOpen}
  <ScanPairingCode
    onCancel={() => (pairingScannerOpen = false)}
    onDone={() => {
      pairingScannerOpen = false;
      // Same completion as a normal sign-in, which never reloads the page.
      // The reload this used to do froze the app on iOS (tao stopped
      // processing input after a custom-scheme reload) and could race
      // WKWebView's lazy localStorage persistence, losing the just-written
      // credentials and landing back on this screen.
      onSuccess?.('/mailbox');
    }}
  />
{/if}
