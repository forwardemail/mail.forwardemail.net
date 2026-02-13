<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { Readable, Unsubscriber } from 'svelte/store';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Card from '$lib/components/ui/card';
  import * as Avatar from '$lib/components/ui/avatar';
  import {
    accounts,
    addAccount,
    currentAccount,
    loadAccounts,
    signOut,
    switchAccount,
  } from '../stores/mailboxActions';
  import {
    loadProfileImage,
    loadProfileName,
    profileImage,
    profileName,
    setProfileImage,
    setProfileName,
  } from '../stores/settingsStore';

  interface Account {
    email: string;
  }

  interface Props {
    navigate?: (path: string) => void;
    active?: boolean | Readable<boolean>;
  }

  let { navigate = (path: string) => (window.location.href = path), active = false }: Props = $props();

  // Handle active as either a boolean or a store
  let isActive = $state(typeof active === 'boolean' ? active : false);
  let activeUnsub: Unsubscriber | null = null;
  let accountUnsub: Unsubscriber | null = null;
  let nameUnsub: Unsubscriber | null = null;
  let imageUnsub: Unsubscriber | null = null;

  let nameValue = $state('');
  let photoValue = $state('');
  let photoError = $state('');
  let lastAccount = '';
  let editingName = $state(false);
  const maxImageSize = 256;

  const getInitials = (name: string | undefined): string => {
    const trimmed = (name || '').trim();
    if (!trimmed) return '';
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }
    return trimmed.substring(0, 2).toUpperCase();
  };

  onMount(() => {
    if (active && typeof active === 'object' && 'subscribe' in active) {
      activeUnsub = active.subscribe((val: boolean) => { isActive = val; });
    }

    loadAccounts();

    accountUnsub = currentAccount.subscribe((acct) => {
      if (acct && acct !== lastAccount) {
        lastAccount = acct;
        loadProfileName(acct);
        loadProfileImage(acct);
      }
    });

    nameUnsub = profileName.subscribe((name) => {
      if (!editingName) {
        nameValue = name || '';
      }
    });

    imageUnsub = profileImage.subscribe((img) => {
      photoValue = img || '';
    });
  });

  onDestroy(() => {
    activeUnsub?.();
    accountUnsub?.();
    nameUnsub?.();
    imageUnsub?.();
  });

  const readAsDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read image'));
      reader.readAsDataURL(file);
    });

  const loadImage = (src: string): Promise<HTMLImageElement> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = src;
    });

  const cropToSquare = (img: HTMLImageElement): string => {
    const size = Math.min(img.width, img.height);
    const sx = Math.floor((img.width - size) / 2);
    const sy = Math.floor((img.height - size) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = maxImageSize;
    canvas.height = maxImageSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(img, sx, sy, size, size, 0, 0, maxImageSize, maxImageSize);
    return canvas.toDataURL('image/png', 0.9);
  };

  const handlePhotoSelect = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;
    photoError = '';
    if (!file.type.startsWith('image/')) {
      photoError = 'Please choose an image file.';
      target.value = '';
      return;
    }
    try {
      const dataUrl = await readAsDataUrl(file);
      const img = await loadImage(dataUrl);
      const cropped = cropToSquare(img);
      if (!cropped) {
        photoError = 'Unable to process image.';
      } else {
        setProfileImage(cropped, $currentAccount);
      }
    } catch (err) {
      photoError = (err as Error)?.message || 'Unable to upload image.';
    } finally {
      target.value = '';
    }
  };

  const removePhoto = () => {
    setProfileImage('', $currentAccount);
  };

  const commitName = () => {
    editingName = false;
    const trimmed = (nameValue || '').trim();
    if (trimmed !== nameValue) {
      nameValue = trimmed;
    }
    setProfileName(trimmed, $currentAccount);
  };

  const handleNameFocus = () => {
    editingName = true;
  };

  const handleNameKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.currentTarget as HTMLElement).blur();
    }
  };
</script>

