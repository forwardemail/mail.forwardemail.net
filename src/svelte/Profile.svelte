<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { Readable, Unsubscriber } from 'svelte/store';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import * as Card from '$lib/components/ui/card';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import User from '@lucide/svelte/icons/user';
  import Plus from '@lucide/svelte/icons/plus';
  import LogOut from '@lucide/svelte/icons/log-out';
  import BookUser from '@lucide/svelte/icons/book-user';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import ListTodo from '@lucide/svelte/icons/list-todo';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import Camera from '@lucide/svelte/icons/camera';
  import { pickFiles } from '../utils/file-picker';
  import { isTauriDesktop } from '../utils/platform.js';
  import {
    accounts,
    currentAccount,
    loadAccounts,
    switchAccount,
    addAccount,
    signOut,
  } from '../stores/mailboxActions';
  import {
    profileName,
    profileImage,
    loadProfileName,
    loadProfileImage,
    setProfileName,
    setProfileImage,
  } from '../stores/settingsStore';

  interface Account {
    email: string;
  }

  interface Props {
    navigate?: (path: string) => void;
    active?: boolean | Readable<boolean>;
  }

  let { navigate = (path: string) => (window.location.href = path), active = false }: Props =
    $props();

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
      activeUnsub = active.subscribe((val: boolean) => {
        isActive = val;
      });
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

  const handlePhotoSelect = async (eventOrFiles: Event | File[]) => {
    let file: File | undefined;
    let target: HTMLInputElement | null = null;
    if (Array.isArray(eventOrFiles)) {
      file = eventOrFiles[0];
    } else {
      target = eventOrFiles.target as HTMLInputElement;
      file = target?.files?.[0];
    }
    if (!file) return;
    photoError = '';
    if (!file.type.startsWith('image/')) {
      photoError = 'Please choose an image file.';
      if (target) target.value = '';
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
      if (target) target.value = '';
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
  <!-- Header -->
  <div
    class="flex h-14 items-center gap-3 px-4"
    style="padding-top: env(safe-area-inset-top, 0px); box-sizing: content-box;"
  >
    <Button
      variant="ghost"
      size="icon"
      onclick={() => navigate('/mailbox')}
      aria-label="Back to mailbox"
    >
      <ChevronLeft class="h-5 w-5" />
    </Button>
    <div class="flex flex-col">
      <h1 class="text-lg font-semibold">Profile</h1>
      {#if $currentAccount}
        <span class="text-xs text-muted-foreground">{$currentAccount}</span>
      {/if}
    </div>
  </div>

  <!-- Content -->
  <div class="p-4 md:p-6">
    <div class="mx-auto max-w-4xl space-y-6">
      <!-- Profile Card -->
      <Card.Root>
        <Card.Header>
          <Card.Title>Profile</Card.Title>
          <Card.Description>How your name and photo appear in this app.</Card.Description>
        </Card.Header>
        <Card.Content class="flex gap-4 max-sm:flex-col max-sm:items-start">
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <label
            for="profile-photo-upload"
            class="group relative h-12 w-12 shrink-0 cursor-pointer overflow-hidden rounded-full border border-border bg-muted transition-colors hover:border-primary"
            onclick={async (e) => {
              if (!isTauriDesktop) return;
              e.preventDefault();
              const files = await pickFiles({ accept: 'image/*' });
              if (files) handlePhotoSelect(files);
            }}
          >
            {#if photoValue}
              <img src={photoValue} alt="Profile" class="h-full w-full object-cover" />
            {:else if getInitials(nameValue)}
              <span
                class="flex h-full w-full items-center justify-center text-sm font-semibold text-muted-foreground"
              >
                {getInitials(nameValue)}
              </span>
            {:else}
              <span class="flex h-full w-full items-center justify-center text-muted-foreground">
                <User class="h-5 w-5" />
              </span>
            {/if}
            <span
              class="absolute inset-0 flex items-center justify-center bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100"
            >
              <Camera class="h-5 w-5" />
            </span>
          </label>

          <div class="flex flex-1 flex-col gap-2">
            <Label
              for="profile-name"
              class="text-xs uppercase tracking-wider text-muted-foreground"
            >
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
                <Button variant="ghost" size="sm" onclick={removePhoto}>Remove photo</Button>
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

      <!-- Accounts Card -->
      <Card.Root>
        <Card.Header>
          <Card.Title>Accounts</Card.Title>
          <Card.Description>Manage linked mailboxes on this device.</Card.Description>
        </Card.Header>
        <Card.Content class="space-y-3">
          {#each $accounts as account}
            <div
              class="flex items-center justify-between border border-border p-3 {(
                account as Account
              ).email === $currentAccount
                ? 'bg-primary/5'
                : ''}"
            >
              <div class="flex min-w-0 items-center gap-3">
                <User class="h-5 w-5 shrink-0 text-muted-foreground" />
                <div class="min-w-0">
                  <div class="truncate font-medium">{(account as Account).email}</div>
                  <div class="text-xs text-muted-foreground">
                    {(account as Account).email === $currentAccount
                      ? 'Active account'
                      : 'Available'}
                  </div>
                </div>
              </div>
              {#if (account as Account).email === $currentAccount}
                <Button variant="destructive" size="sm" onclick={() => signOut()}>
                  <LogOut class="mr-2 h-4 w-4" />
                  Sign out
                </Button>
              {:else}
                <Button variant="ghost" size="sm" onclick={() => switchAccount(account)}>
                  Switch to
                </Button>
              {/if}
            </div>
          {/each}
          <Button variant="outline" class="mt-4" onclick={() => addAccount()}>
            <Plus class="mr-2 h-4 w-4" />
            Add account
          </Button>
        </Card.Content>
      </Card.Root>

      <!-- Quick Links Card -->
      <Card.Root>
        <Card.Header>
          <Card.Title>Quick links</Card.Title>
        </Card.Header>
        <Card.Content class="flex flex-col gap-1">
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => navigate('/contacts')}
          >
            <BookUser class="h-4 w-4" />
            Contacts
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => navigate('/calendar')}
          >
            <CalendarIcon class="h-4 w-4" />
            Calendar
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => navigate('/calendar#tasks')}
          >
            <ListTodo class="h-4 w-4" />
            Tasks
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-3 px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onclick={() => navigate('/mailbox/settings')}
          >
            <SettingsIcon class="h-4 w-4" />
            Settings
          </button>
        </Card.Content>
      </Card.Root>
    </div>
  </div>
{/if}
