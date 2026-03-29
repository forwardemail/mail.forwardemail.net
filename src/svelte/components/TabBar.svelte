<script lang="ts">
  import X from '@lucide/svelte/icons/x';
  import Inbox from '@lucide/svelte/icons/inbox';
  import MailIcon from '@lucide/svelte/icons/mail';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import {
    tabs,
    activeTabId,
    activateTab,
    closeTab,
    closeOtherTabs,
    closeTabsToRight,
  } from '../../stores/tabStore';
  import type { Tab } from '../../stores/tabStore';

  let contextMenu: { x: number; y: number; tabId: string } | null = $state(null);

  function handleTabClick(tabId: string) {
    activateTab(tabId);
  }

  function handleTabClose(e: MouseEvent, tabId: string) {
    e.stopPropagation();
    closeTab(tabId);
  }

  function handleContextMenu(e: MouseEvent, tabId: string) {
    e.preventDefault();
    contextMenu = { x: e.clientX, y: e.clientY, tabId };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  function handleContextAction(action: string) {
    if (!contextMenu) return;
    const tabId = contextMenu.tabId;
    closeContextMenu();

    switch (action) {
      case 'close':
        closeTab(tabId);
        break;
      case 'close-others':
        closeOtherTabs(tabId);
        break;
      case 'close-right':
        closeTabsToRight(tabId);
        break;
    }
  }

  function getTabIcon(tab: Tab): typeof Inbox {
    if (tab.type === 'message') return MailIcon;
    const folder = tab.folder?.toUpperCase() || '';
    if (folder === 'INBOX') return Inbox;
    return FolderIcon;
  }

  function handleMiddleClick(e: MouseEvent, tabId: string) {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tabId);
    }
  }
</script>

{#if $tabs.length > 1}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="hidden md:flex items-center h-9 bg-muted/30 border-b border-border px-1 gap-0.5 overflow-x-auto shrink-0"
    role="tablist"
  >
    {#each $tabs as tab (tab.id)}
      {@const Icon = getTabIcon(tab)}
      <button
        type="button"
        role="tab"
        aria-selected={tab.id === $activeTabId}
        class="group relative inline-flex items-center gap-1.5 h-7 min-w-[120px] max-w-[220px] px-2.5 text-sm transition-colors shrink-0 border border-transparent
          {tab.id === $activeTabId
          ? 'bg-background text-foreground border-border border-b-background shadow-sm -mb-px z-10'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'}"
        onclick={() => handleTabClick(tab.id)}
        onauxclick={(e) => handleMiddleClick(e, tab.id)}
        oncontextmenu={(e) => handleContextMenu(e, tab.id)}
        title={tab.label}
      >
        <Icon class="h-3.5 w-3.5 shrink-0 opacity-60" />
        <span class="truncate flex-1 text-left text-xs">{tab.label}</span>
        {#if tab.closable}
          <span
            class="inline-flex items-center justify-center h-4 w-4 rounded-sm opacity-0 group-hover:opacity-100 hover:bg-muted-foreground/20 transition-opacity shrink-0"
            role="button"
            tabindex="-1"
            aria-label="Close tab"
            onclick={(e) => handleTabClose(e, tab.id)}
          >
            <X class="h-3 w-3" />
          </span>
        {/if}
      </button>
    {/each}
  </div>

  {#if contextMenu}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-50"
      role="presentation"
      onclick={closeContextMenu}
      onkeydown={(e) => {
        if (e.key === 'Escape') closeContextMenu();
      }}
      tabindex="-1"
    >
      <div
        class="fixed z-50 min-w-[160px] border border-border bg-popover p-1 shadow-md text-sm"
        style="left: {contextMenu.x}px; top: {contextMenu.y}px;"
        role="menu"
        aria-label="Tab actions"
      >
        <button
          type="button"
          class="flex items-center w-full px-3 py-1.5 hover:bg-accent transition-colors text-left"
          role="menuitem"
          onclick={() => handleContextAction('close')}
        >
          Close Tab
        </button>
        <button
          type="button"
          class="flex items-center w-full px-3 py-1.5 hover:bg-accent transition-colors text-left"
          role="menuitem"
          onclick={() => handleContextAction('close-others')}
        >
          Close Other Tabs
        </button>
        <button
          type="button"
          class="flex items-center w-full px-3 py-1.5 hover:bg-accent transition-colors text-left"
          role="menuitem"
          onclick={() => handleContextAction('close-right')}
        >
          Close Tabs to the Right
        </button>
      </div>
    </div>
  {/if}
{/if}