{#if isActive}
  <div class="mx-auto flex max-w-[700px] flex-col gap-5 px-4 pt-2 pb-8 md:px-6 md:pt-3">
    <!-- Header -->
    <header class="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        onclick={() => navigate('/mailbox')}
        aria-label="Back to mailbox"
      >
        <LucideChevronLeft class="h-5 w-5" />
      </Button>
      <h1 class="text-xl font-semibold">Profile</h1>
    </header>

    <!-- Profile Card -->
    <Card.Root>
      <Card.Content class="flex gap-4 p-4 max-sm:flex-col max-sm:items-start">
        <label
          for="profile-photo-upload"
          class="group relative h-[72px] w-[72px] shrink-0 cursor-pointer overflow-hidden rounded-full border border-border bg-muted transition-colors hover:border-primary max-sm:h-16 max-sm:w-16"
        >
          {#if photoValue}
            <img src={photoValue} alt="Profile" class="h-full w-full object-cover" />
          {:else if getInitials(nameValue)}
            <span class="flex h-full w-full items-center justify-center text-xl font-bold text-muted-foreground">
              {getInitials(nameValue)}
            </span>
          {:else}
            <span class="flex h-full w-full items-center justify-center text-muted-foreground">
              <LucideUser class="h-8 w-8" />
            </span>
          {/if}
          <span class="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
            <LucideCamera class="h-8 w-8" />
          </span>
        </label>

        <div class="flex flex-1 flex-col gap-2">
          <Label for="profile-name" class="text-xs uppercase tracking-wider text-muted-foreground">
            Name
          </Label>
          <Input
            id="profile-name"
            type="text"
            placeholder="Add your name"
            bind:value={nameValue}
            onfocus={handleNameFocus}
            onblur={commitName}
            onkeydown={handleNameKeydown}
          />
          {#if photoValue}
            <div class="mt-1">
              <Button variant="ghost" size="sm" onclick={removePhoto}>
                Remove photo
              </Button>
            </div>
          {/if}
          {#if photoError}
            <p class="text-xs text-destructive">{photoError}</p>
          {/if}
          <input
            id="profile-photo-upload"
            class="hidden"
            type="file"
            accept="image/*"
            onchange={handlePhotoSelect}
          />
        </div>
      </Card.Content>
    </Card.Root>

    <!-- Accounts Section -->
    <section class="flex flex-col gap-3">
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Accounts</h2>
      <div class="flex flex-col gap-2.5">
        {#each $accounts as account}
          <Card.Root>
            <Card.Content class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3">
              <div class="flex items-center gap-3 min-w-0">
                <Avatar.Root class="h-9 w-9 shrink-0 border border-primary/20 bg-primary/10">
                  <Avatar.Fallback class="text-primary">
                    <LucideUser class="h-4 w-4" />
                  </Avatar.Fallback>
                </Avatar.Root>
                <div class="min-w-0">
                  <div class="font-semibold truncate">{(account as Account).email}</div>
                  <div class="text-xs text-muted-foreground">
                    {(account as Account).email === $currentAccount ? 'Active' : 'Available'}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2 sm:shrink-0">
                {#if (account as Account).email === $currentAccount}
                  <Button variant="destructive" size="sm" onclick={() => signOut()} class="flex-1 sm:flex-none">
                    <LucideLogOut class="mr-2 h-4 w-4" />
                    Sign out
                  </Button>
                {:else}
                  <Button variant="ghost" size="sm" onclick={() => switchAccount(account)} class="flex-1 sm:flex-none">
                    Switch
                  </Button>
                {/if}
              </div>
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
      <div class="flex justify-end">
        <Button variant="ghost" onclick={() => addAccount()}>
          <LucidePlus class="mr-2 h-4 w-4" />
          Add account
        </Button>
      </div>
    </section>

    <!-- Quick Links Section -->
    <section class="flex flex-col gap-3">
      <h2 class="text-xs font-medium uppercase tracking-wider text-muted-foreground">Quick links</h2>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-3">
        <Button variant="outline" class="h-11 justify-start" onclick={() => navigate('/contacts')}>
          <LucideBookUser class="mr-2 h-4 w-4" />
          Contacts
        </Button>
        <Button variant="outline" class="h-11 justify-start" onclick={() => navigate('/calendar')}>
          <LucideCalendar  class="mr-2 h-4 w-4" />
          Calendar
        </Button>
        <Button variant="outline" class="h-11 justify-start" onclick={() => navigate('/mailbox/settings')}>
          <LucideSettings  class="mr-2 h-4 w-4" />
          Settings
        </Button>
      </div>
    </section>
  </div>
{/if}
