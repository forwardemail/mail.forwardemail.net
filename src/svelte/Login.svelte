<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import * as Alert from '$lib/components/ui/alert';
  import * as Card from '$lib/components/ui/card';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Play from '@lucide/svelte/icons/play';
  import { Remote } from '../utils/remote';
  import { buildAliasAuthHeader } from '../utils/auth.ts';
  import { Local, Accounts } from '../utils/storage';
  import {
    activateDemoMode,
    isDemoMode,
  } from '../utils/demo-mode';
  import {
    DEMO_EMAIL,
    DEMO_ALIAS_AUTH,
  } from '../utils/demo-data';

  interface Props {
    onSuccess?: (path: string) => void;
  }

  let { onSuccess = () => {} }: Props = $props();

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

  // Check if user has at least one logged-in account
  const hasActiveSession = (): boolean => {
    const accounts = Accounts.getAll();
    return Array.isArray(accounts) && accounts.length > 0;
  };

  const goToMailbox = () => {
    window.location.href = '/mailbox';
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

    const authHeader = buildAliasAuthHeader(`${trimmedEmail}:${password}`);

    try {
      const result = await Remote.request(
        'Folders',
        {},
        { method: 'GET', skipAuth: true, headers: { Authorization: authHeader } },
      );

      if (!result) {
        submitError = 'Login failed. Please try again.';
        return;
      }

      Accounts.init();
      Accounts.add(trimmedEmail, { aliasAuth: `${trimmedEmail}:${password}` }, signMe);
      Accounts.setActive(trimmedEmail);

      // Store preference for next login
      Local.set('signMe', signMe ? '1' : '0');
      // Always set email in Local for API compatibility
      Local.set('email', trimmedEmail);
      Local.set('alias_auth', `${trimmedEmail}:${password}`);
      Local.remove('api_token');
      Local.remove('locale');

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
        submitError = (error as Error)?.message || 'Login failed. Please try again.';
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
  {#if hasActiveSession() && isAddingAccount}
    <Card.Root class="w-[92%] max-w-[480px] py-0">
      <Card.Content class="flex items-center gap-2 p-3">
        <Button variant="ghost" size="icon" onclick={goToMailbox} aria-label="Back to Mailbox">
          <ChevronLeft class="h-5 w-5" />
        </Button>
        <span class="text-sm font-semibold">Back to Mailbox</span>
      </Card.Content>
    </Card.Root>
  {/if}

  <Card.Root class="w-[92%] max-w-[480px]">
    <Card.Header class="items-center text-center">
      <div class="flex justify-center mb-4" aria-hidden="true">
        <img src="/icons/favicon.svg" alt="Forward Email logo" class="h-20 w-20" />
      </div>
      <Card.Title class="text-3xl font-bold">Webmail</Card.Title>
    </Card.Header>

    <Card.Content>
      <form onsubmit={(e) => { e.preventDefault(); handleSubmit(e); }} novalidate class="grid gap-4">
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

        <p class="text-center text-xs text-muted-foreground">
          Use your alias email and generated password to sign in.
        </p>

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
    </Card.Content>

    <Card.Footer class="flex-col gap-1 text-center text-sm text-muted-foreground">
      <span>
        Don't have an account?
        <a
          class="text-primary underline-offset-4 hover:underline"
          href="https://forwardemail.net"
          target="_blank"
          rel="noopener noreferrer"
        >
          Sign up
        </a>
      </span>
    </Card.Footer>
  </Card.Root>
</div>
