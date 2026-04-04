<script lang="ts">
  import Inbox from '@lucide/svelte/icons/inbox';
  import Search from '@lucide/svelte/icons/search';
  import Pencil from '@lucide/svelte/icons/pencil';
  import SettingsIcon from '@lucide/svelte/icons/settings';

  interface Props {
    inboxUnseenCount?: number;
    activeTab?: 'inbox' | 'search' | 'compose' | 'settings';
    onInbox?: () => void;
    onSearch?: () => void;
    onCompose?: () => void;
    onSettings?: () => void;
  }

  let {
    inboxUnseenCount = 0,
    activeTab = 'inbox',
    onInbox,
    onSearch,
    onCompose,
    onSettings,
  }: Props = $props();
</script>

<nav
  class="fe-mobile-tabbar fixed bottom-0 left-0 right-0 z-50 flex items-stretch border-t border-border bg-background md:hidden"
  aria-label="Main navigation"
>
  <button
    type="button"
    class="fe-mobile-tab"
    class:fe-mobile-tab-active={activeTab === 'inbox'}
    aria-label="Inbox"
    aria-current={activeTab === 'inbox' ? 'page' : undefined}
    onclick={onInbox}
  >
    <span class="fe-mobile-tab-icon">
      <Inbox class="h-5 w-5" />
      {#if inboxUnseenCount > 0}
        <span class="fe-mobile-tab-badge" aria-label="{inboxUnseenCount} unread">
          {inboxUnseenCount > 99 ? '99+' : inboxUnseenCount}
        </span>
      {/if}
    </span>
    <span class="fe-mobile-tab-label">Inbox</span>
  </button>

  <button
    type="button"
    class="fe-mobile-tab"
    class:fe-mobile-tab-active={activeTab === 'search'}
    aria-label="Search"
    aria-current={activeTab === 'search' ? 'page' : undefined}
    onclick={onSearch}
  >
    <span class="fe-mobile-tab-icon">
      <Search class="h-5 w-5" />
    </span>
    <span class="fe-mobile-tab-label">Search</span>
  </button>

  <button
    type="button"
    class="fe-mobile-tab"
    class:fe-mobile-tab-active={activeTab === 'compose'}
    aria-label="Compose"
    onclick={onCompose}
  >
    <span class="fe-mobile-tab-icon">
      <Pencil class="h-5 w-5" />
    </span>
    <span class="fe-mobile-tab-label">Compose</span>
  </button>

  <button
    type="button"
    class="fe-mobile-tab"
    class:fe-mobile-tab-active={activeTab === 'settings'}
    aria-label="Settings"
    aria-current={activeTab === 'settings' ? 'page' : undefined}
    onclick={onSettings}
  >
    <span class="fe-mobile-tab-icon">
      <SettingsIcon class="h-5 w-5" />
    </span>
    <span class="fe-mobile-tab-label">Settings</span>
  </button>
</nav>

<style>
  .fe-mobile-tabbar {
    padding-bottom: env(safe-area-inset-bottom, 0px);
    height: calc(56px + env(safe-area-inset-bottom, 0px));
  }

  .fe-mobile-tab {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    padding: 6px 0;
    color: var(--color-muted-foreground, #888);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color 0.15s;
    -webkit-tap-highlight-color: transparent;
    min-height: 48px;
  }

  .fe-mobile-tab:active {
    opacity: 0.7;
  }

  .fe-mobile-tab-active {
    color: var(--color-primary, hsl(var(--primary)));
  }

  .fe-mobile-tab-icon {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .fe-mobile-tab-badge {
    position: absolute;
    top: -6px;
    right: -10px;
    min-width: 18px;
    height: 18px;
    padding: 0 4px;
    border-radius: 9px;
    background: var(--color-destructive, hsl(var(--destructive)));
    color: var(--color-destructive-foreground, #fff);
    font-size: 11px;
    font-weight: 600;
    line-height: 18px;
    text-align: center;
  }

  .fe-mobile-tab-label {
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
  }
</style>
