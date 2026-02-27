<script lang="ts">
  import { readable, get, writable } from 'svelte/store';
  import type { Readable, Unsubscriber } from 'svelte/store';
  import { tick, onMount, onDestroy } from 'svelte';

  // Store subscriptions managed in onMount/onDestroy to avoid $effect loops
  let mailboxSubscriptions: Unsubscriber[] = [];
  import { mailService } from '../stores/mailService';
  import { searchStore } from '../stores/searchStore';
  import { Remote } from '../utils/remote';
  import { db } from '../utils/db';
  import { sendSyncRequest } from '../utils/sync-worker-client.js';
  import { Local } from '../utils/storage';
  import { formatCompactDate, formatReaderDate } from '../utils/date';
  import { i18n } from '../utils/i18n';
  import { extractAddressList, displayAddresses, getReplyToList, extractDisplayName } from '../utils/address.ts';
  import { truncatePreview } from '../utils/preview';
  import { validateLabelName } from '../utils/label-validation.ts';
  import DOMPurify from 'dompurify';
  import { restoreBlockedImages } from '../utils/sanitize.js';
  import { LABEL_PALETTE, pickLabelColor as pickLabelColorFromPalette } from '../utils/labels.js';
  import { processQuotedContent, initQuoteToggles } from '../utils/quote-collapse.js';
  import {
    activateOnKeys,
    storeToStore,
    storeToWritableStore,
    chooseStore,
    chooseWritableStore,
    dedupeMessages as dedupeMessagesHelper,
    resolveDeleteTargets as resolveDeleteTargetsHelper,
    nextCandidate as nextCandidateHelper,
  } from './mailbox/utils/mailbox-helpers.js';
  import {
    getFromDisplay,
    getToDisplay,
    getConversationFromDisplay,
    getConversationToDisplay,
    getConversationFromName,
    getConversationToName,
    getMessageFromName,
    getMessageToName,
    getInitials,
    getProfileInitials,
    getAvatarColor,
  } from './mailbox/utils/avatar-helpers.js';
  import {
    getMailedBy,
    getSignedBy,
    getSecurityInfo,
    formatSecurityStatus,
  } from './mailbox/utils/security-helpers.js';
  import { createPerfTracer } from '../utils/perf-logger.ts';
  import { getMessageApiId } from '../utils/sync-helpers.ts';
  import { getSyncSettings } from '../utils/sync-settings.js';
  import { parseMailto, mailtoToPrefill } from '../utils/mailto';
  import MailtoPrompt from './components/MailtoPrompt.svelte';
  import {
    outboxCount,
    outboxProcessing,
    listOutbox,
    deleteOutboxItem,
    cancelScheduledEmail,
    getOutboxStats,
  } from '../utils/outbox-service';
  import { syncProgress, indexProgress } from '../stores/mailboxActions';
  import {
    profileName,
    profileImage,
    loadProfileName,
    loadProfileImage,
    effectiveTheme,
    getEffectiveSettingValue,
    setSettingValue,
  } from '../stores/settingsStore';
  import {
    folders as foldersStore,
    selectedFolder as selectedFolderStore,
    expandedFolders as expandedFoldersStore,
    folderContextMenu as folderContextMenuStore,
    folderOperationInProgress as folderOperationInProgressStore,
  } from '../stores/folderStore';
  import {
    messages as messagesStoreBase,
    selectedMessage as selectedMessageStore,
    messageBody as messageBodyStore,
    attachments as attachmentsStore,
    searchResults as searchResultsStore,
    searchActive as searchActiveFallbackStore,
    searching as searchingFallbackStore,
    filteredMessages as filteredMessagesStore,
    loading as loadingStore,
    messageLoading as messageLoadingStore,
    page as pageStore,
    hasNextPage as hasNextPageStore,
  } from '../stores/messageStore';
  import {
    threadingEnabled as threadingEnabledStore,
    sidebarOpen as sidebarOpenStore,
    showFilters as showFiltersFallbackStore,
    sortOrder as sortOrderStore,
    query as queryStore,
    unreadOnly as unreadOnlyStore,
    hasAttachmentsOnly as hasAttachmentsOnlyStore,
    filterByLabel as filterByLabelStore,
  } from '../stores/viewStore';
  import {
    selectedConversationIds as selectedConversationIdsStore,
    selectedConversationCount as selectedConversationCountStore,
    filteredConversations as filteredConversationsStore,
  } from '../stores/conversationStore';
  import FolderContextMenu from './components/FolderContextMenu.svelte';
  import FolderActionModal from './components/FolderActionModal.svelte';
  import LabelModal from './components/LabelModal.svelte';

  // shadcn components
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Badge } from '$lib/components/ui/badge';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Separator } from '$lib/components/ui/separator';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Avatar from '$lib/components/ui/avatar';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import * as Dialog from '$lib/components/ui/dialog';

  // Lucide icons
  import Menu from '@lucide/svelte/icons/menu';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import Pencil from '@lucide/svelte/icons/pencil';
  import Search from '@lucide/svelte/icons/search';
  import Inbox from '@lucide/svelte/icons/inbox';
  import Send from '@lucide/svelte/icons/send';
  import FileEdit from '@lucide/svelte/icons/file-edit';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Archive from '@lucide/svelte/icons/archive';
  import FolderIcon from '@lucide/svelte/icons/folder';
  import FolderOpen from '@lucide/svelte/icons/folder-open';
  import Reply from '@lucide/svelte/icons/reply';
  import ReplyAll from '@lucide/svelte/icons/reply-all';
  import Forward from '@lucide/svelte/icons/forward';
  import Eye from '@lucide/svelte/icons/eye';
  import Download from '@lucide/svelte/icons/download';
  import Star from '@lucide/svelte/icons/star';
  import Plus from '@lucide/svelte/icons/plus';
  import Check from '@lucide/svelte/icons/check';
  import CheckSquare from '@lucide/svelte/icons/check-square';
  import Square from '@lucide/svelte/icons/square';
  import LogOut from '@lucide/svelte/icons/log-out';
  import MailIcon from '@lucide/svelte/icons/mail';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import MoreHorizontal from '@lucide/svelte/icons/more-horizontal';
  import Tag from '@lucide/svelte/icons/tag';
  import FolderInput from '@lucide/svelte/icons/folder-input';
  import X from '@lucide/svelte/icons/x';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import ImageIcon from '@lucide/svelte/icons/image';
  import User from '@lucide/svelte/icons/user';
  import BookUser from '@lucide/svelte/icons/book-user';
  import CalendarIcon from '@lucide/svelte/icons/calendar';
  import SettingsIcon from '@lucide/svelte/icons/settings';
  import MailSearch from '@lucide/svelte/icons/mail-search';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import Filter from '@lucide/svelte/icons/filter';
  import MailboxIcon from '@lucide/svelte/icons/mailbox';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import AlertOctagon from '@lucide/svelte/icons/alert-octagon';
  import Lock from '@lucide/svelte/icons/lock';
  import Sun from '@lucide/svelte/icons/sun';
  import Moon from '@lucide/svelte/icons/moon';
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import EmailIframe from './components/EmailIframe.svelte';

  const isBodyPrefetchEnabled = () =>
    getEffectiveSettingValue('cache_prefetch_enabled') !== false;

  interface MailboxApi {
    open?: () => void;
    refresh?: () => void;
  }

  interface Props {
    mailboxView?: unknown;
    mailboxStore?: unknown;
    navigate?: (path: string) => void;
    active?: boolean | Readable<boolean>;
    applyTheme?: (theme: string) => void;
    registerApi?: (api: MailboxApi) => void;
  }

  let {
    mailboxView,
    mailboxStore,
    navigate = (path: string) => (window.location.href = path),
    active = true,
    applyTheme = () => {},
    registerApi = () => {}
  }: Props = $props();

  // Handle active as either a boolean or a store
  let isActive = $state(typeof active === 'boolean' ? active : true);
  let activeUnsub: (() => void) | null = null;

  // Handle draft message deletion event - refresh message list when a draft is discarded
  const handleDraftMessageDeleted = (event: CustomEvent<{ messageId: string }>) => {
    const { messageId } = event.detail;
    if (!messageId) return;
    // Remove the message from the current message list in the store
    const currentMessages = get(messagesStore);
    const filtered = currentMessages.filter((m) => m.id !== messageId);
    if (filtered.length !== currentMessages.length) {
      messagesStore.set(filtered);
    }
    // Clear selection if the deleted message was selected
    const currentSelected = get(selectedMessageStore);
    if (currentSelected?.id === messageId) {
      selectedMessageStore.set(null);
    }
    const currentFolder = get(selectedFolderStore);
    if (currentFolder && source.actions?.loadMessages) {
      source.actions.loadMessages();
    }
  };

  onMount(() => {
    if (active && typeof active === 'object' && 'subscribe' in active) {
      activeUnsub = (active as Readable<boolean>).subscribe((val: boolean) => { isActive = val; });
    }
    window.addEventListener('draft-message-deleted', handleDraftMessageDeleted as EventListener);
  });

  onDestroy(() => {
    if (activeUnsub) activeUnsub();
    window.removeEventListener('draft-message-deleted', handleDraftMessageDeleted as EventListener);
  });
  let actionMenuOpen = $state(false);
  let showEmailDetails = $state(false);
  let showAllRecipients = $state(false);
  let showAllCc = $state(false);
  let showAllOutboxRecipients = $state(false);

  // Observables → stores
  const fallbackState = {
    folders: foldersStore,
    selectedFolder: selectedFolderStore,
    messages: messagesStoreBase,
    selectedMessage: selectedMessageStore,
    searchResults: searchResultsStore,
    searchActive: searchActiveFallbackStore,
    searching: searchingFallbackStore,
    threadingEnabled: threadingEnabledStore,
    loading: loadingStore,
    page: pageStore,
    hasNextPage: hasNextPageStore,
    query: queryStore,
    unreadOnly: unreadOnlyStore,
    hasAttachmentsOnly: hasAttachmentsOnlyStore,
    filterByLabel: filterByLabelStore,
    messageBody: messageBodyStore,
    attachments: attachmentsStore,
    messageLoading: messageLoadingStore,
    selectedConversationIds: selectedConversationIdsStore,
    selectedConversationCount: selectedConversationCountStore,
    sidebarOpen: sidebarOpenStore,
    showFilters: showFiltersFallbackStore,
    sortOrder: sortOrderStore,
    filteredMessages: filteredMessagesStore,
    filteredConversations: filteredConversationsStore,
    expandedFolders: expandedFoldersStore,
    folderContextMenu: folderContextMenuStore,
    folderOperationInProgress: folderOperationInProgressStore,
  };
  const source = mailboxStore || { state: fallbackState };
  let folders = storeToStore(source.state?.folders, []);
  let selectedFolder = storeToWritableStore(source.state?.selectedFolder, '');
  let skipFolderUrlUpdate = false; // Flag to prevent URL update during popstate handling
  let skipFilterUrlUpdate = true; // Start true to prevent URL updates during initialization
  let urlStateInitialized = false; // Track if URL state system is ready

  // When becoming active (e.g., navigating back from Settings), ensure a folder is selected
  let wasActive = isActive;
  $effect(() => {
    if (isActive && !wasActive) {
      const folder = get(selectedFolder);
      if (!folder) {
        mailboxStore?.actions?.selectFolder?.('INBOX');
      }
    }
    wasActive = isActive;
  });

  // URL state management helpers
  interface UrlFilterState {
    q?: string;
    sort?: string;
    unread?: boolean;
    attachments?: boolean;
    starred?: boolean;
  }

  const serializeFilterState = (): string => {
    const params = new URLSearchParams();
    const currentQuery = get(query) || '';
    const currentSort = get(sortOrder);
    const currentUnread = get(unreadOnly);
    const currentAttachments = get(hasAttachmentsOnly);
    const currentStarred = get(source.state?.starredOnly) || false;

    if (currentQuery) params.set('q', currentQuery);
    if (currentSort && currentSort !== 'newest') params.set('sort', currentSort);
    if (currentUnread) params.set('unread', '1');
    if (currentAttachments) params.set('attachments', '1');
    if (currentStarred) params.set('starred', '1');

    const str = params.toString();
    return str ? `?${str}` : '';
  };

  const parseFilterState = (queryString: string): UrlFilterState => {
    const params = new URLSearchParams(queryString);
    return {
      q: params.get('q') || undefined,
      sort: params.get('sort') || undefined,
      unread: params.get('unread') === '1',
      attachments: params.get('attachments') === '1',
      starred: params.get('starred') === '1',
    };
  };

  const buildHashUrl = (folder: string, messageId?: string | null): string => {
    let hash = `#${encodeURIComponent(folder)}`;
    if (messageId) {
      hash += `/${encodeURIComponent(messageId)}`;
    }
    hash += serializeFilterState();
    return hash;
  };

  const updateUrlWithFilters = () => {
    if (skipFilterUrlUpdate || skipFolderUrlUpdate || !urlStateInitialized) return;
    const folder = get(selectedFolder);
    if (!folder) return;
    const currentMessage = get(source.state?.selectedMessage);
    const hash = buildHashUrl(folder, currentMessage?.id);
    const state = { folder, messageId: currentMessage?.id };
    history.replaceState(state, '', hash);
  };

  const restoreFilterState = (filterState: UrlFilterState) => {
    skipFilterUrlUpdate = true;
    const hasFilters = filterState.q || filterState.unread || filterState.attachments || filterState.starred;
    try {
      // Set sort order first (affects how results are displayed)
      if (filterState.sort) {
        sortOrder.set(filterState.sort as any);
      }
      // Set boolean filters
      if (filterState.unread !== undefined) {
        unreadOnly.set(filterState.unread);
      }
      if (filterState.attachments !== undefined) {
        hasAttachmentsOnly.set(filterState.attachments);
      }
      if (filterState.starred !== undefined && source.state?.starredOnly?.set) {
        source.state.starredOnly.set(filterState.starred);
      }
      // Set query and trigger search if present
      if (filterState.q !== undefined) {
        query.set(filterState.q);
      }
      // Trigger search/filter refresh after a short delay to apply all filters
      if (hasFilters) {
        setTimeout(() => {
          // Trigger search with current query (will apply all active filters)
          mailboxStore?.actions?.searchMessages?.(filterState.q || '');
        }, 100);
      }
    } finally {
      // Use setTimeout to allow store updates to propagate before re-enabling URL updates
      setTimeout(() => {
        skipFilterUrlUpdate = false;
      }, 150);
    }
  };
  let storageUsed = storeToStore(mailboxView?.storageUsed, 0);
  let storageTotal = storeToStore(mailboxView?.storageTotal, 0);
  let query = chooseWritableStore(source.state?.query, mailboxView?.query, '');
  let unreadOnly = chooseWritableStore(source.state?.unreadOnly, mailboxView?.unreadOnly, false);
  let hasAttachmentsOnly = chooseWritableStore(
    source.state?.hasAttachmentsOnly,
    mailboxView?.hasAttachmentsOnly,
    false,
  );
  let filterByLabel = chooseWritableStore(source.state?.filterByLabel, mailboxView?.filterByLabel, []);
  let starredOnly = chooseWritableStore(source.state?.starredOnly, mailboxView?.starredOnly, false);
  let threadingEnabled = chooseWritableStore(source.state?.threadingEnabled, mailboxView?.threadingEnabled, true);
  let messagesStore = storeToWritableStore(source.state?.messages, []);
  let searchActiveStore = storeToStore(source.state?.searchActive, false);
  let searchingStore = storeToStore(source.state?.searching, false);
  let filteredConversations = storeToStore(source.state?.filteredConversations, []);
  let filteredMessages = storeToStore(source.state?.filteredMessages, []);
  let selectedConversationIds = chooseStore(
    source.state?.selectedConversationIds,
    mailboxView?.selectedConversationIds,
    [],
  );
  let selectedConversation = chooseWritableStore(
    source.state?.selectedConversation,
    mailboxView?.selectedConversation,
    null,
  );
  let selectedMessage = chooseStore(
    source.state?.selectedMessage,
    mailboxView?.selectedMessage,
    null,
  );
  let messageBody = chooseStore(source.state?.messageBody, mailboxView?.messageBody, '');
  let attachments = chooseStore(source.state?.attachments, mailboxView?.attachments, []);
  let hasBlockedImages = writable(false);
  let trackingPixelCount = writable(0);
  let blockedImageCount = writable(0);
  let pgpLocked = writable(false);
  let loading = chooseStore(source.state?.loading, mailboxView?.loading, false);
  let messageLoading = chooseStore(
    source.state?.messageLoading,
    mailboxView?.messageLoading,
    false,
  );
  // Delayed skeleton: only show after SKELETON_DELAY_MS to reduce flicker on fast loads
  const SKELETON_DELAY_MS = 200;
  let showSkeleton = $state(false);
  let skeletonTimeoutId: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const isLoading = $messageLoading;
    if (isLoading) {
      // Start delay timer - only show skeleton if loading takes too long
      skeletonTimeoutId = setTimeout(() => {
        showSkeleton = true;
      }, SKELETON_DELAY_MS);
    } else {
      // Loading finished - clear timer and hide skeleton immediately
      if (skeletonTimeoutId) {
        clearTimeout(skeletonTimeoutId);
        skeletonTimeoutId = null;
      }
      showSkeleton = false;
    }
    return () => {
      if (skeletonTimeoutId) {
        clearTimeout(skeletonTimeoutId);
        skeletonTimeoutId = null;
      }
    };
  });
  let page = chooseWritableStore(source.state?.page, mailboxView?.page, 1);
  let hasNextPage = chooseStore(source.state?.hasNextPage, mailboxView?.hasNextPage, false);
  let accounts = storeToStore(mailboxView?.accounts, []);
  let currentAccount = storeToStore(mailboxView?.currentAccount, '');
  let accountMenuOpen = storeToStore(mailboxView?.accountMenuOpen, false);
  let sidebarOpen = chooseWritableStore(source.state?.sidebarOpen, mailboxView?.sidebarOpen, true);
  let mobileReader = storeToStore(mailboxView?.mobileReader, false);
let layoutModeStore = storeToStore(mailboxView?.layoutMode, 'full');
  let showFiltersStore = chooseWritableStore(source.state?.showFilters, mailboxView?.showFilters, false);
  let sortOrder = chooseWritableStore(source.state?.sortOrder, mailboxView?.sortOrder, 'newest');
  let selectedConversationCount = chooseStore(
    source.state?.selectedConversationCount,
    mailboxView?.selectedConversationCount,
    0,
  );
  let bulkMoveOpen = chooseWritableStore(source.state?.bulkMoveOpen, mailboxView?.bulkMoveOpen, false);
  let availableMoveTargets = chooseStore(
    source.state?.availableMoveTargets,
    mailboxView?.availableMoveTargets,
    [],
  );
  let availableLabels = chooseStore(source.state?.availableLabels, mailboxView?.availableLabels, []);
  let profileNameStore = storeToStore(profileName, '');
  let profileImageStore = storeToStore(profileImage, '');

  // Folder management state
  let expandedFolders = storeToStore(source.state?.expandedFolders, new Set());
  let folderContextMenu = storeToStore(source.state?.folderContextMenu, null);
  let folderOperationInProgress = storeToStore(source.state?.folderOperationInProgress, false);

  // Performance: Track last selected message to prevent unnecessary reloads
  let lastSelectedMessageId = null;
  let messageLoadInProgress = false;
  let messageLoadSequence = 0;
  let messageLoadAbort = null;
  let activeMessageLoad = 0;
  let activeMessageId = null;
  let savedSearchesStore = storeToStore(searchStore?.state?.savedSearches, []);
  const availableMoveTargetsFromStore = $derived($folders
    ? $folders.filter((f: { path?: string }) => f.path && f.path !== $selectedFolder)
    : []);
  const availableLabelsFromStore = $derived($availableLabels || []);
  const labelMap = $derived(new Map(
    (availableLabelsFromStore || []).map((l: { id?: string; keyword?: string; value?: string; name?: string }) => [
      l.id || l.keyword || l.value || l.name,
      l,
    ]),
  ));
  const labelPalette = LABEL_PALETTE;
  let labelPaletteIndex = 0;
  const layoutModeValue = $derived($layoutModeStore || 'full');
  const isProductivityLayout = $derived(layoutModeValue === 'full');
  let lastLayoutMode = $state('full');
  let verticalSplit = $state(0.45);
  let resizingVertical = $state(false);
  let messagesPaneEl: HTMLElement | null = $state(null);
  let readerPaneEl: HTMLElement | null = $state(null);

  // Classic layout mode (vertical split) on desktop - switches to fullscreen at 900px
  const isVerticalDesktop = $derived(!isProductivityLayout && !isClassicMobileViewport());
  const verticalSplitStyle = $derived(isVerticalDesktop
    ? `--fe-message-fr: ${verticalSplit.toFixed(3)}fr; --fe-reader-fr: ${(1 - verticalSplit).toFixed(3)}fr;`
    : '');

const startVerticalResize = (event) => {
  if (!isVerticalDesktop) return;
  resizingVertical = true;
  window.addEventListener('mousemove', onVerticalResize);
  window.addEventListener('mouseup', stopVerticalResize);
  window.addEventListener('mouseleave', stopVerticalResize);
  event.preventDefault();
};

const onVerticalResize = (event) => {
  if (!resizingVertical || !messagesPaneEl || !readerPaneEl || !isVerticalDesktop) return;
  const messagesRect = messagesPaneEl.getBoundingClientRect();
  const readerRect = readerPaneEl.getBoundingClientRect();
  const total = readerRect.right - messagesRect.left;
  if (total <= 0) return;
  const offset = Math.min(Math.max(event.clientX - messagesRect.left, 0), total);
  const ratio = offset / total;
  verticalSplit = Math.min(0.75, Math.max(0.25, ratio));
};

const stopVerticalResize = () => {
  if (!resizingVertical) return;
  resizingVertical = false;
  window.removeEventListener('mousemove', onVerticalResize);
  window.removeEventListener('mouseup', stopVerticalResize);
  window.removeEventListener('mouseleave', stopVerticalResize);
};
  // Removed - was causing loops (mobileReader sync)

  let contextMenuVisible = $state(false);
  let contextMenuX = $state(0);
  let contextMenuY = $state(0);
  let contextMenuMessage = $state<unknown>(null);
  let contextMenuConversation = $state<unknown>(null);
  let contextMenuFlipX = $state(false);
  let contextMenuFlipY = $state(false);
  let contextMoveOpen = $state(false);
  let contextLabelOpen = $state(false);
  let contextSubmenusEnabled = $state(true);
  let contextSubmenuFlipX = $state(false);
  let contextSubmenuFlipY = $state(false);
  let contextSubmenuShiftY = $state(0);
  let contextSubmenuMaxHeight = $state(0);
  let contextMoveSubmenuEl = $state<HTMLElement | null>(null);
  let contextLabelSubmenuEl = $state<HTMLElement | null>(null);

  // Confirmation dialogs
  let confirmDialogVisible = $state(false);
  let confirmDialogTitle = $state('');
  let confirmDialogMessage = $state('');
  let confirmDialogAction = $state<(() => void) | null>(null);
  let confirmDialogDanger = $state(false);


  // Outbox state
  let outboxSelected = $state(false);
  let outboxItems = $state<unknown[]>([]);
  let outboxStats = $state({ pending: 0, sending: 0, failed: 0, sent: 0 });
  let selectedOutboxItem = $state<{ id?: string; emailData?: { to?: string[] } } | null>(null);
  let previousFolder: string | null = null;

  // Pull-to-refresh state
  const pullStartMaxOffset = 80;
  let pullToRefreshActive = $state(false);
  let pullDistance = $state(0);
  let pullStartY = 0;
  let isPulling = $state(false);
  let isRefreshing = $state(false);
  let refreshAnimating = $state(false);
  let refreshAnimationTimer: ReturnType<typeof setTimeout> | null = null;

  // Swipe gesture state for email list
  let swipeItemId = $state<string | null>(null);
  let swipeDistance = $state(0);
  let swipeStartX = 0;
  let swipeStartY = 0;
  let swiping = $state(false);
  let swipeStartTime = 0;
  let swipeVelocity = 0;
  let swipeAnimating = $state(false);

  // Reader swipe navigation state
  let readerSwipeStartX = 0;
  let readerSwipeStartY = 0;
  let readerSwipeDistance = $state(0);
  let readerSwiping = $state(false);
  let readerSwipeDirection = $state<string | null>(null);

  // Drag and drop state
  let draggedItem = $state<unknown>(null);
  let dragOverFolder = $state<string | null>(null);
  let dragExpandTimeout: ReturnType<typeof setTimeout> | null = null;

  async function loadOutboxItems() {
    try {
      outboxItems = await listOutbox();
      outboxStats = await getOutboxStats();
    } catch {
    }
  }

  async function handleDeleteOutbox(item) {
    const isScheduled = item.status === 'scheduled';
    const title = isScheduled ? 'Cancel scheduled email?' : 'Delete from outbox?';
    const message = isScheduled
      ? 'This scheduled email will be cancelled and will not be sent.'
      : 'This email will be removed from your outbox.';

    showConfirmDialog(
      title,
      message,
      async () => {
        try {
          if (isScheduled) {
            // Use cancelScheduledEmail for scheduled items - handles server cancellation
            const result = await cancelScheduledEmail(item.id);
            if (!result.success) {
              showToast(result.error || 'Failed to cancel scheduled email', 'error');
              return;
            }
          } else {
            await deleteOutboxItem(item.id);
          }
          await loadOutboxItems();

          // Clear selection if we deleted the selected item
          if (selectedOutboxItem?.id === item.id) {
            selectedOutboxItem = null;
          }
        } catch (err) {
          console.error('[Mailbox] Failed to delete outbox item:', err);
          showToast('Failed to delete email from outbox', 'error');
        }
      },
      true, // danger styling
    );
  }

  function formatScheduledTime(timestamp) {
    if (!timestamp) return 'Scheduled';
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = date.toDateString() === tomorrow.toDateString();

    const timeStr = date.toLocaleTimeString(i18n.getFormattingLocale(), {
      hour: 'numeric',
      minute: '2-digit',
    });

    if (isToday) {
      return `Today ${timeStr}`;
    } else if (isTomorrow) {
      return `Tomorrow ${timeStr}`;
    } else {
      return date.toLocaleDateString(i18n.getFormattingLocale(), {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
    }
  }

  function selectOutbox() {
    outboxSelected = true;
    selectedOutboxItem = null;
    loadOutboxItems();
    if (isProductivityLayout) {
      closeReaderFullscreen({ updateUrl: false }); // Outbox has separate URL handling
    }
    // Close compose view if open
    if (mailboxView?.composeModal?.close) {
      mailboxView.composeModal.close();
    }
  }

  function selectOutboxItem(item) {
    selectedOutboxItem = item;
    // Open mobile reader if on mobile, in productivity layout, or classic at narrow width
    if (isProductivityLayout || isClassicMobileViewport()) {
      mobileReader.set?.(true);
      if (mailboxView?.mobileReader?.set) {
        mailboxView.mobileReader.set(true);
      }
    }
  }

  // Outbox refresh moved to manual trigger (was causing loops)
  let searchSuggestionsVisible = $state(false);
  let searchInputEl: HTMLInputElement | undefined = $state();
  let selectionMode = $state(false);
  $effect(() => {
    if (!selectionMode) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  });
  let sortMenuOpen = $state(false);
  let labelMenuOpen = $state(false);
  let readerMoveOpen = $state(false);
  let readerMoveMenuFlip = $state(false);
  let readerMoveBtnEl: HTMLElement | undefined = $state();
  let readerToolbarMoveOpen = $state(false);
  let readerLabelMenuOpen = $state(false);
  let readerLabelMenuFlip = $state(false);
  let readerLabelBtnEl: HTMLElement | undefined = $state();
  let readerTransitionCount = $state(0);
  let labelModalVisible = $state(false);
  let labelModalSaving = $state(false);
  let labelModalError = $state('');
  let labelFormName = $state('');
  let labelFormColor = $state('');

  $effect(() => {
    if (sortMenuOpen) {
      tick().then(() => {
        positionDropdown('[data-sort-toggle] > button', '[data-sort-toggle] > div:last-child');
      });
    }
  });

  $effect(() => {
    if (labelMenuOpen) {
      tick().then(() => {
        positionDropdown('[data-labels-toggle] > button', '[data-labels-dropdown]');
      });
    }
  });

  const readerTransitioning = $derived(readerTransitionCount > 0);

  const holdReaderTransition = () => {
    readerTransitionCount += 1;
    return () => {
      readerTransitionCount = Math.max(0, readerTransitionCount - 1);
    };
  };

  // Track expanded conversations in memory only (no persistence)
  // Store-backed so Svelte reacts immediately without waiting for other state changes
  const expandedConversations = writable(new Set());

  // Track which individual thread messages are expanded (Gmail-like independent expand/collapse)
  const expandedThreadMessages = writable(new Set());

  // Cache message bodies for thread messages (Gmail-like - keeps bodies loaded when expanded)
  // Map of messageId -> { body: string, attachments: array, loading: boolean }
  const threadMessageBodies = writable(new Map());

  // Check if a thread message has its body cached
  const getThreadMessageBody = (msgId) => {
    const bodies = get(threadMessageBodies);
    return bodies.get(msgId);
  };

  // Load and cache a thread message body
  const loadThreadMessageBody = async (msg) => {
    if (!msg?.id) return;

    const loadAccount = Local.get('email') || 'default';

    const bodies = get(threadMessageBodies);
    if (bodies.has(msg.id) && !bodies.get(msg.id)?.loading) {
      return; // Already loaded
    }

    // Mark as loading
    threadMessageBodies.update((map) => {
      const next = new Map(map);
      next.set(msg.id, { body: '', attachments: [], loading: true });
      return next;
    });

    try {
      await mailService.loadMessageDetail(msg, {
        onBody: (body) => {
          if ((Local.get('email') || 'default') !== loadAccount) return;
          // Process quoted content for collapsible display
          const processedBody = processQuotedContent(body, { collapseByDefault: true });
          threadMessageBodies.update((map) => {
            const next = new Map(map);
            const existing = next.get(msg.id) || {};
            next.set(msg.id, { ...existing, body: processedBody, loading: false });
            return next;
          });
          // Initialize quote toggles after next tick
          tick().then(() => {
            const container = document.querySelector(`[data-message-id="${msg.id}"]`);
            if (container) initQuoteToggles(container);
          });
        },
        onAttachments: (atts) => {
          if ((Local.get('email') || 'default') !== loadAccount) return;
          threadMessageBodies.update((map) => {
            const next = new Map(map);
            const existing = next.get(msg.id) || {};
            next.set(msg.id, { ...existing, attachments: atts || [] });
            return next;
          });
        },
      });
    } catch (err) {
      if ((Local.get('email') || 'default') !== loadAccount) return;
      console.warn('[loadThreadMessageBody] Failed to load body for message:', msg.id, err);
      threadMessageBodies.update((map) => {
        const next = new Map(map);
        next.set(msg.id, { body: '', attachments: [], loading: false, error: true });
        return next;
      });
    }
  };

  // Reference to message list container for scrolling
  let messageListWrapper;
  // Note: messageBodyContainer removed - email body now rendered in EmailIframe
  let outboxMessageBodyContainer;
  let infiniteScrollSentinel;
  let infiniteScrollObserver;

  // Unified breakpoint constants for consistent responsive behavior
  const BREAKPOINT_MOBILE = 640;  // phones
  const BREAKPOINT_CLASSIC_MOBILE = 900; // classic layout switches to fullscreen at this width
  const BREAKPOINT_TABLET = 1024; // tablets
  // Reactive viewport width for proper layout updates on resize
  let viewportWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const isMobileViewport = () => viewportWidth <= BREAKPOINT_MOBILE;
  const isClassicMobileViewport = () => viewportWidth <= BREAKPOINT_CLASSIC_MOBILE;
  const isTabletViewport = () => viewportWidth > BREAKPOINT_MOBILE && viewportWidth <= BREAKPOINT_TABLET;
  const isMobile = $derived(viewportWidth <= BREAKPOINT_MOBILE);
  // Check both messages and conversations to avoid flicker from debounced conversations
  const listIsEmpty = $derived(
    $threadingEnabled
      ? !$filteredConversations.length && !$filteredMessages.length
      : !$filteredMessages.length
  );
  const syncingSelectedFolder = $derived(
    $syncProgress.active &&
    !$searchActiveStore &&
    (!$syncProgress.folder || $syncProgress.folder === $selectedFolder));

  // Folder change tracking removed (was causing loops) - skeleton shown via $loading instead

  // Delayed empty state: only show after settling to avoid flicker
  const EMPTY_STATE_DELAY_MS = 150;
  let showEmptyState = $state(false);
  let emptyStateTimeoutId: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const shouldBeEmpty = listIsEmpty && !$loading && !syncingSelectedFolder;
    if (shouldBeEmpty) {
      // Delay showing empty state to allow debounced data to settle
      if (!emptyStateTimeoutId) {
        emptyStateTimeoutId = setTimeout(() => {
          showEmptyState = true;
        }, EMPTY_STATE_DELAY_MS);
      }
    } else {
      // Immediately hide empty state when we have data or are loading
      if (emptyStateTimeoutId) {
        clearTimeout(emptyStateTimeoutId);
        emptyStateTimeoutId = null;
      }
      showEmptyState = false;
    }
  });

  // Show skeleton when loading or when list appears empty but we haven't settled yet.
  // Delayed by LIST_SKELETON_DELAY_MS so fast IDB/mem-cache reads can populate messages
  // before the skeleton ever renders — eliminates flicker on folder switching.
  const LIST_SKELETON_DELAY_MS = 150;
  const wantListSkeleton = $derived(
    listIsEmpty && ($loading || syncingSelectedFolder || !showEmptyState));
  let showListSkeleton = $state(false);
  let listSkeletonTimeoutId: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    if (wantListSkeleton) {
      if (!listSkeletonTimeoutId) {
        listSkeletonTimeoutId = setTimeout(() => {
          showListSkeleton = true;
        }, LIST_SKELETON_DELAY_MS);
      }
    } else {
      if (listSkeletonTimeoutId) {
        clearTimeout(listSkeletonTimeoutId);
        listSkeletonTimeoutId = null;
      }
      showListSkeleton = false;
    }
  });

  const hasAttachments = (item) => {
    if (!item) return false;
    if (item.has_attachments) return true;
    if (item.attachment_count > 0) return true;
    if (Array.isArray(item.attachments) && item.attachments.length) return true;
    if (item.latestHasAttachments) return true;
    if (Array.isArray(item.messages)) {
      return item.messages.some((m) => hasAttachments(m));
    }
    return false;
  };

  const PREVIEWABLE_IMAGE_TYPES = new Set([
    'image/gif', 'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp', 'image/apng', 'image/avif',
  ]);

  const PREVIEWABLE_EXTENSIONS = new Set([
    'gif', 'png', 'jpeg', 'jpg', 'webp', 'bmp', 'apng', 'avif',
  ]);

  const isPreviewableImage = (att) => {
    const type = (att?.contentType || att?.mimeType || att?.type || '').toLowerCase();
    if (PREVIEWABLE_IMAGE_TYPES.has(type)) return true;
    const name = (att?.name || att?.filename || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return ext ? PREVIEWABLE_EXTENSIONS.has(ext) : false;
  };

  /**
   * Sanitize outbox HTML preview to prevent XSS.
   * Outbox items may contain user-composed HTML that has not been
   * server-sanitized, so we must run DOMPurify before rendering.
   */
  const sanitizeOutboxHtml = (html: string): string => {
    if (!html) return '';
    return DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'button'],
      HOOKS: {
        afterSanitizeAttributes: (node) => {
          // Strip all on* event handler attributes (covers onerror, onload, onclick, etc.)
          for (const attr of [...node.attributes]) {
            if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
          }
          // Ensure links open safely in new tab
          if (node.tagName === 'A') {
            node.setAttribute('target', '_blank');
            node.setAttribute('rel', 'noopener noreferrer');
          }
        },
      },
    });
  };

  const formatAttachmentSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Filter attachments for the download/preview section.
  // Only hide attachments that are purely inline decorations (e.g. signature logos):
  // they must have a CID, be an image, AND have inline disposition explicitly set.
  // All other attachments (including images without disposition or with disposition=attachment) are shown.
  const filterDownloadableAttachments = (atts) => {
    if (!Array.isArray(atts)) return [];
    return atts.filter((att) => {
      if (!att.contentId) return true;
      const type = (att.contentType || att.mimeType || att.type || '').toLowerCase();
      if (!type.startsWith('image/')) return true;
      // Only hide if disposition is explicitly 'inline' — these are CID images
      // embedded in the body (e.g. signature logos). If disposition is missing or
      // is 'attachment', always show the file.
      const disp = (att.disposition || '').toLowerCase();
      return disp !== 'inline';
    });
  };

  let isDarkMode = $state(false);

  // Network status tracking for offline banner
  let isOffline = $state(typeof navigator !== 'undefined' ? !navigator.onLine : false);
  $effect(() => {
    const goOffline = () => { isOffline = true; };
    const goOnline = () => { isOffline = false; };
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => {
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', goOnline);
    };
  });

  const updateThemeState = () => {
    if (typeof document === 'undefined') return;
    isDarkMode = document.body.classList.contains('dark-mode');
  };

  const toggleTheme = async () => {
    const next = isDarkMode ? 'light' : 'dark';
    applyTheme(next);
    updateThemeState();
    try {
      await setSettingValue('theme', next, { account: $currentAccount || Local.get('email') });
    } catch {
      // Ignore remote sync failures; local theme already applied.
    }
  };

  const profileInitials = $derived(getProfileInitials($profileNameStore));
  let showHeaderShortcuts = $state(typeof window !== 'undefined' ? window.innerWidth > 900 : true);
  // Profile loading moved to onMount subscription

  // Track next page prefetch status for smart pagination
  let nextPagePrefetched = $state(false);
  let prefetchingNextPage = $state(false);
  const operatorSuggestions = [
    { label: 'from:', value: 'from:', type: 'operator' },
    { label: 'to:', value: 'to:', type: 'operator' },
    { label: 'subject:', value: 'subject:', type: 'operator' },
    { label: 'has:attachment', value: 'has:attachment', type: 'operator' },
    { label: 'is:unread', value: 'is:unread', type: 'operator' },
    { label: 'in:all', value: 'in:all', type: 'operator' },
    { label: 'before:2024-01-01', value: 'before:2024-01-01', type: 'operator' },
    { label: 'size:>5MB', value: 'size:>5MB', type: 'operator' },
  ];
  const labelSuggestions = $derived(
    (availableLabelsFromStore || []).slice(0, 8).map((l: { name?: string; label?: string; value?: string; id?: string; keyword?: string; color?: string }) => ({
      label: l.name || l.label || l.value,
      value: `label:${l.id || l.keyword || l.value || l.name}`,
      color: l.color,
      type: 'label',
    })));
  const savedSearchSuggestions = $derived(
    ($savedSearchesStore || []).map((s: { name: string; query: string }) => ({
      label: s.name,
      value: s.query,
      type: 'saved',
    })) || []);
  const searchSuggestionItems = $derived([...savedSearchSuggestions, ...operatorSuggestions, ...labelSuggestions]);
  const filteredSuggestions = $derived(($query || '').trim()
    ? searchSuggestionItems.filter((item: { label: string }) =>
        item.label.toLowerCase().includes(($query || '').toLowerCase()),
      )
    : searchSuggestionItems);

  // Reset showEmailDetails and scroll reader to top when message changes
  let lastSelectedMsgId = '';
  $effect(() => {
    const msgId = $selectedMessage?.id || '';
    if ($selectedMessage && msgId !== lastSelectedMsgId) {
      lastSelectedMsgId = msgId;
      showEmailDetails = false;
      showAllRecipients = false;
      showAllCc = false;
      // Scroll reader pane to top so the metadata header is visible
      if (readerPaneEl) {
        readerPaneEl.scrollTop = 0;
      }
    }
  });

  // Reset outbox recipient expansion when item changes - guard to prevent loop
  let lastOutboxItemId = '';
  $effect(() => {
    const itemId = selectedOutboxItem?.id || '';
    if (selectedOutboxItem && itemId !== lastOutboxItemId) {
      lastOutboxItemId = itemId;
      showAllOutboxRecipients = false;
    }
  });

  // Helper to split comma-separated email strings
  const splitEmailString = (list) => {
    if (!Array.isArray(list) || list.length === 0) return [];

    // If we have a single string element containing commas, split it
    if (list.length === 1 && typeof list[0] === 'string' && list[0].includes(',')) {
      return list[0].split(',').map(email => email.trim()).filter(Boolean);
    }

    // Otherwise, check each element and split if needed
    const result = [];
    list.forEach(item => {
      if (typeof item === 'string' && item.includes(',')) {
        result.push(...item.split(',').map(email => email.trim()).filter(Boolean));
      } else {
        result.push(item);
      }
    });
    return result;
  };

  // Compute recipients list for condensed display
  const recipientsList = $derived($selectedMessage
    ? splitEmailString(extractAddressList($selectedMessage, 'to').length
        ? extractAddressList($selectedMessage, 'to')
        : extractAddressList($selectedMessage, 'recipients'))
    : []);

  const displayedRecipients = $derived((showAllRecipients === true || recipientsList.length <= 5)
    ? recipientsList
    : recipientsList.slice(0, 5));

  const remainingRecipientsCount = $derived(Math.max(0, recipientsList.length - 5));

  // Compute CC list for condensed display
  const ccList = $derived($selectedMessage
    ? splitEmailString(extractAddressList($selectedMessage, 'cc'))
    : []);

  const displayedCc = $derived((showAllCc === true || ccList.length <= 5)
    ? ccList
    : ccList.slice(0, 5));

  const remainingCcCount = $derived(Math.max(0, ccList.length - 5));

  // Compute outbox recipients list for truncation
  const outboxRecipientsList = $derived(splitEmailString(selectedOutboxItem?.emailData?.to || []));
  const displayedOutboxRecipients = $derived((showAllOutboxRecipients === true || outboxRecipientsList.length <= 5)
    ? outboxRecipientsList
    : outboxRecipientsList.slice(0, 5));
  const remainingOutboxRecipientsCount = $derived(Math.max(0, outboxRecipientsList.length - 5));

  const threadMessages = $derived(
    $threadingEnabled && $selectedConversation
      ? ($selectedConversation.previewMessages || $selectedConversation.messages || [])
      : ($selectedMessage ? [$selectedMessage] : []));
  const threadSubject = $derived(
    $threadingEnabled && $selectedConversation
      ? ($selectedConversation.displaySubject || $selectedConversation.subject || $selectedMessage?.subject)
      : $selectedMessage?.subject);
  const isThreaded = $derived(threadMessages.length > 1);

  const sortOptions = [
    { label: 'Newest first', value: 'newest' },
    { label: 'Oldest first', value: 'oldest' },
    { label: 'Subject (A–Z)', value: 'subject' },
    { label: 'Sender (A–Z)', value: 'sender' },
  ];
  const getSortLabel = (value) =>
    sortOptions.find((opt) => opt.value === value)?.label || 'Newest first';
  const buildFilterLabel = (unreadOnly, attachmentsOnly, labelFilters, labelMapData) => {
    const parts = [];
    if (unreadOnly) parts.push('Unread');
    if (attachmentsOnly) parts.push('Attachments');
    if (labelFilters && labelFilters.length > 0) {
      labelFilters.forEach(labelId => {
        const label = labelMapData?.get?.(labelId);
        const labelName = label?.name || label?.label || label?.value || labelId;
        parts.push(labelName);
      });
    }
    if (!parts.length) return 'Filters';
    return parts.join(' + ');
  };
  const filterLabel = $derived(buildFilterLabel($unreadOnly, $hasAttachmentsOnly, $filterByLabel, labelMap));
  const pickLabelColor = () => {
    const color = pickLabelColorFromPalette(labelPaletteIndex, labelPalette);
    labelPaletteIndex += 1;
    return color;
  };

  const formatStorage = (bytes = 0) => {
    if (!bytes) return '0 GB';
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) {
      const rounded = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
      return `${rounded} GB`;
    }
    const mb = bytes / 1024 / 1024;
    return `${Math.round(mb)} MB`;
  };

  const storagePercent = () => {
    let used, total;
    const unsub = storageUsed.subscribe((v) => (used = v || 0));
    const unsub2 = storageTotal.subscribe((v) => (total = v || 0));
    unsub();
    unsub2();
    if (!total) return 0;
    return Math.min(100, Math.round((used / total) * 100));
  };

  let searchDebounceTimer = null;
  const onSearch = (val) => {
    // Update query immediately for UI feedback, but debounce actual search
    if (query && typeof query.set === 'function') {
      query.set(val || '');
    }
    // Close fullscreen reader when search is initiated so user sees results list
    if (val && val.trim()) {
      closeReaderFullscreen({ updateUrl: false });
    }
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      mailboxView?.onSearch?.(val);
    }, 200);
  };
  const applySuggestion = (value) => {
    const base = ($query || '').trim();
    const next = base ? `${base} ${value}` : value;
    onSearch(next);
    setTimeout(() => {
      searchInputEl?.focus?.();
    }, 0);
  };
  let suggestionHideTimer = null;
  const showSuggestions = () => {
    if (suggestionHideTimer) {
      clearTimeout(suggestionHideTimer);
      suggestionHideTimer = null;
    }
    searchSuggestionsVisible = true;
  };
  const hideSuggestions = () => {
    suggestionHideTimer = setTimeout(() => {
      searchSuggestionsVisible = false;
      suggestionHideTimer = null;
    }, 120);
  };
  const handleSelectFolder = (path) => {
    outboxSelected = false;
    selectedOutboxItem = null;
    collapseSidebarForMobile();
    if (isProductivityLayout) {
      closeReaderFullscreen({ updateUrl: false }); // URL updated by folder subscription
    }
    if (mailboxStore?.actions?.selectFolder) {
      mailboxStore.actions.selectFolder(path);
    } else {
      mailboxView?.selectFolder?.(path);
    }
    // URL will be updated by the selectedFolder subscription
  };
  const updateSelectedConversation = (conv) => {
    if (selectedConversation && typeof selectedConversation.set === 'function') {
      selectedConversation.set(conv);
    } else if (mailboxView?.selectedConversation?.set) {
      mailboxView.selectedConversation.set(conv);
    }
  };

  // Prefetch adjacent messages for faster navigation
  const prefetchAdjacentMessages = (currentItem) => {
    if (!isBodyPrefetchEnabled()) return;
    if (!currentItem?.id) return;

    const list = $threadingEnabled ? $filteredConversations : $filteredMessages;
    if (!list || !list.length) return;

    // Find current index
    const currentIndex = list.findIndex(item => item.id === currentItem.id);
    if (currentIndex === -1) return;

    // Get adjacent items (2 before, 3 after for forward navigation preference)
    const adjacentItems = [];
    for (let i = Math.max(0, currentIndex - 2); i <= Math.min(list.length - 1, currentIndex + 3); i++) {
      if (i !== currentIndex) {
        adjacentItems.push(list[i]);
      }
    }

    // Extract messages from conversations if in threading mode
    const messagesToPrefetch = [];
    adjacentItems.forEach(item => {
      if ($threadingEnabled && item.messages) {
        // Prefetch the last message of each conversation (most recent)
        const lastMsg = item.messages.slice(-1)[0];
        if (lastMsg) messagesToPrefetch.push(lastMsg);
      } else {
        messagesToPrefetch.push(item);
      }
    });

    // Adjacent body prefetch is handled by the sync worker's
    // queueBodiesForFolder background task to avoid duplicate network calls.
  };
  const openReaderFullscreen = () => {
    if (mailboxView?.mobileReader?.set) {
      mailboxView.mobileReader.set(true);
    } else if (typeof mailboxView?.mobileReader === 'function') {
      mailboxView.mobileReader(true);
    }
    mobileReader.set?.(true);
  };
  const closeReaderFullscreen = ({ clearSelection = false, updateUrl = true } = {}) => {
    if (mailboxView?.mobileReader?.set) {
      mailboxView.mobileReader.set(false);
    } else if (typeof mailboxView?.mobileReader === 'function') {
      mailboxView.mobileReader(false);
    }
    mobileReader.set?.(false);
    readerMoveOpen = false;
    readerToolbarMoveOpen = false;

    // Clear selection and update URL if requested (e.g., back button)
    if (clearSelection) {
      source.state?.selectedMessage?.set?.(null);
      updateSelectedConversation(null);
    }

    // Update URL to show just the folder (remove message from URL)
    if (updateUrl) {
      const folder = get(selectedFolder);
      if (folder) {
        const hash = buildHashUrl(folder, null);
        history.pushState({ folder }, '', hash);
      }
    }
  };

  // Guard to prevent repeated closeReaderFullscreen calls
  let closedReaderForNoSelection = false;
  $effect(() => {
    if (isProductivityLayout && $mobileReader && !readerTransitioning) {
      const hasReaderSelection = outboxSelected ? !!selectedOutboxItem : !!$selectedMessage;
      if (!hasReaderSelection && !closedReaderForNoSelection) {
        closedReaderForNoSelection = true;
        closeReaderFullscreen({ updateUrl: false }); // URL already reflects state
      } else if (hasReaderSelection) {
        closedReaderForNoSelection = false;
      }
    }
  });

  const selectConversation = (conv, { updateUrl = true } = {}) => {
    // Close action menu when selecting a new conversation
    actionMenuOpen = false;

    const lastMessage =
      conv?.previewMessages?.slice?.(-1)?.[0] || conv?.messages?.slice?.(-1)?.[0];

    // Performance: Prevent reload if same message already selected
    if (lastSelectedMessageId === lastMessage?.id && $selectedMessage?.id === lastMessage?.id) {
      // Already selected - skip reload but still handle UI state
      if (isProductivityLayout || isClassicMobileViewport()) {
        openReaderFullscreen();
      }
      return;
    }

    // Allow switching while a message load is in flight.

    lastSelectedMessageId = lastMessage?.id;

    // Clear body/attachments BEFORE updating selectedMessage to prevent stale content
    // from the previous message flashing with the new message's subject/sender.
    source.state?.messageBody?.set?.('');
    source.state?.attachments?.set?.([]);
    updateSelectedConversation(conv);
    if (source.state?.selectedMessage) {
      mailboxStore.state.selectedMessage.set(lastMessage);
    }
    mailboxView?.selectConversation?.(conv);

    // Set mobile reader on mobile screens, in productivity layout, or classic at narrow width
    if (isProductivityLayout || isClassicMobileViewport()) {
      openReaderFullscreen();
    }

    // Reset loading state before loading new message to prevent skeleton flicker
    source.state?.messageLoading?.set?.(false);
    loadMessage(lastMessage);

    // Mark all messages in the thread as read when opening a conversation
    if (conv?.messages?.length > 1) {
      markConversationRead(conv);
    }

    // Prefetch adjacent conversations in the background
    prefetchAdjacentMessages(conv);

    // Update URL hash for deep linking (e.g., #INBOX/12345?q=search&sort=newest)
    const folder = get(selectedFolder);
    if (updateUrl && lastMessage?.id && folder) {
      const hash = buildHashUrl(folder, lastMessage.id);
      history.pushState({ messageId: lastMessage.id, folder }, '', hash);
    }
  };
  // Auto-select conversation removed (was causing loops) - user must click to select
  const selectMessage = (msg, { updateUrl = true } = {}) => {
    // Close action menu when selecting a new message
    actionMenuOpen = false;

    // Performance: Prevent reload if same message already selected
    if (lastSelectedMessageId === msg?.id && $selectedMessage?.id === msg?.id) {
      // Already selected - skip reload but still handle UI state
      if (isProductivityLayout || isClassicMobileViewport()) {
        openReaderFullscreen();
      }
      return;
    }

    // Allow switching while a message load is in flight.

    lastSelectedMessageId = msg?.id;

    mailboxView?.selectMessage?.(msg);
    // Clear body/attachments BEFORE updating selectedMessage to prevent stale content
    // from the previous message flashing with the new message's subject/sender.
    // loadMessage() will populate the body from cache or network.
    source.state?.messageBody?.set?.('');
    source.state?.attachments?.set?.([]);
    source.state?.selectedMessage?.set?.(msg);
    // Reset loading state to prevent skeleton flicker for cached messages.
    source.state?.messageLoading?.set?.(false);
    if (isProductivityLayout || isClassicMobileViewport()) {
      openReaderFullscreen();
    }
    loadMessage(msg);

    // Prefetch adjacent messages in the background
    prefetchAdjacentMessages(msg);

    // Update URL hash for deep linking (e.g., #INBOX/12345?q=search&sort=newest)
    const folder = get(selectedFolder);
    if (updateUrl && msg?.id && folder) {
      const hash = buildHashUrl(folder, msg.id);
      history.pushState({ messageId: msg.id, folder }, '', hash);
    }
  };
  const toggleThreadMessage = (msg) => {
    if (!msg?.id) return;

    // Gmail-like behavior: toggle expansion independently without affecting other messages
    const wasExpanded = $expandedThreadMessages.has(msg.id);

    expandedThreadMessages.update((set) => {
      const next = new Set(set);
      if (next.has(msg.id)) {
        next.delete(msg.id);
      } else {
        next.add(msg.id);
      }
      return next;
    });

    // When expanding, load the message body into cache
    if (!wasExpanded) {
      loadThreadMessageBody(msg);
    }
  };

  // Check if a thread message is expanded
  const isThreadMessageExpanded = (msgId) => {
    return $expandedThreadMessages.has(msgId);
  };

  // Expand all messages in a thread
  const expandAllThreadMessages = () => {
    if (!threadMessages?.length) return;
    expandedThreadMessages.update(() => {
      return new Set(threadMessages.map((m) => m.id));
    });
    // Load bodies for all messages
    threadMessages.forEach((msg) => loadThreadMessageBody(msg));
  };

  // Collapse all messages in a thread
  const collapseAllThreadMessages = () => {
    expandedThreadMessages.set(new Set());
  };

  // Thread auto-expand removed (was causing loops) - user must click to expand
  const expandConversation = (id) => {
    if (!id) return;
    expandedConversations.update((set) => {
      if (set.has(id)) return set;
      const next = new Set(set);
      next.add(id);
      return next;
    });
  };
  const collapseConversation = (id) => {
    if (!id) return;
    expandedConversations.update((set) => {
      if (!set.has(id)) return set;
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  };
  const hasConversationReplies = (conv) =>
    Boolean(conv?.hasReply) || (conv?.messageCount || 0) > 1;
  const refresh = () => {
    if (mailboxStore?.actions?.loadMessages) mailboxStore.actions.loadMessages();
    else mailboxView?.loadMessages?.();
  };
  const triggerRefreshAnimation = () => {
    refreshAnimating = true;
    if (refreshAnimationTimer) clearTimeout(refreshAnimationTimer);
    refreshAnimationTimer = setTimeout(() => {
      refreshAnimating = false;
    }, 650);
  };
  const handleRefreshClick = () => {
    triggerRefreshAnimation();
    refresh();
  };
  onDestroy(() => {
    if (refreshAnimationTimer) {
      clearTimeout(refreshAnimationTimer);
      refreshAnimationTimer = null;
    }
  });
  const toggleFilters = () =>
    source.state?.showFilters?.update?.((v) => !v) || mailboxView?.toggleFilters?.();
  const toggleSidebar = () => {
    const current = get(sidebarOpen);
    sidebarOpen.set(!current);
  };
  const toggleUnread = () =>
    source.state?.unreadOnly?.update?.((v) => !v) || mailboxView?.toggleUnreadFilter?.();
  const toggleHasAttachments = () =>
    source.state?.hasAttachmentsOnly?.update?.((v) => !v) ||
    mailboxView?.toggleAttachmentFilter?.();
  const setUnreadOnly = (next) => {
    if (source.state?.unreadOnly?.set) {
      mailboxStore.state.unreadOnly.set(next);
    } else if (mailboxView?.unreadOnly?.set) {
      mailboxView.unreadOnly.set(next);
    }
  };
  const setHasAttachmentsOnly = (next) => {
    if (source.state?.hasAttachmentsOnly?.set) {
      mailboxStore.state.hasAttachmentsOnly.set(next);
    } else if (mailboxView?.hasAttachmentsOnly?.set) {
      mailboxView.hasAttachmentsOnly.set(next);
    }
  };
  const toggleFilterByLabel = (labelId) => {
    const current = $filterByLabel || [];
    const next = current.includes(labelId)
      ? current.filter(id => id !== labelId)
      : [...current, labelId];
    if (source.state?.filterByLabel?.set) {
      mailboxStore.state.filterByLabel.set(next);
    } else if (mailboxView?.filterByLabel?.set) {
      mailboxView.filterByLabel.set(next);
    }
  };
  const setSortOrder = (order) => {
    if (mailboxStore?.actions?.setSortOrder) {
      mailboxStore.actions.setSortOrder(order);
    } else if (source.state?.sortOrder?.set) {
      mailboxStore.state.sortOrder.set(order);
    } else if (mailboxView?.sortOrder?.set) {
      mailboxView.sortOrder.set(order);
    }
  };
  const closeFilters = () => {
    source.state?.showFilters?.set?.(false);
    mailboxView?.showFilters?.set?.(false);
  };
  const getActiveMessage = () => {
    if ($threadingEnabled && $selectedConversation) {
      return $selectedConversation.messages?.slice?.(-1)?.[0];
    }
    return $selectedMessage;
  };
  const selectByOffset = (offset) => {
    const list = ($threadingEnabled ? $filteredConversations : $filteredMessages) || [];
    if (!list.length) return;
    const currentId = $threadingEnabled ? $selectedConversation?.id : $selectedMessage?.id;
    let idx = list.findIndex((item) => item.id === currentId);
    if (idx === -1) idx = offset > 0 ? -1 : list.length;
    const nextIndex = Math.min(Math.max(idx + offset, 0), list.length - 1);
    const target = list[nextIndex];
    if (!target) return;
    if ($threadingEnabled) {
      selectConversation(target);
    } else {
      selectMessage(target);
    }
  };
  const nextCandidate = () => {
    const list = ($threadingEnabled ? $filteredConversations : $filteredMessages) || [];
    return nextCandidateHelper({
      list,
      threadingEnabled: $threadingEnabled,
      selectedConversation: $selectedConversation,
      selectedMessage: $selectedMessage,
    });
  };
  const selectNextWithinConversation = () => {
    // Navigate to next message within an expanded conversation
    if (!$threadingEnabled || !$selectedConversation) return false;

    const conv = $selectedConversation;
    const isExpanded = $expandedConversations.has(conv.id);

    if (!isExpanded || !conv.messages || conv.messages.length <= 1) return false;

    const currentMsgId = $selectedMessage?.id;
    const currentIdx = conv.messages.findIndex(m => m.id === currentMsgId);

    // If we can move to next message in conversation
    if (currentIdx >= 0 && currentIdx < conv.messages.length - 1) {
      selectMessage(conv.messages[currentIdx + 1]);
      return true;
    }

    return false;
  };

  const selectPreviousWithinConversation = () => {
    // Navigate to previous message within an expanded conversation
    if (!$threadingEnabled || !$selectedConversation) return false;

    const conv = $selectedConversation;
    const isExpanded = $expandedConversations.has(conv.id);

    if (!isExpanded || !conv.messages || conv.messages.length <= 1) return false;

    const currentMsgId = $selectedMessage?.id;
    const currentIdx = conv.messages.findIndex(m => m.id === currentMsgId);

    // If we can move to previous message in conversation
    if (currentIdx > 0) {
      selectMessage(conv.messages[currentIdx - 1]);
      return true;
    }

    return false;
  };

  const selectNext = () => {
    // First try to navigate within the conversation
    if (selectNextWithinConversation()) return;
    // Otherwise navigate between conversations/messages
    selectByOffset(1);
  };

  const selectPrevious = () => {
    // First try to navigate within the conversation
    if (selectPreviousWithinConversation()) return;
    // Otherwise navigate between conversations/messages
    selectByOffset(-1);
  };
  const archiveSelected = async () => {
    const selectedMessages = getSelectedMessagesFromConversations();
    let targets = selectedMessages;

    if (!targets.length && $threadingEnabled && $selectedConversation?.messages?.length) {
      targets = $selectedConversation.messages;
    }

    if (!targets.length) {
      const activeMsg = getActiveMessage();
      targets = activeMsg ? [activeMsg] : [];
    }

    targets = dedupeMessagesHelper(targets);
    if (!targets.length) return;
    const fallback = nextCandidate();
    const releaseReaderHold =
      isProductivityLayout && fallback ? holdReaderTransition() : null;
    try {
      // Select next message immediately (before the async operation)
      if (fallback) {
        if ($threadingEnabled) selectConversation(fallback);
        else selectMessage(fallback);
      }
      if (selectedMessages.length) clearSelection();
      await archiveMessages(targets, { reload: false });
      showToast(targets.length > 1 ? `Archived ${targets.length} messages` : 'Archived', 'success');
    } catch (err) {
      console.warn('archiveSelected failed', err);
      showToast('Failed to archive', 'error');
    } finally {
      releaseReaderHold?.();
    }
  };
  const deleteSelected = async () => {
    const msg = getActiveMessage();
    if (!msg) return;
    const fallback = nextCandidate();

    const releaseReaderHold =
      isProductivityLayout && fallback ? holdReaderTransition() : null;
    deleteMessages([msg]);

    // Select the next message
    if (fallback) {
      if ($threadingEnabled) selectConversation(fallback);
      else selectMessage(fallback);
    }
    releaseReaderHold?.();
  };

  const markNotSpam = async () => {
    if (!inboxFolderPath) {
      showToast('Inbox folder not found', 'error');
      return;
    }
    const selectedMessages = getSelectedMessagesFromConversations();
    if (selectedMessages.length) {
      await bulkMoveTo(inboxFolderPath);
      return;
    }
    const msg = getActiveMessage();
    if (!msg) return;
    await moveReaderTo(inboxFolderPath);
  };

  onMount(() => {
    updateThemeState();

    // Close sidebar by default on mobile
    if (isMobileViewport()) {
      sidebarOpen.set(false);
    }

    const themeUnsub = effectiveTheme.subscribe((value) => {
      applyTheme(value || 'system');
      updateThemeState();
    });

    // Handle hash-based message deep linking with filter state
    // Format: #FOLDER/MESSAGE_ID?q=search&sort=newest&unread=1&attachments=1&starred=1
    const parseHashUrl = () => {
      const hash = window.location.hash || '';
      if (hash.length > 1) {
        const hashContent = hash.slice(1); // Remove leading #

        // Split hash from query parameters
        const queryIndex = hashContent.indexOf('?');
        const pathPart = queryIndex > 0 ? hashContent.slice(0, queryIndex) : hashContent;
        const queryPart = queryIndex > 0 ? hashContent.slice(queryIndex + 1) : '';
        const filterState = parseFilterState(queryPart);

        const slashIndex = pathPart.indexOf('/');
        if (slashIndex > 0) {
          // Format: #FOLDER/MESSAGE_ID?params
          const folder = decodeURIComponent(pathPart.slice(0, slashIndex));
          const messageId = decodeURIComponent(pathPart.slice(slashIndex + 1));
          return { folder, messageId, filterState };
        } else {
          // Format: #FOLDER?params (folder only)
          const folder = decodeURIComponent(pathPart);
          return { folder, messageId: null, filterState };
        }
      }
      return null;
    };

    const navigateToMessage = (folder: string, messageId: string | null, filterState?: UrlFilterState) => {
      // Restore filter state from URL
      if (filterState) {
        restoreFilterState(filterState);
      }

      // Ensure we're on the right folder
      const currentFolder = get(selectedFolder);
      if (currentFolder !== folder) {
        mailboxStore?.actions?.selectFolder?.(folder);
      }

      // If no messageId, just navigate to folder (clear selection)
      if (!messageId) {
        source.state?.selectedMessage?.set?.(null);
        closeReaderFullscreen({ updateUrl: false }); // URL already correct from popstate/navigation
        return;
      }

      // Wait for messages to load then select
      const trySelect = () => {
        const currentMessages = get(messagesStore);
        const msg = currentMessages.find((m) => String(m.id) === String(messageId));
        if (msg) {
          if (get(threadingEnabled)) {
            const convs = get(filteredConversations);
            const conv = convs.find((c) =>
              c.messages?.some((m) => String(m.id) === String(messageId))
            );
            if (conv) {
              selectConversation(conv, { updateUrl: false });
              return true;
            }
          }
          selectMessage(msg, { updateUrl: false });
          return true;
        }
        return false;
      };

      // Try immediately, then retry a few times as messages load
      if (!trySelect()) {
        let attempts = 0;
        const maxAttempts = 10;
        const intervalId = setInterval(() => {
          attempts++;
          if (trySelect() || attempts >= maxAttempts) {
            clearInterval(intervalId);
          }
        }, 200);
      }
    };

    // Handle browser back/forward navigation
    const handlePopState = (event: PopStateEvent) => {
      const parsed = parseHashUrl();
      // Prevent URL update during popstate handling
      skipFolderUrlUpdate = true;
      try {
        if (parsed) {
          navigateToMessage(parsed.folder, parsed.messageId, parsed.filterState);
        } else {
          // No hash - go to default folder (INBOX)
          const defaultFolder = 'INBOX';
          mailboxStore?.actions?.selectFolder?.(defaultFolder);
          source.state?.selectedMessage?.set?.(null);
          closeReaderFullscreen({ updateUrl: false }); // popstate already has correct URL
        }
      } finally {
        skipFolderUrlUpdate = false;
      }
    };

    window.addEventListener('popstate', handlePopState);

    // Handle initial hash URL on page load
    const initialHash = parseHashUrl();
    if (initialHash) {
      // Use setTimeout to ensure messages have started loading
      skipFolderUrlUpdate = true;
      setTimeout(() => {
        navigateToMessage(initialHash.folder, initialHash.messageId, initialHash.filterState);
        skipFolderUrlUpdate = false;
      }, 100);
    } else {
      // No hash - set URL to current folder after it's loaded
      setTimeout(() => {
        const folder = get(selectedFolder);
        if (folder) {
          history.replaceState({ folder }, '', buildHashUrl(folder, null));
        } else {
          mailboxStore?.actions?.selectFolder?.('INBOX');
        }
      }, 100);
    }

    let currentTooltipTarget = null;
    const tooltipSelector = '[data-tooltip]';
    const updateTooltipPosition = (target) => {
      if (!target) return;
      const tooltipText = target.getAttribute('data-tooltip');
      if (!tooltipText) return;
      const rect = target.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const margin = 16;
      const maxTooltipWidth = 280;
      const halfWidth = maxTooltipWidth / 2;
      let left = rect.left + rect.width / 2;

      if (left - halfWidth < margin) {
        left = margin + halfWidth;
      } else if (left + halfWidth > viewportWidth - margin) {
        left = viewportWidth - margin - halfWidth;
      }

      const top = Math.max(margin, rect.top - 8);
      target.style.setProperty('--tooltip-left', `${left}px`);
      target.style.setProperty('--tooltip-top', `${top}px`);
    };

    const showTooltip = (target) => {
      if (!target) return;
      currentTooltipTarget = target;
      updateTooltipPosition(target);
    };

    const hideTooltip = (target) => {
      if (!target) return;
      if (currentTooltipTarget === target) {
        currentTooltipTarget = null;
      }
    };

    const handleTooltipEnter = (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest(tooltipSelector);
      if (!target) return;
      showTooltip(target);
    };

    const handleTooltipLeave = (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest(tooltipSelector);
      if (!target) return;
      const relatedTarget = e.relatedTarget;
      if (relatedTarget && target.contains(relatedTarget)) return;
      hideTooltip(target);
    };

    const handleTooltipFocusIn = (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest(tooltipSelector);
      if (!target) return;
      showTooltip(target);
    };

    const handleTooltipFocusOut = (e) => {
      if (!e.target || typeof e.target.closest !== 'function') return;
      const target = e.target.closest(tooltipSelector);
      if (!target) return;
      hideTooltip(target);
    };

    const handleTooltipScrollResize = () => {
      if (currentTooltipTarget) {
        updateTooltipPosition(currentTooltipTarget);
      }
      if (sortMenuOpen) {
        positionDropdown('[data-sort-toggle] > button', '[data-sort-toggle] > div:last-child');
      }
      if (labelMenuOpen) {
        positionDropdown('[data-labels-toggle] > button', '[data-labels-dropdown]');
      }
    };

    const handleResize = () => {
      if (typeof window === 'undefined') return;
      // Update reactive viewport width for layout calculations
      viewportWidth = window.innerWidth;
      const small = window.innerWidth <= 900;
      showHeaderShortcuts = !small;
      if (small) {
        source.state?.sidebarOpen?.set?.(false);
        mailboxView?.sidebarOpen?.set?.(false);
      }
    };
    const handleClickOutside = (e) => {
      if ($bulkMoveOpen && !e.target?.closest?.('[data-bulk-move]')) {
        if (bulkMoveOpen?.set) {
          bulkMoveOpen.set(false);
        } else if (mailboxView?.setBulkMoveOpen) {
          mailboxView.setBulkMoveOpen(false);
        }
      }
      if (readerToolbarMoveOpen && !e.target?.closest?.('[data-reader-toolbar-move]')) {
        readerToolbarMoveOpen = false;
      }
      if ($showFiltersStore && !e.target?.closest?.('[data-filters-dropdown]') && !e.target?.closest?.('[data-filters-toggle]')) {
        closeFilters();
      }
      if (sortMenuOpen && !e.target?.closest?.('[data-sort-toggle]') && !e.target?.closest?.('[data-sort-dropdown]')) {
        sortMenuOpen = false;
      }
      if (labelMenuOpen && !e.target?.closest?.('[data-labels-toggle]') && !e.target?.closest?.('[data-labels-dropdown]')) {
        labelMenuOpen = false;
      }
      // Close action menu when clicking outside
      if (actionMenuOpen && !e.target?.closest?.('[data-action-menu]')) {
        actionMenuOpen = false;
        readerMoveOpen = false;
        readerLabelMenuOpen = false;
      }
    };
    // Mobile keyboard handling
    const handleFocusIn = (e) => {
      if (window.innerWidth > 640) return;

      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        // Add keyboard-open class to body
        document.body.classList.add('keyboard-open');

        // Scroll element into view after a short delay to let keyboard appear
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 300);
      }
    };

    const handleFocusOut = () => {
      if (window.innerWidth > 640) return;
      document.body.classList.remove('keyboard-open');
    };

    // Visual Viewport API for better keyboard handling on mobile
    let visualViewportHandler;
    if (typeof window !== 'undefined' && window.visualViewport) {
      visualViewportHandler = () => {
        if (window.innerWidth > 640) return;

        const viewport = window.visualViewport;
        const offsetTop = viewport.offsetTop;

        // Adjust scroll when keyboard appears
        if (offsetTop > 0 && document.activeElement) {
          const activeElement = document.activeElement;
          if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') {
            activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      };
      window.visualViewport.addEventListener('resize', visualViewportHandler);
    }

    handleResize();

    // Load folder expansion state
    mailboxStore?.actions?.loadExpandedState?.();

    window.addEventListener('resize', handleResize);
    window.addEventListener('resize', handleTooltipScrollResize);
    window.addEventListener('scroll', handleTooltipScrollResize, true);
    document.addEventListener('click', handleClickOutside);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('focusout', handleFocusOut);
    document.addEventListener('mouseenter', handleTooltipEnter, true);
    document.addEventListener('mouseleave', handleTooltipLeave, true);
    document.addEventListener('focusin', handleTooltipFocusIn, true);
    document.addEventListener('focusout', handleTooltipFocusOut, true);
    registerApi?.({
      selectNext,
      selectPrevious,
      archiveSelected,
      deleteSelected,
      expandSelectedThread: () => {
        const conv = get(selectedConversation);
        if (conv?.id) expandConversation(conv.id);
      },
      collapseSelectedThread: () => {
        const conv = get(selectedConversation);
        if (conv?.id) collapseConversation(conv.id);
      },
      markSelectedThreadRead: () => {
        const conv = get(selectedConversation);
        return markConversationRead(conv);
      },
      selectMessageById: (messageId: string) => {
        const currentMessages = get(messagesStore);
        const msg = currentMessages.find((m) => String(m.id) === String(messageId));
        if (msg) {
          // If threading is enabled, find and select the conversation containing this message
          if (get(threadingEnabled)) {
            const convs = get(filteredConversations);
            const conv = convs.find((c) =>
              c.messages?.some((m) => String(m.id) === String(messageId))
            );
            if (conv) {
              selectConversation(conv, { updateUrl: false });
              return true;
            }
          }
          selectMessage(msg, { updateUrl: false });
          return true;
        }
        return false;
      },
    });
    return () => {
      themeUnsub?.();
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('resize', handleTooltipScrollResize);
      window.removeEventListener('scroll', handleTooltipScrollResize, true);
      window.removeEventListener('popstate', handlePopState);
      document.removeEventListener('click', handleClickOutside);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('focusout', handleFocusOut);
      document.removeEventListener('mouseenter', handleTooltipEnter, true);
      document.removeEventListener('mouseleave', handleTooltipLeave, true);
      document.removeEventListener('focusin', handleTooltipFocusIn, true);
      document.removeEventListener('focusout', handleTooltipFocusOut, true);
      if (visualViewportHandler && window.visualViewport) {
        window.visualViewport.removeEventListener('resize', visualViewportHandler);
      }
      document.body.classList.remove('keyboard-open');
      registerApi?.(null);
    };
  });

  const toggleThreading = () => {
    const current = get(threadingEnabled);
    threadingEnabled.set(!current);
  };
  const selectAllVisible = (list = []) => {
    if (!selectionMode) {
      selectionMode = true;
      return;
    }
    const ids = (list || []).map((item) => item?.id).filter(Boolean);
    if (!ids.length) return;
    const current = get(selectedConversationIds) || [];
    const allSelected = ids.every((id) => current.includes(id));
    const next = allSelected ? [] : ids;
    mailboxStore?.actions?.setSelectedIds?.(next);
  };

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function positionDropdown(toggleSelector, panelSelector) {
    const toggle = document.querySelector(toggleSelector);
    const panel = document.querySelector(panelSelector);
    if (!toggle || !panel) return;

    panel.classList.add('fe-dropdown-fixed');
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.marginTop = '0';

    const toggleRect = toggle.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 12;
    const maxHeight = viewportHeight - margin * 2;
    const panelHeight = Math.min(panelRect.height, maxHeight);

    if (panelRect.height > maxHeight) {
      panel.style.maxHeight = `${maxHeight}px`;
      panel.style.overflowY = 'auto';
    } else {
      panel.style.maxHeight = '';
      panel.style.overflowY = '';
    }

    let left = toggleRect.right - panelRect.width;
    left = clamp(left, margin, viewportWidth - panelRect.width - margin);

    let top = toggleRect.bottom + 6;
    if (top + panelHeight > viewportHeight - margin) {
      top = toggleRect.top - panelHeight - 6;
    }
    top = clamp(top, margin, viewportHeight - margin - panelHeight);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  const toggleSelection = (item, event) => {
    if (event) event.stopPropagation?.();
    selectionMode = true;
    if (mailboxStore?.actions?.toggleConversationSelection) {
      mailboxStore.actions.toggleConversationSelection(item);
    }
    mailboxView?.toggleConversationSelection?.(item, event);
  };

  const clearSelection = () => {
    mailboxStore?.actions?.setSelectedIds?.([]);
    selectionMode = false;
  };

  const reloadMessages = async () => {
    try {
      if (mailboxStore?.actions?.loadMessages) {
        await mailboxStore.actions.loadMessages();
      }
      if (mailboxView?.loadMessages) await mailboxView.loadMessages();
    } catch {
      // ignore
    }
  };

  // Pull-to-refresh handlers
  const handlePullStart = (e) => {
    // Only activate on mobile screens
    if (window.innerWidth > 640) return;

    const container = messageListWrapper;
    if (!container || isRefreshing) return;

    if (container.scrollTop === 0) {
      const containerTop = container.getBoundingClientRect().top;
      const touchOffset = e.touches[0].clientY - containerTop;
      if (touchOffset > pullStartMaxOffset) return;

      pullToRefreshActive = true;
      pullStartY = e.touches[0].clientY;
    }
  };

  const handlePullMove = (e) => {
    if (!pullToRefreshActive || isRefreshing) return;
    if (messageListWrapper && messageListWrapper.scrollTop > 0) {
      pullToRefreshActive = false;
      isPulling = false;
      pullDistance = 0;
      return;
    }

    const currentY = e.touches[0].clientY;
    const distance = currentY - pullStartY;

    if (distance > 0) {
      isPulling = true;
      pullDistance = Math.min(distance * 0.5, 100); // Max 100px pull

      // Let native scrolling handle the gesture; keep pull state in sync.
    }
  };

  const handlePullEnd = async () => {
    if (!pullToRefreshActive) return;

    pullToRefreshActive = false;

    if (pullDistance > 60 && !isRefreshing) {
      isRefreshing = true;
      isPulling = false;

      // Reset pull distance immediately for faster feedback
      pullDistance = 0;

      try {
        await reloadMessages();
        showToast('Inbox refreshed', 'success');
      } catch (err) {
        showToast('Failed to refresh', 'error');
      } finally {
        // Only clear refreshing state after work is done
        isRefreshing = false;
      }
    } else {
      // Snap back
      isPulling = false;
      pullDistance = 0;
    }
  };

  // Swipe gesture handlers with improved physics for native feel
  const SWIPE_THRESHOLD = 80; // Distance threshold for action
  const VELOCITY_THRESHOLD = 0.5; // Velocity threshold for quick swipes (px/ms)
  const MAX_SWIPE = 120; // Max visual distance before resistance
  const RESISTANCE_FACTOR = 0.3; // Rubber-band resistance

  const applyResistance = (distance) => {
    const absDistance = Math.abs(distance);
    if (absDistance <= MAX_SWIPE) return distance;
    // Apply rubber-band resistance beyond max
    const overflow = absDistance - MAX_SWIPE;
    const resistedOverflow = overflow * RESISTANCE_FACTOR;
    return distance > 0 ? MAX_SWIPE + resistedOverflow : -(MAX_SWIPE + resistedOverflow);
  };

  const handleSwipeStart = (e, item) => {
    // Only on mobile
    if (window.innerWidth > 640) return;
    if (swipeAnimating) return;

    swipeItemId = item.id;
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    swipeStartTime = Date.now();
    swipeVelocity = 0;
    swiping = false;
  };

  const handleSwipeMove = (e, item) => {
    if (!swipeItemId || swipeItemId !== item.id) return;
    if (window.innerWidth > 640) return;
    if (swipeAnimating) return;

    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - swipeStartX;
    const deltaY = currentY - swipeStartY;

    // Determine if this is a horizontal or vertical swipe
    if (!swiping && Math.abs(deltaX) > 8) {
      // Horizontal swipe detected - require more horizontal than vertical movement
      if (Math.abs(deltaX) > Math.abs(deltaY) * 1.5) {
        swiping = true;
      } else {
        // Vertical scroll detected, cancel swipe
        resetSwipe();
        return;
      }
    }

    if (swiping) {
      // Calculate velocity for momentum
      const elapsed = Date.now() - swipeStartTime;
      if (elapsed > 0) {
        swipeVelocity = deltaX / elapsed;
      }
      // Apply rubber-band resistance
      swipeDistance = applyResistance(deltaX);
      // touch-action already constrains default scrolling on mobile
    }
  };

  const handleSwipeEnd = async (item) => {
    if (!swipeItemId || swipeItemId !== item.id) return;
    if (swipeAnimating) return;

    const distance = Math.abs(swipeDistance);
    const direction = swipeDistance > 0 ? 'right' : 'left';
    const velocity = Math.abs(swipeVelocity);

    // Trigger action if threshold met OR quick swipe with enough velocity
    const shouldTrigger = distance > SWIPE_THRESHOLD || (velocity > VELOCITY_THRESHOLD && distance > 40);

    if (shouldTrigger && swiping) {
      swipeAnimating = true;
      // Animate off screen with spring-like motion
      const screenWidth = window.innerWidth;
      swipeDistance = direction === 'right' ? screenWidth : -screenWidth;

      // Execute action after animation
      setTimeout(async () => {
        if (direction === 'right') {
          try {
            await archiveMessage(item);
            showToast('Archived', 'success');
          } catch (err) {
            showToast('Failed to archive', 'error');
          }
        } else {
          try {
            deleteMessages([item]);
          } catch (err) {
            showToast('Failed to delete', 'error');
          }
        }
        resetSwipe();
      }, 180);
    } else {
      // Snap back with spring animation
      swipeAnimating = true;
      swipeDistance = 0;
      setTimeout(() => {
        resetSwipe();
      }, 200);
    }
  };

  const resetSwipe = () => {
    swipeItemId = null;
    swipeDistance = 0;
    swiping = false;
    swipeVelocity = 0;
    swipeAnimating = false;
  };

  // Drag and drop handlers
  const handleDragStart = (e, item) => {
    // Only on desktop
    if (window.innerWidth <= 640) {
      e.preventDefault();
      return;
    }

    draggedItem = item;
    e.dataTransfer.effectAllowed = 'move';

    // Create a ghost image
    if (e.target.closest('[data-conversation-row]')) {
      const row = e.target.closest('[data-conversation-row]');
      e.dataTransfer.setDragImage(row, 0, 0);
    }

    // Set data for the drag operation
    e.dataTransfer.setData('text/plain', item.id);

    // Add dragging class for styling
    setTimeout(() => {
      document.body.classList.add('dragging');
    }, 0);
  };

  const handleDragEnd = (e) => {
    draggedItem = null;
    dragOverFolder = null;
    if (dragExpandTimeout) {
      clearTimeout(dragExpandTimeout);
      dragExpandTimeout = null;
    }
    document.body.classList.remove('dragging');
  };

  const handleFolderDragEnter = (e, folder) => {
    if (!draggedItem) return;
    e.preventDefault();

    // Don't highlight if dragging to the same folder
    if (draggedItem.folder === folder.path) return;

    dragOverFolder = folder.path;

    // Auto-expand collapsed folders after hovering for 800ms
    if (hasChildren(folder) && !$expandedFolders.has(folder.path)) {
      dragExpandTimeout = setTimeout(() => {
        toggleFolderExpansion(folder.path);
      }, 800);
    }
  };

  const handleFolderDragOver = (e, folder) => {
    if (!draggedItem) return;
    e.preventDefault();

    // Don't allow drop if dragging to the same folder
    if (draggedItem.folder === folder.path) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }

    e.dataTransfer.dropEffect = 'move';
  };

  const handleFolderDragLeave = (e, folder) => {
    if (!draggedItem) return;

    // Only clear if actually leaving the folder element
    const relatedTarget = e.relatedTarget;
    if (!relatedTarget || !e.currentTarget.contains(relatedTarget)) {
      if (dragOverFolder === folder.path) {
        dragOverFolder = null;
      }

      if (dragExpandTimeout) {
        clearTimeout(dragExpandTimeout);
        dragExpandTimeout = null;
      }
    }
  };

  const handleFolderDrop = async (e, folder) => {
    e.preventDefault();
    if (!draggedItem) return;

    // Store reference to dragged item before clearing state
    const itemToMove = draggedItem;
    const targetFolder = folder.path;
    const sourceFolder = itemToMove.folder;

    // Don't move if dropping on the same folder
    if (targetFolder === sourceFolder) {
      handleDragEnd(e);
      return;
    }

    // Clear drag state
    handleDragEnd(e);

    // Move the message/conversation
    try {
      // Check if it's a conversation (has messages array) or individual message
      const isConversation = itemToMove.messages && itemToMove.messages.length > 0;

      if (isConversation) {
        // Move all messages in the conversation
        for (const msg of itemToMove.messages) {
          if (mailboxStore?.actions?.moveMessage) {
            await mailboxStore.actions.moveMessage(msg, targetFolder, { stayInFolder: true });
          }
        }
        showToast(`Moved ${itemToMove.messages.length} message(s) to ${folder.name}`, 'success');
      } else {
        // Move single message
        if (mailboxStore?.actions?.moveMessage) {
          await mailboxStore.actions.moveMessage(itemToMove, targetFolder, { stayInFolder: true });
        }
        showToast(`Moved to ${folder.name}`, 'success');
      }
    } catch (err) {
      console.error('Failed to move message:', err);
      showToast('Failed to move message', 'error');
    }
  };

  // Reader swipe navigation handlers
  const handleReaderSwipeStart = (e) => {
    if (window.innerWidth > 640) return;
    if (!$mobileReader) return;

    readerSwipeStartX = e.touches[0].clientX;
    readerSwipeStartY = e.touches[0].clientY;
    readerSwipeDistance = 0;
    readerSwiping = false;
    readerSwipeDirection = null;
  };

  const handleReaderSwipeMove = (e) => {
    if (window.innerWidth > 640) return;
    if (!$mobileReader) return;
    if (readerSwipeStartX === 0) return;

    const currentX = e.touches[0].clientX;
    const currentY = e.touches[0].clientY;
    const deltaX = currentX - readerSwipeStartX;
    const deltaY = currentY - readerSwipeStartY;

    // Only detect horizontal swipes, allow vertical scrolling
    if (!readerSwiping && Math.abs(deltaX) > 15) {
      if (Math.abs(deltaX) > Math.abs(deltaY) * 2) {
        readerSwiping = true;
        readerSwipeDirection = deltaX > 0 ? 'right' : 'left';
      }
    }

    if (readerSwiping) {
      readerSwipeDistance = deltaX;
      // Prevent default to stop browser back/forward gesture
      e.preventDefault();
    }
  };

  const handleReaderSwipeEnd = () => {
    if (window.innerWidth > 640) return;
    if (!$mobileReader) return;

    const distance = Math.abs(readerSwipeDistance);
    const direction = readerSwipeDistance > 0 ? 'right' : 'left';

    // Threshold for navigation
    if (distance > 50 && readerSwiping) {
      if (direction === 'left') {
        // Swipe left = go to next email
        selectNext();
      } else {
        // Swipe right = go to previous email
        selectPrevious();
      }
    }

    // Reset reader swipe state
    readerSwipeStartX = 0;
    readerSwipeStartY = 0;
    readerSwipeDistance = 0;
    readerSwiping = false;
    readerSwipeDirection = null;
  };

  // Attach touchmove listener with { passive: false } to allow preventDefault
  $effect(() => {
    if (!readerPaneEl) return;
    readerPaneEl.addEventListener('touchmove', handleReaderSwipeMove, { passive: false });
    return () => {
      readerPaneEl?.removeEventListener('touchmove', handleReaderSwipeMove);
    };
  });

  const archiveMessage = async (msg) => {
    if (!msg) return;
    const targets = msg?.messages?.length ? msg.messages : [msg];
    await archiveMessages(targets);
  };

  const archiveMessages = async (messages, { reload = true } = {}) => {
    const targets = dedupeMessagesHelper(messages);
    if (!targets.length) return;
    try {
      for (const target of targets) {
        if (mailboxStore?.actions?.archiveMessage) {
          await mailboxStore.actions.archiveMessage(target);
        } else if (mailboxView?.archiveMessage) {
          await mailboxView.archiveMessage(target);
        }
      }
      if (reload) {
        await reloadMessages();
      }
    } catch (err) {
      console.error('Archive failed', err);
      throw err;
    }
  };

  const getSelectedMessagesFromConversations = () => {
    const ids = get(selectedConversationIds) || [];
    if (!ids.length) return [];
    const threadingOn = $threadingEnabled ?? true;
    if (!threadingOn) {
      const msgs = get(filteredMessages) || [];
      return msgs.filter((m) => ids.includes(m.id));
    }
    const convs = get(filteredConversations) || [];
    const byId = new Map(convs.map((c) => [c.id, c]));
    const selected = [];
    ids.forEach((id) => {
      const conv = byId.get(id);
      if (conv?.messages?.length) selected.push(...conv.messages);
    });
    const seen = new Set();
    return selected.filter((m) => {
      if (!m?.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  };

  const showToast = (msg, type = 'info') => mailboxView?.toasts?.show?.(msg, type);
  let missingMessageIdToastShown = false;
  const formatAddressList = (list = []) => displayAddresses(list).join(', ');
  const resolveAddressValue = (list, fallback) => {
    const formatted = formatAddressList(list);
    if (formatted) return formatted;
    const fallbackValue = String(fallback || '').trim();
    return fallbackValue || '';
  };
  const copyToClipboard = async (value) => {
    if (!value) return false;
    if (typeof window === 'undefined') return false;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        return true;
      }
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.pointerEvents = 'none';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  };
  const copyAddressValue = async (list, fallback, event) => {
    if (event?.target?.closest?.('button')) return;
    const value = resolveAddressValue(list, fallback);
    if (!value) return;
    const ok = await copyToClipboard(value);
    if (ok) {
      showToast('Copied to clipboard', 'success');
    } else {
      showToast('Failed to copy', 'error');
    }
  };
  const handleAddressCopyKey = (list, fallback, event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      copyAddressValue(list, fallback, event);
    }
  };
  const showMissingMessageIdToast = (action) => {
    if (missingMessageIdToastShown) return;
    showToast(`Unable to ${action}: missing server message id.`, 'error');
    missingMessageIdToastShown = true;
  };
  const getLabelId = (label) => label?.id || label?.keyword || label?.value || label?.name;
  const getLabelTargets = () => {
    const selected = getSelectedMessagesFromConversations();
    if (selected.length) return selected;
    const activeMsg = getActiveMessage();
    return activeMsg ? [activeMsg] : [];
  };
  const labelStateForTargets = (label, targets = []) => {
    const id = String(getLabelId(label) || '');
    if (!id) return 'none';
    if (!targets.length) return 'none';
    const total = targets.length;
    let withLabel = 0;
    targets.forEach((msg) => {
      const labels = msg.labels || msg.label_ids || msg.labelIds || [];
      const normalized = (labels || []).map((l) => String(l));
      if (normalized.includes(id)) withLabel += 1;
    });
    if (withLabel === 0) return 'none';
    if (withLabel === total) return 'all';
    return 'partial';
  };
  const labelState = (label) => labelStateForTargets(label, getLabelTargets());
  const getContextLabelTargets = () => {
    if (contextMenuMessage) return [contextMenuMessage];
    return [];
  };
  const contextLabelState = (label) => labelStateForTargets(label, getContextLabelTargets());
  const applyLabelToTargets = async (label) => {
    const id = getLabelId(label);
    if (!id) return;
    const targets = getLabelTargets();
    if (!targets.length) {
      showToast('Select a message to label', 'info');
      labelMenuOpen = false;
      return;
    }
    const state = labelState(label);
    const action = state === 'all' ? 'remove' : 'add';
    const seen = new Set();
    let updated = 0;
    for (const msg of targets) {
      if (!msg?.id || seen.has(msg.id)) continue;
      seen.add(msg.id);
      try {
        if (mailboxView?.contextLabel) {
          await mailboxView.contextLabel(msg, id, { action, silent: true });
        }
        updated += 1;
      } catch (err) {
        console.warn('label apply failed', err);
      }
    }
    if (updated) {
      showToast(`${action === 'remove' ? 'Removed' : 'Applied'} label for ${updated} item${updated === 1 ? '' : 's'}`, 'success');
      await mailboxView?.loadLabels?.();
    }
    labelMenuOpen = false;
  };
  const searchByLabel = (label) => {
    const id = getLabelId(label);
    if (!id) return;
    const term = `label:${id}`;
    onSearch(term);
    if (searchInputEl) {
      searchInputEl.value = term;
    }
  };

  const folderIconClass = (folder) => {
    const icon = folder?.icon || 'folder';
    // Normalize to safe class; unknown icons still use the base mask
    const safe = String(icon).toLowerCase().replace(/[^a-z0-9_-]/gi, '-');
    return `fe-folder-icon fe-icon-${safe}`;
  };

  const getFolderIcon = (folder) => {
    // Always use Send icon for the resolved sent folder
    const folderPath = (folder?.path || '').toUpperCase();
    const resolvedSent = (sentFolderPath || '').toUpperCase();
    if (resolvedSent && folderPath === resolvedSent) return Send;

    const iconType = (folder?.icon || 'folder').toLowerCase();
    const iconMap = {
      'inbox': Inbox,
      'sent': Send,
      'sent mail': Send,
      'sent items': Send,
      'drafts': FileEdit,
      'trash': Trash2,
      'deleted': Trash2,
      'archive': Archive,
      'all': Archive,
      'junk': AlertOctagon,
      'spam': ShieldAlert,
      'folder': FolderIcon
    };
    return iconMap[iconType] || FolderIcon;
  };

  // Folder management helpers
  let folderActionModal = $state(null);

  const visibleFolders = $derived.by(() => {
    const all = $folders || [];
    const expanded = $expandedFolders;

    return all.filter((folder: { level?: number; path?: string }) => {
      if ((folder.level || 0) === 0) return true; // Root level always visible

      // Check all parent folders are expanded
      const path = folder.path || '';
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const parentPath = parts.slice(0, i).join('/');
        if (!expanded.has(parentPath)) return false;
      }
      return true;
    });
  });

  const hasChildren = (folder) => {
    if (!folder || !$folders) return false;
    return mailboxStore?.actions?.hasChildren?.(folder, $folders) || false;
  };

  const getFolderMessageCount = async (folderPath) => {
    try {
      const count = await db.messages
        .where('folder')
        .equals(folderPath)
        .count();
      return count;
    } catch (err) {
      console.error('getFolderMessageCount error:', err);
      return 0;
    }
  };

  const handleFolderContextMenu = (event, folder) => {
    event.preventDefault();
    event.stopPropagation();
    folderContextMenu.set({ x: event.clientX, y: event.clientY, folder });
  };

  const closeFolderContextMenu = () => {
    folderContextMenu.set(null);
  };

  const toggleFolderExpansion = (folderPath) => {
    mailboxStore?.actions?.toggleFolderExpansion?.(folderPath);
  };

  const handleCreateRootFolder = () => {
    folderActionModal = { action: 'create', folder: null };
  };

  const handleCreateSubfolder = (folder) => {
    folderActionModal = { action: 'create', folder };
  };

  const handleRenameFolder = (folder) => {
    folderActionModal = { action: 'rename', folder };
  };

  const handleDeleteFolder = async (folder) => {
    const count = await getFolderMessageCount(folder.path);
    const message = count > 0
      ? `Delete "${folder.name || folder.path}" and ${count} message${count === 1 ? '' : 's'}? This cannot be undone.`
      : `Delete "${folder.name || folder.path}"? This cannot be undone.`;

    showConfirmDialog(
      'Delete Folder',
      message,
      async () => {
        try {
          await mailboxStore?.actions?.deleteFolder?.(folder.path);
          showToast(`Deleted folder "${folder.name || folder.path}"`, 'success');
        } catch (err) {
          showToast(`Failed to delete folder: ${err.message}`, 'error');
        }
      },
      true // danger
    );
  };

  const handleMarkFolderAsRead = async (folder) => {
    try {
      await mailboxStore?.actions?.markFolderAsRead?.(folder.path);
      showToast(`Marked all messages in "${folder.name || folder.path}" as read`, 'success');
    } catch (err) {
      showToast(`Failed to mark as read: ${err.message}`, 'error');
    }
  };

  const handleFolderActionConfirm = async (action, folder, value) => {
    try {
      if (action === 'create') {
        const parentPath = folder?.path || '';
        await mailboxStore?.actions?.createFolder?.(parentPath, value);
        showToast(`Created folder "${value}"`, 'success');
      } else if (action === 'rename') {
        await mailboxStore?.actions?.renameFolder?.(folder.path, value);
        showToast(`Renamed folder to "${value}"`, 'success');
      }
    } catch (err) {
      showToast(`Failed to ${action} folder: ${err.message}`, 'error');
    } finally {
      folderActionModal = null;
    }
  };

  const handleFolderActionClose = () => {
    folderActionModal = null;
  };

  const isSystemFolder = (folderPath) => {
    return mailboxStore?.actions?.isSystemFolder?.(folderPath) || false;
  };

  const bulkArchive = async () => {
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;

    const archivePath = mailboxStore?.actions?.getArchiveFolderPath?.() || 'Archive';
    const total = messages.length;
    if (total > 5) {
      showToast(`Archiving ${total} messages...`, 'info');
    }

    try {
      // Use optimized bulk move if available
      if (mailboxStore?.actions?.bulkMoveMessages) {
        const { success, failed } = await mailboxStore.actions.bulkMoveMessages(messages, archivePath);
        await reloadMessages();

        if (success > 0) {
          showToast(`Archived ${success} conversation${success === 1 ? '' : 's'}`, 'success');
        }
        if (failed > 0) {
          showToast(`Failed to archive ${failed} message${failed === 1 ? '' : 's'}`, 'error');
        }
      } else {
        // Fallback to individual archives
        let successCount = 0;

        for (const msg of messages) {
          try {
            if (mailboxStore?.actions?.archiveMessage) await mailboxStore.actions.archiveMessage(msg);
            else await mailboxView?.archiveMessage?.(msg);
            successCount++;
          } catch {
            // continue
          }
        }

        pruneMessages(messages.map((m) => m.id));
        clearSelection();
        await reloadMessages();
        showToast(`Archived ${successCount} conversation${successCount === 1 ? '' : 's'}`, 'success');
      }
    } catch (err) {
      showToast('Failed to archive messages', 'error');
    }
  };

  const showConfirmDialog = (title, message, action, danger = false) => {
    confirmDialogTitle = title;
    confirmDialogMessage = message;
    confirmDialogAction = action;
    confirmDialogDanger = danger;
    confirmDialogVisible = true;
  };

  const hideConfirmDialog = () => {
    confirmDialogVisible = false;
    confirmDialogTitle = '';
    confirmDialogMessage = '';
    confirmDialogAction = null;
    confirmDialogDanger = false;
  };

  const confirmAction = async () => {
    const action = confirmDialogAction;
    hideConfirmDialog();
    if (action) await action();
  };

  const deleteMessages = async (messagesToDelete) => {
    const targets = resolveDeleteTargetsHelper(messagesToDelete);
    if (!targets.length) return;

    // Remove from UI optimistically
    const currentMessages = get(messagesStore);
    const idsToRemove = new Set(targets.map((m) => m.id));
    messagesStore.set(currentMessages.filter((m) => !idsToRemove.has(m.id)));
    clearSelection();

    try {
      if (mailboxStore?.actions?.bulkDeleteMessages) {
        const { failed } = await mailboxStore.actions.bulkDeleteMessages(targets);
        if (failed > 0) {
          showToast(`Failed to delete ${failed} message${failed === 1 ? '' : 's'}`, 'error');
        }
      } else {
        for (const msg of targets) {
          if (mailboxStore?.actions?.deleteMessage) {
            await mailboxStore.actions.deleteMessage(msg);
          } else {
            await mailboxView?.deleteMessage?.(msg);
          }
        }
        pruneMessages(targets.map((m) => m.id));
      }
    } catch (err) {
      console.error('deleteMessages failed', err);
      showToast('Failed to delete some messages', 'error');
    }
  };

  const bulkDelete = async () => {
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;

    const count = messages.length;
    showConfirmDialog(
      `Delete ${count} conversation${count === 1 ? '' : 's'}?`,
      `This will move ${count === 1 ? 'this conversation' : 'these conversations'} to trash.`,
      async () => {
        deleteMessages(messages);
      },
      true
    );
  };

  const bulkMoveTo = async (path) => {
    if (!path) {
      showToast('Pick a folder to move conversations', 'info');
      return;
    }
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;

    // Close the dropdown
    bulkMoveOpen.set(false);

    const total = messages.length;
    if (total > 5) {
      showToast(`Moving ${total} messages...`, 'info');
    }

    try {
      // Use optimized bulk move if available
      if (mailboxStore?.actions?.bulkMoveMessages) {
        const { success, failed } = await mailboxStore.actions.bulkMoveMessages(messages, path);
        await reloadMessages();

        if (success > 0) {
          showToast(`Moved ${success} conversation${success === 1 ? '' : 's'}`, 'success');
        }
        if (failed > 0) {
          showToast(`Failed to move ${failed} message${failed === 1 ? '' : 's'}`, 'error');
        }
      } else {
        // Fallback to individual moves
        let successCount = 0;
        let failCount = 0;

        for (const msg of messages) {
          try {
            const result = await mailboxView?.moveMessage?.(msg, path, { stayInFolder: true });
            if (result?.success !== false) successCount++;
            else failCount++;
          } catch {
            failCount++;
          }
        }

        pruneMessages(messages.map((m) => m.id));
        clearSelection();
        await reloadMessages();

        if (successCount > 0) {
          showToast(`Moved ${successCount} conversation${successCount === 1 ? '' : 's'}`, 'success');
        }
        if (failCount > 0) {
          showToast(`Failed to move ${failCount} message${failCount === 1 ? '' : 's'}`, 'error');
        }
      }
    } catch (err) {
      showToast('Failed to move messages', 'error');
    }
  };
  const moveReaderTo = async (path) => {
    if (!path) return;
    const msg = getActiveMessage();
    if (!msg) return;
    const fallback = nextCandidate();
    const releaseReaderHold =
      isProductivityLayout && fallback ? holdReaderTransition() : null;
    readerMoveOpen = false;
    readerToolbarMoveOpen = false;
    try {
      let moveResult;
      if (mailboxStore?.actions?.moveMessage) {
        moveResult = await mailboxStore.actions.moveMessage(msg, path, { stayInFolder: true });
      } else if (mailboxView?.moveMessage) {
        moveResult = await mailboxView.moveMessage(msg, path, { stayInFolder: true });
      } else if (mailboxView?.contextMoveTo) {
        moveResult = await mailboxView.contextMoveTo(path);
      } else if (mailboxView?.bulkMoveTo) {
        moveResult = await mailboxView.bulkMoveTo(path);
      }
      if (moveResult?.success !== false) {
        showToast('Message moved', 'success');
        if (fallback) {
          if ($threadingEnabled) selectConversation(fallback);
          else selectMessage(fallback);
        }
      }
      await reloadMessages();
    } catch (err) {
      showToast('Failed to move message', 'error');
    } finally {
      releaseReaderHold?.();
    }
  };

  // Helper for parallel bulk message updates
  const bulkUpdateMessages = async (messages, { payload, skipIf, onSuccess, successVerb, failVerb }) => {
    const CONCURRENCY = 6;
    let updatedCount = 0;
    let missingIdCount = 0;
    let failedCount = 0;

    // Filter messages and prepare work items
    const workItems = [];
    for (const msg of messages) {
      if (skipIf?.(msg)) continue;
      const apiId = getMessageApiId(msg);
      if (!apiId) {
        missingIdCount++;
        continue;
      }
      workItems.push({ msg, apiId });
    }

    // Process in parallel chunks
    for (let i = 0; i < workItems.length; i += CONCURRENCY) {
      const chunk = workItems.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        chunk.map(async ({ msg, apiId }) => {
          await Remote.request('MessageUpdate', payload, {
            method: 'PUT',
            pathOverride: `/v1/messages/${encodeURIComponent(apiId)}`
          });
          onSuccess?.(msg);
          return true;
        })
      );
      results.forEach((r) => (r.status === 'fulfilled' ? updatedCount++ : failedCount++));
    }

    clearSelection();
    await reloadMessages();

    if (updatedCount > 0) {
      showToast(`${successVerb} ${updatedCount} message${updatedCount === 1 ? '' : 's'}`, 'success');
    }
    if (missingIdCount > 0) {
      showToast(`Skipped ${missingIdCount} message${missingIdCount === 1 ? '' : 's'}: missing server message id`, 'error');
    }
    if (failedCount > 0) {
      showToast(`Failed to ${failVerb} ${failedCount} message${failedCount === 1 ? '' : 's'}`, 'error');
    }
  };

  const bulkMarkAsRead = async () => {
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;
    await bulkUpdateMessages(messages, {
      payload: { seen: true },
      skipIf: (msg) => msg.seen,
      onSuccess: (msg) => (msg.seen = true),
      successVerb: 'Marked',
      failVerb: 'mark',
    });
  };

  const bulkMarkAsUnread = async () => {
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;
    await bulkUpdateMessages(messages, {
      payload: { seen: false },
      skipIf: (msg) => !msg.seen,
      onSuccess: (msg) => (msg.seen = false),
      successVerb: 'Marked',
      failVerb: 'mark',
    });
  };

  const bulkStar = async () => {
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;
    await bulkUpdateMessages(messages, {
      payload: { flagged: true },
      skipIf: (msg) => msg.flagged,
      onSuccess: (msg) => (msg.flagged = true),
      successVerb: 'Starred',
      failVerb: 'star',
    });
  };

  const bulkUnstar = async () => {
    const messages = getSelectedMessagesFromConversations();
    if (!messages.length) return;
    await bulkUpdateMessages(messages, {
      payload: { flagged: false },
      skipIf: (msg) => !msg.flagged,
      onSuccess: (msg) => (msg.flagged = false),
      successVerb: 'Unstarred',
      failVerb: 'unstar',
    });
  };

  const openContextMenu = (event, item) => {
    event?.preventDefault?.();
    const isConversation = Array.isArray(item?.messages);
    const msg = isConversation ? item?.messages?.slice?.(-1)?.[0] : item;
    if (!msg) return;
    contextMenuConversation = isConversation ? item : null;
    contextMenuMessage = { ...msg };
    const padding = 8;
    const menuW = 240;
    const menuH = 300;
    const submenuW = 220;
    const { clientX = 0, clientY = 0 } = event || {};
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    contextMenuFlipX = clientX + menuW > vw;
    contextMenuFlipY = clientY + menuH > vh;
    contextMenuX = contextMenuFlipX ? Math.max(padding, clientX - menuW) : clientX;
    contextMenuY = contextMenuFlipY ? Math.max(padding, clientY - menuH) : clientY;
    contextMenuVisible = true;
    contextMoveOpen = false;
    contextLabelOpen = false;
    contextSubmenusEnabled = !isMobileViewport();
    contextSubmenuFlipX = contextMenuX + menuW + submenuW > vw;
    contextSubmenuMaxHeight = Math.max(160, vh - padding * 2);
    contextSubmenuShiftY = 0;
  };

  const closeContextMenu = () => {
    contextMenuVisible = false;
    contextMoveOpen = false;
    contextLabelOpen = false;
    contextMenuConversation = null;
    contextSubmenuShiftY = 0;
  };

  const updateContextSubmenuPosition = async (getSubmenuEl) => {
    if (typeof window === 'undefined') return;
    await tick();
    const submenuEl = typeof getSubmenuEl === 'function' ? getSubmenuEl() : getSubmenuEl;
    if (!submenuEl) return;
    const padding = 8;
    const vh = window.innerHeight || 0;
    const rect = submenuEl.getBoundingClientRect();

    // Calculate available space below and above the submenu's starting position
    const spaceBelow = vh - padding - rect.top;
    const spaceAbove = rect.top - padding;

    // If more space above, flip the submenu to extend upward
    contextSubmenuFlipY = spaceAbove > spaceBelow && spaceBelow < 300;

    // Use the larger of the two spaces, with a minimum of 160px
    const availableSpace = Math.max(160, contextSubmenuFlipY ? spaceAbove : spaceBelow);
    contextSubmenuMaxHeight = availableSpace;

    // When flipped vertically, no shift needed as it extends upward
    // When not flipped, shift down if near top of viewport
    const contentHeight = Math.max(submenuEl.scrollHeight || 0, rect.height);
    const menuHeight = Math.min(contentHeight, availableSpace);
    let shift = 0;
    if (!contextSubmenuFlipY) {
      // Normal positioning (extends downward)
      const projectedBottom = rect.top + menuHeight;
      if (projectedBottom > vh - padding) {
        shift = vh - padding - projectedBottom;
      }
      if (rect.top + shift < padding) {
        shift = padding - rect.top;
      }
    }
    contextSubmenuShiftY = shift;
  };

  const toggleContextMoveMenu = () => {
    if (!contextSubmenusEnabled) return;
    contextMoveOpen = !contextMoveOpen;
    if (contextMoveOpen) {
      contextLabelOpen = false;
      updateContextSubmenuPosition(() => contextMoveSubmenuEl);
    }
  };

  const toggleContextLabelMenu = () => {
    if (!contextSubmenusEnabled) return;
    contextLabelOpen = !contextLabelOpen;
    if (contextLabelOpen) {
      contextMoveOpen = false;
      updateContextSubmenuPosition(() => contextLabelSubmenuEl);
    }
  };

  const contextToggleRead = () => {
    if (!contextMenuMessage) return;
    // If context menu is on a conversation and the message is unread, mark all messages as read
    if (contextMenuConversation && contextMenuMessage.is_unread) {
      markConversationRead(contextMenuConversation);
    } else {
      toggleReadMessage(contextMenuMessage);
    }
    closeContextMenu();
  };

  const contextReply = () => {
    if (!contextMenuMessage) return;
    mailboxView?.replyTo?.(contextMenuMessage);
    closeContextMenu();
  };

  const contextForward = () => {
    if (!contextMenuMessage) return;
    mailboxView?.forwardMessage?.(contextMenuMessage);
    closeContextMenu();
  };

  const contextArchive = async () => {
    if (!contextMenuMessage && !contextMenuConversation) return;
    const messageToArchive = contextMenuConversation?.messages?.length
      ? contextMenuConversation.messages
      : [contextMenuMessage];
    closeContextMenu();
    try {
      await archiveMessages(messageToArchive);
      showToast(messageToArchive.length > 1 ? `Archived ${messageToArchive.length} messages` : 'Archived', 'success');
    } catch (err) {
      showToast('Failed to archive', 'error');
    }
  };

  const contextDelete = async () => {
    if (!contextMenuMessage) return;
    const messageToDelete = contextMenuMessage;
    closeContextMenu();
    try {
      if (mailboxStore?.actions?.deleteMessage) await mailboxStore.actions.deleteMessage(messageToDelete);
      else await mailboxView?.deleteMessage?.(messageToDelete);
      showToast('Deleted', 'success');
      await reloadMessages();
    } catch (err) {
      showToast('Failed to delete', 'error');
    }
  };

  const contextMoveTo = async (path) => {
    if (!path || !contextMenuMessage) return;
    const messageToMove = contextMenuMessage;
    closeContextMenu();
    try {
      if (mailboxStore?.actions?.moveMessage) await mailboxStore.actions.moveMessage(messageToMove, path, { stayInFolder: true });
      else if (mailboxView?.contextMoveTo) await mailboxView.contextMoveTo(path);
      else if (mailboxView?.bulkMoveTo) await mailboxView.bulkMoveTo(path);
      showToast('Message moved', 'success');
      await reloadMessages();
    } catch (err) {
      showToast('Failed to move message', 'error');
    }
  };

  const contextLabel = async (id) => {
    if (!id || !mailboxView?.contextLabel) return;
    const messageToLabel = contextMenuMessage;
    closeContextMenu();
    await mailboxView.contextLabel(messageToLabel, id);
  };

  const normalizeFolderKey = (value) => String(value || '').trim().toUpperCase();
  const matchesFolderKey = (value, candidates = []) => {
    const key = normalizeFolderKey(value);
    if (!key) return false;
    return (candidates || []).some((candidate) => {
      const match = normalizeFolderKey(candidate);
      if (!match) return false;
      return key === match || key.endsWith(`/${match}`) || key.endsWith(`.${match}`);
    });
  };
  const resolveFolderPath = (actionName, candidates = [], folderList = []) => {
    const action = actionName && mailboxStore?.actions?.[actionName];
    if (typeof action === 'function') {
      return action();
    }
    const match = (folderList || []).find((f) =>
      matchesFolderKey(f?.path || f?.name, candidates),
    );
    return match?.path || candidates[0] || '';
  };

  const resolveDraftsFolderPath = (account, folderList = []) => {
    const customFolder = getEffectiveSettingValue('drafts_folder', { account });
    if (customFolder) return customFolder;
    const match = (folderList || []).find((f) => {
      const pathKey = normalizeFolderKey(f?.path);
      const nameKey = normalizeFolderKey(f?.name);
      return (
        pathKey === 'DRAFTS' ||
        nameKey === 'DRAFTS' ||
        pathKey === 'DRAFT' ||
        nameKey === 'DRAFT'
      );
    });
    return match?.path || 'Drafts';
  };

  const draftsFolderPath = $derived(resolveDraftsFolderPath(
    $currentAccount || Local.get('email') || 'default',
    $folders,
  ));
  const sentFolderPath = $derived(resolveFolderPath(
    'getSentFolderPath',
    ['SENT', 'SENT MAIL', 'SENT ITEMS'],
    $folders,
  ));
  const trashFolderPath = $derived(resolveFolderPath(
    'getTrashFolderPath',
    ['TRASH', 'DELETED', 'DELETED ITEMS'],
    $folders,
  ));
  const archiveFolderPath = $derived(resolveFolderPath('getArchiveFolderPath', ['ARCHIVE'], $folders));
  const inboxFolderPath = $derived(resolveFolderPath(null, ['INBOX'], $folders));

  const isDraftFolder = (folder) => {
    const folderKey = normalizeFolderKey(folder);
    const draftsKey = normalizeFolderKey(draftsFolderPath);
    if (!folderKey) return false;
    if (draftsKey && folderKey === draftsKey) return true;
    return folderKey === 'DRAFTS' || folderKey === 'DRAFT';
  };

  const isDraftMessage = (msg) =>
    msg && (isDraftFolder(msg.folder) || isDraftFolder(get(selectedFolder)));

  const readerFolderPath = $derived(
    $selectedMessage?.folder || $selectedMessage?.folder_path || $selectedFolder || '');
  const readerFolderKey = $derived(normalizeFolderKey(readerFolderPath));
  const sentFolderKey = $derived(normalizeFolderKey(sentFolderPath));
  const trashFolderKey = $derived(normalizeFolderKey(trashFolderPath));
  const archiveFolderKey = $derived(normalizeFolderKey(archiveFolderPath));
  const listFolderKey = $derived(normalizeFolderKey($selectedFolder));
  const listIsSentFolder = $derived(sentFolderKey
    ? listFolderKey === sentFolderKey
    : matchesFolderKey($selectedFolder, ['SENT', 'SENT MAIL', 'SENT ITEMS']));
  const readerIsSentFolder = $derived(sentFolderKey
    ? readerFolderKey === sentFolderKey
    : matchesFolderKey(readerFolderPath, ['SENT', 'SENT MAIL', 'SENT ITEMS']));
  const readerIsTrashFolder = $derived(trashFolderKey
    ? readerFolderKey === trashFolderKey
    : matchesFolderKey(readerFolderPath, ['TRASH', 'DELETED', 'DELETED ITEMS']));
  const readerIsArchiveFolder = $derived(archiveFolderKey
    ? readerFolderKey === archiveFolderKey
    : matchesFolderKey(readerFolderPath, ['ARCHIVE']));
  const readerIsDraftFolder = $derived(isDraftFolder(readerFolderPath));
  const readerIsSpamFolder = $derived(matchesFolderKey(readerFolderPath, ['SPAM']));
  const readerIsJunkFolder = $derived(matchesFolderKey(readerFolderPath, ['JUNK']));
  const readerIsSpamOrJunk = $derived(readerIsSpamFolder || readerIsJunkFolder);
  const canArchive = $derived(
    !readerIsArchiveFolder &&
    !readerIsSentFolder &&
    !readerIsDraftFolder &&
    !readerIsTrashFolder &&
    !readerIsSpamOrJunk);
  const canToggleRead = $derived(
    !readerIsSentFolder &&
    !readerIsDraftFolder &&
    !readerIsTrashFolder &&
    !readerIsSpamOrJunk);
  const canReply = $derived(!readerIsSentFolder && !readerIsDraftFolder);
  const canForward = $derived(!readerIsDraftFolder);
  const canDownloadOriginal = $derived(!readerIsDraftFolder);
  const canViewOriginal = $derived(!readerIsDraftFolder);
  const canEditDraft = $derived($selectedMessage && isDraftMessage($selectedMessage));
  const canNotSpam = $derived(readerIsSpamOrJunk);
  const showReaderMenuDivider = $derived(canReply || canForward || canEditDraft || canToggleRead);

  const openDraftFromMessage = async (msg) => {
    if (!msg || !mailboxView?.composeModal?.open) return;
    const account = $currentAccount || Local.get('email') || 'default';
    const candidates = [msg.id, msg.message_id, msg.header_message_id, msg.uid].filter(Boolean);
    let draft = null;
    try {
      const drafts = await db.drafts.where('account').equals(account).toArray();
      draft = drafts.find((d) => candidates.includes(d.serverId) || candidates.includes(d.id));
    } catch {
      // ignore lookup errors
    }
    if (draft?.id) {
      // Local draft exists - open it with source message ID for deletion when discarded
      mailboxView.composeModal.open({ draftId: draft.id, sourceMessageId: msg.id });
      return;
    }
    let cachedBody = null;
    try {
      cachedBody = await db.messageBodies.get([account, msg.id]);
    } catch {
      // ignore cache lookup errors
    }
    // No local draft - open with message content and track source for deletion
    mailboxView.composeModal.open({
      to: msg.to,
      cc: msg.cc,
      subject: msg.subject || '',
      html: cachedBody?.body || msg.body || '',
      text: cachedBody?.textContent || msg.text || '',
      sourceMessageId: msg.id,
    });
  };

  const contextEditDraft = async () => {
    if (!contextMenuMessage) return;
    await openDraftFromMessage(contextMenuMessage);
    closeContextMenu();
  };
  const openLabelModal = () => {
    labelFormName = '';
    labelFormColor = pickLabelColor();
    labelModalError = '';
    labelModalVisible = true;
    labelMenuOpen = false;
    contextLabelOpen = false;
  };
  const closeLabelModal = () => {
    labelModalVisible = false;
    labelModalError = '';
  };
  const clearLabelModalError = () => {
    if (labelModalError) labelModalError = '';
  };
  const saveLabelModal = async () => {
    const validation = validateLabelName(labelFormName);
    if (!validation.ok) {
      labelModalError = validation.error;
      return;
    }
    const name = validation.value;
    labelModalSaving = true;
    labelModalError = '';
    try {
      const result = await mailboxView?.createLabel?.(name, (labelFormColor || '').trim());
      if (!result?.success) {
        labelModalError = result?.error || 'Unable to create label.';
        return;
      }
      closeLabelModal();
    } catch (err) {
      labelModalError = err?.message || 'Unable to create label.';
    } finally {
      labelModalSaving = false;
    }
  };
  const promptCreateLabel = () => openLabelModal();

  const toggleReadMessage = async (msg) => {
    if (!msg) return;
    const list = source.state?.messages ? get(messagesStore) || [] : [];
    const current = list.find((m) => m.id === msg.id) || msg;
    const newIsUnread = !current.is_unread;

    // When threading is enabled and marking as READ, mark all messages in the thread
    if (!newIsUnread && $threadingEnabled) {
      const conv = get(selectedConversation) || get(filteredConversations).find(c =>
        c.messages?.some(m => m.id === msg.id)
      );
      if (conv?.messages?.length > 1) {
        await markConversationRead(conv);
        actionMenuOpen = false;
        refresh();
        return;
      }
    }

    const currentFlags = Array.isArray(current.flags) ? current.flags : [];
    const newFlags = new Set(currentFlags);
    if (newIsUnread) newFlags.delete('\\Seen');
    else newFlags.add('\\Seen');
    const updated = {
      ...current,
      is_unread: newIsUnread,
      is_unread_index: newIsUnread ? 1 : 0,
      flags: Array.from(newFlags),
    };
    if (source.state?.messages?.set) {
      mailboxStore.state.messages.set(list.map((m) => (m.id === updated.id ? updated : m)));
    }
    mailboxStore?.actions?.addPendingFlagMutation?.(updated.id, {
      is_unread: newIsUnread,
      is_unread_index: newIsUnread ? 1 : 0,
      flags: updated.flags,
    });
    source.state?.selectedMessage?.set?.(updated);
    if (typeof mailboxView?.messages === 'function') {
      try {
        const existing = mailboxView.messages?.() || [];
        mailboxView.messages(existing.map((m) => (m.id === updated.id ? updated : m)));
      } catch {
        // ignore
      }
    }
    mailboxView?.selectedMessage?.set?.({ ...updated });
    actionMenuOpen = false;
    try {
      const apiId = getMessageApiId(updated);
      if (!apiId) {
        console.warn('toggleRead failed: missing message id');
        showMissingMessageIdToast('update read status');
        reloadMessages();
        return;
      }
      await Remote.request(
        'MessageUpdate',
        { flags: updated.flags },
        {
          method: 'PUT',
          pathOverride: `/v1/messages/${encodeURIComponent(apiId)}`,
        },
      );
      const account = Local.get('email') || 'default';
      await db.messages
        .where('[account+id]')
        .equals([account, updated.id])
        .modify({ is_unread: newIsUnread, is_unread_index: newIsUnread ? 1 : 0, flags: updated.flags });
      mailboxStore.actions.updateFolderUnreadCounts();
      refresh();
    } catch (err) {
      console.warn('toggleRead failed', err);
      reloadMessages();
    }
  };

  const markMessageRead = async (msg) => {
    if (!msg?.is_unread) return;
    const list = source.state?.messages ? get(messagesStore) || [] : [];
    const current = list.find((m) => m.id === msg.id) || msg;
    if (!current.is_unread) return;
    const previousList = list;
    const currentFlags = Array.isArray(current.flags) ? current.flags : [];
    const newFlags = new Set(currentFlags);
    newFlags.add('\\Seen');
    const updated = { ...current, is_unread: false, is_unread_index: 0, flags: Array.from(newFlags) };
    if (source.state?.messages?.set) {
      mailboxStore.state.messages.set(list.map((m) => (m.id === updated.id ? updated : m)));
    }
    mailboxStore?.actions?.addPendingFlagMutation?.(updated.id, {
      is_unread: false,
      is_unread_index: 0,
      flags: updated.flags,
    });
    source.state?.selectedMessage?.set?.(updated);
    if (typeof mailboxView?.messages === 'function') {
      try {
        const existing = mailboxView.messages?.() || [];
        mailboxView.messages(existing.map((m) => (m.id === updated.id ? updated : m)));
      } catch {
        // ignore
      }
    }
    mailboxView?.selectedMessage?.set?.({ ...updated });
    try {
      const apiId = getMessageApiId(updated);
      if (!apiId) {
        console.warn('markMessageRead failed: missing message id');
        showMissingMessageIdToast('mark as read');
        reloadMessages();
        return;
      }
      await Remote.request(
        'MessageUpdate',
        { flags: updated.flags },
        {
          method: 'PUT',
          pathOverride: `/v1/messages/${encodeURIComponent(apiId)}`,
        },
      );
      const account = Local.get('email') || 'default';
      const changes = { is_unread: false, is_unread_index: 0, flags: updated.flags };
      await db.messages.where('[account+id]').equals([account, updated.id]).modify(changes);
      mailboxStore.actions.updateFolderUnreadCounts();
    } catch (err) {
      console.warn('markMessageRead failed', err);
      if (source.state?.messages?.set && previousList) {
        mailboxStore.state.messages.set(previousList);
      }
      if (source.state?.selectedMessage?.set) {
        mailboxStore.state.selectedMessage.set(current);
      }
      if (typeof mailboxView?.messages === 'function') {
        try {
          const existing = mailboxView.messages?.() || [];
          mailboxView.messages(
            existing.map((m) => (m.id === current.id ? { ...m, is_unread: current.is_unread, flags: current.flags } : m)),
          );
        } catch {
          // ignore
        }
      }
      mailboxView?.selectedMessage?.set?.({ ...current });
    }
  };

  const markConversationRead = async (conv) => {
    if (!conv) return;
    const msgs = Array.isArray(conv.messages) ? conv.messages : [];
    // Get the latest message list from the store for fresh is_unread state
    const currentList = source.state?.messages ? get(messagesStore) || [] : [];
    for (const message of msgs) {
      // Use the store's version of the message to get the latest is_unread state
      const storeMsg = currentList.find((m) => m.id === message.id);
      const target = storeMsg || message;
      if (!target.is_unread) continue;
      await markMessageRead(target);
    }
  };

  // Maximum time to wait for message loading before forcing reset (prevents frozen UI)
  const MESSAGE_LOAD_TIMEOUT = 60000; // 60 seconds

  const loadMessage = async (msg) => {
    if (!msg) {
      return;
    }

    if (messageLoadInProgress && activeMessageId === msg.id) {
      return;
    }

    const previousAbort = messageLoadAbort;
    const previousMessageId = activeMessageId;
    if (previousAbort && previousMessageId && previousMessageId !== msg.id) {
      previousAbort.abort();
    }

    // Reset loading state immediately when starting a new load.
    // This prevents the skeleton from showing briefly when switching from
    // an in-progress/aborted load to a cached message, since the aborted
    // load's onLoading(false) callback is ignored (due to isActiveLoad() check).
    source.state?.messageLoading?.set?.(false);

    // Clear previous message state immediately when switching messages.
    // This prevents showing stale content from the previous message.
    source.state?.messageBody?.set?.('');
    source.state?.attachments?.set?.([]);
    pgpLocked.set(false);
    hasBlockedImages.set(false);
    trackingPixelCount.set(0);
    blockedImageCount.set(0);

    // Track the active load so stale completions don't clobber UI
    messageLoadInProgress = true;
    activeMessageId = msg.id;
    const loadId = ++messageLoadSequence;
    activeMessageLoad = loadId;
    const abortController =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    messageLoadAbort = abortController;

    // Safety timeout to prevent indefinite loading state
    let safetyTimeoutId = null;
    let loadCompleted = false;
    const isActiveLoad = () => activeMessageLoad === loadId;

    const resetLoadingState = () => {
      if (!isActiveLoad()) return;
      if (!loadCompleted) {
        loadCompleted = true;
        messageLoadInProgress = false;
        activeMessageLoad = 0;
        source.state?.messageLoading?.set?.(false);
      }
    };

    // Start safety timeout - will force reset loading state if loadMessageDetail hangs
    safetyTimeoutId = setTimeout(() => {
      if (!loadCompleted && isActiveLoad()) {
        console.warn('[Mailbox] Message load timed out after', MESSAGE_LOAD_TIMEOUT, 'ms');
        if (abortController && messageLoadAbort === abortController) {
          abortController.abort();
        }
        resetLoadingState();
        mailboxView?.toasts?.show?.('Message loading timed out. Please try again.', 'error');
      }
    }, MESSAGE_LOAD_TIMEOUT);

    try {
      const tracer = createPerfTracer('message.select', {
        id: msg.id,
        folder: msg.folder,
        source: 'click',
        threading: $threadingEnabled,
      });
      tracer.stage('select_start');
      source.state?.selectedMessage?.set?.(msg);
      markMessageRead(msg);
      tracer.stage('load_detail_start');
      await mailService.loadMessageDetail(msg, {
        onLoading: (val) => {
          // Only set loading state if we haven't timed out
          if (!loadCompleted && isActiveLoad()) {
            source.state?.messageLoading?.set?.(val);
            // On cache miss (loading=true), clear old body before showing skeleton.
            // For cache hits, body is never cleared - old content stays visible until new arrives.
            if (val) {
              source.state?.messageBody?.set?.('');
              source.state?.attachments?.set?.([]);
            }
          }
        },
        onBody: (body) => {
          const isActive = isActiveLoad();
          if (!isActive) {
            return;
          }
          // Extra safety: verify the message ID still matches the selected message
          const currentSelected = source.state?.selectedMessage ? get(selectedMessage) : null;
          if (currentSelected?.id !== msg.id) {
            return;
          }
          // Process quoted content for collapsible display
          const processedBody = processQuotedContent(body, { collapseByDefault: true });
          source.state?.messageBody?.set?.(processedBody);
          // Quote toggles are now handled inside EmailIframe via postMessage
        },
        onImageStatus: (status) => {
          if (!isActiveLoad()) return;
          hasBlockedImages.set(status.hasBlockedImages || false);
          trackingPixelCount.set(status.trackingPixelCount || 0);
          blockedImageCount.set(status.blockedRemoteImageCount || 0);
        },
        onAttachments: (atts) => {
          if (!isActiveLoad()) return;
          source.state?.attachments?.set?.(atts);
        },
        onPgpStatus: (status) => {
          if (!isActiveLoad()) return;
          pgpLocked.set(status.locked || false);
        },
        onMeta: (meta) => {
          if (!isActiveLoad()) return;
          if (!meta) return;
          const nodemailerHeaders = meta.nodemailer?.headers || {};
          const pickValueArray = (field) =>
            meta.nodemailer?.[field]?.value ||
            nodemailerHeaders?.[field]?.value ||
            meta[field]?.value ||
            nodemailerHeaders?.[field]?.value ||
            null;
          const headerLines =
            meta.headerLines ||
            meta.HeaderLines ||
            meta.nodemailer?.headerLines ||
            nodemailerHeaders?.headerLines ||
            null;
          const headersText =
            meta.headers ||
            meta.Headers ||
            meta.rawHeaders ||
            meta.RawHeaders ||
            meta.nodemailer?.headers ||
            null;
          const rawHeaderPayload =
            meta.raw ||
            meta.Raw ||
            meta.rawBody ||
            meta.rawEml ||
            meta.eml ||
            meta.original ||
            meta.originalMessage ||
            meta.rawMessage ||
            null;
          const replyToHeaderList = extractAddressList(
            {
              headers: headersText,
              headerLines,
              raw: rawHeaderPayload,
              nodemailer: meta.nodemailer,
            },
            'replyTo',
          );
          const fromList = extractAddressList(meta, 'from');
          const fromDisplay = displayAddresses(fromList).join(', ');
          const fallbackFrom =
            meta.from?.text ||
            meta.From?.text ||
            meta.from ||
            meta.From ||
            nodemailerHeaders?.from ||
            nodemailerHeaders?.From ||
            '';
          const resolvedFrom =
            fromDisplay || (typeof fallbackFrom === 'string' ? fallbackFrom : '') || msg.from || '';
          const enriched = {
            ...msg,
            nodemailer: meta.nodemailer || meta.nodemailer === false ? meta.nodemailer : meta,
            to: pickValueArray('to') || meta.to?.text || msg.to,
            cc: pickValueArray('cc') || meta.cc?.text || msg.cc,
            replyTo:
              replyToHeaderList.length
                ? replyToHeaderList
                : pickValueArray('replyTo') ||
                  pickValueArray('reply_to') ||
                  meta.replyTo?.text ||
                  meta.reply_to?.text ||
                  msg.replyTo ||
                  msg.reply_to,
            from: resolvedFrom,
          };
          source.state?.selectedMessage?.set?.(enriched);
          if (resolvedFrom && resolvedFrom !== msg.from) {
            const currentMessages = source.state?.messages ? get(messagesStore) || [] : [];
            if (currentMessages.length && source.state?.messages?.set) {
              mailboxStore.state.messages.set(
                currentMessages.map((item) =>
                  item.id === msg.id ? { ...item, from: resolvedFrom } : item,
                ),
              );
            }
            const account = Local.get('email') || 'default';
            db.messages
              .where('[account+id]')
              .equals([account, msg.id])
              .modify({ from: resolvedFrom, updatedAt: Date.now() })
              .catch(() => {
                // ignore db update errors
              });
          }
        },
        onError: (err) => {
          if (!isActiveLoad()) return;
          mailboxView?.toasts?.show?.(err?.message || 'Unable to load message', 'error');
        },
        perf: tracer,
        signal: abortController?.signal,
      });
      tracer.end({ status: 'render_dispatched' });
    } finally {
      // Clear safety timeout and reset loading state
      if (safetyTimeoutId) {
        clearTimeout(safetyTimeoutId);
      }
      resetLoadingState();
      if (messageLoadAbort === abortController) {
        messageLoadAbort = null;
      }
    }
  };

  const pruneMessages = (ids = []) => {
    if (!Array.isArray(ids) || !ids.length) return;
    const currentMessages = source.state?.messages ? get(messagesStore) || [] : [];
    if (source.state?.messages?.set) {
      mailboxStore.state.messages.set(currentMessages.filter((m) => !ids.includes(m.id)));
    }
    if (typeof mailboxView?.messages === 'function') {
      try {
        const existing = mailboxView.messages?.() || [];
        mailboxView.messages(existing.filter((m) => !ids.includes(m.id)));
      } catch {
        // ignore
      }
    }
  };
  const nextPage = () => {
    if ($hasNextPage) {
      page.update(p => p + 1);
      if (mailboxStore?.actions?.loadMessages) {
        mailboxStore.actions.loadMessages();
      } else {
        mailboxView.loadMessages?.();
      }
    }
  };
  const prevPage = () => {
    if ($page > 1) {
      page.update(p => p - 1);
      if (mailboxStore?.actions?.loadMessages) {
        mailboxStore.actions.loadMessages();
      } else {
        mailboxView.loadMessages?.();
      }
    }
  };

  const loadRemoteImages = () => {
    const currentBody = get(messageBody);
    if (!currentBody) return;

    // Load regular images but NOT tracking pixels (privacy-preserving)
    const bodyWithImages = restoreBlockedImages(currentBody, { includeTrackingPixels: false });

    // Force re-render by clearing and then setting
    source.state?.messageBody?.set?.('');
    setTimeout(() => {
      source.state?.messageBody?.set?.(bodyWithImages);
      hasBlockedImages.set(get(trackingPixelCount) > 0); // Still blocked if pixels remain
      blockedImageCount.set(0);
    }, 0);
  };

  const loadAllIncludingPixels = () => {
    const currentBody = get(messageBody);
    if (!currentBody) return;

    // Load everything including tracking pixels
    const bodyWithEverything = restoreBlockedImages(currentBody, { includeTrackingPixels: true });

    // Force re-render by clearing and then setting
    source.state?.messageBody?.set?.('');
    setTimeout(() => {
      source.state?.messageBody?.set?.(bodyWithEverything);
      hasBlockedImages.set(false);
      trackingPixelCount.set(0);
      blockedImageCount.set(0);
    }, 0);
  };

  // Handler for iframe link clicks
  const handleIframeLinkClick = (url: string, isMailto: boolean) => {
    if (isMailto) {
      const parsed = parseMailto(url);
      mailboxView?.composeModal?.open?.(mailtoToPrefill(parsed));
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  // Handler for iframe form submissions (blocked)
  const handleIframeFormSubmit = (action: string, method: string, data: Record<string, unknown>) => {
    console.warn('[EmailIframe] Form submission blocked:', { action, method, data });
  };

  // Store link click handler references to avoid duplicate listeners
  const linkHandlers = new WeakMap();

  // Helper function to make all links open in new tabs
  const setupLinkHandlers = (container) => {
    if (!container) return;

    // Remove old listener if exists
    const oldHandler = linkHandlers.get(container);
    if (oldHandler) {
      container.removeEventListener('click', oldHandler);
    }

    const handleLinkClick = (e) => {
      const link = e.target.closest('a');
      const href = link?.getAttribute?.('href') || link?.href;
      if (href && href.toLowerCase().startsWith('mailto:')) {
        e.preventDefault();
        const parsed = parseMailto(href);
        mailboxView?.composeModal?.open?.(mailtoToPrefill(parsed));
        return;
      }
      if (link && link.href) {
        e.preventDefault();
        window.open(link.href, '_blank', 'noopener,noreferrer');
      }
    };

    container.addEventListener('click', handleLinkClick);
    linkHandlers.set(container, handleLinkClick);

    // Also add target="_blank" to all links for accessibility
    const links = container.querySelectorAll('a');
    links.forEach(link => {
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    });
  };

  // Note: Email message link handlers are now handled by EmailIframe component via postMessage
  // The iframe intercepts clicks and sends them to handleIframeLinkClick

  // Make all links in outbox messages open in new tabs - guard
  let lastOutboxLinkSetup = '';
  $effect(() => {
    const itemId = selectedOutboxItem?.id || '';
    if (outboxMessageBodyContainer && selectedOutboxItem && itemId !== lastOutboxLinkSetup) {
      lastOutboxLinkSetup = itemId;
      setupLinkHandlers(outboxMessageBodyContainer);
    }
  });

  onMount(() => {
    // Initialize toasts for error handling in mailboxStore
    if (mailboxStore?.actions?.setToasts && mailboxView?.toasts) {
      mailboxStore.actions.setToasts(mailboxView.toasts);
    }

    if (mailboxStore?.actions?.loadFolders) {
      mailboxStore.actions
        .loadFolders()
        .then(() => mailboxStore.actions?.loadMessages?.())
        .catch(() => {
          mailboxView?.load?.();
        });
    } else {
      mailboxView?.load?.();
    }
    // Initialize search store for saved search suggestions
    searchStore?.actions?.ensureInitialized?.().then(() => {
      searchStore?.actions?.refreshSavedSearches?.();
    });
    const closeHandler = (e) => {
      if (e?.target?.closest?.('[data-context-menu]')) return;
      contextMenuVisible = false;
      contextMoveOpen = false;
      contextLabelOpen = false;
      contextMenuConversation = null;
    };
    window.addEventListener('click', closeHandler, true);

    // Set up infinite scroll observer for mobile
    if (typeof window !== 'undefined' && 'IntersectionObserver' in window) {
      infiniteScrollObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting && isMobileViewport() && $hasNextPage && !$loading) {
              nextPage();
            }
          });
        },
        {
          root: messageListWrapper,
          rootMargin: '100px', // Trigger 100px before reaching the bottom
          threshold: 0.1,
        }
      );

      // Observe the sentinel element when it's available
      if (infiniteScrollSentinel) {
        infiniteScrollObserver.observe(infiniteScrollSentinel);
      }
    }

    // Set up store subscriptions to replace $effect blocks that were causing loops
    // These run once on mount and clean up on destroy

    // Layout mode changes
    let lastLayoutModeVal = get(layoutModeStore) || 'full';
    mailboxSubscriptions.push(
      layoutModeStore.subscribe((val) => {
        const mode = val || 'full';
        if (mode !== lastLayoutModeVal) {
          lastLayoutModeVal = mode;
        }
      })
    );

    // Profile loading on account change
    let lastProfileAcct = get(currentAccount) || '';
    mailboxSubscriptions.push(
      currentAccount.subscribe((acct) => {
        if (acct && acct !== lastProfileAcct) {
          lastProfileAcct = acct;
          threadMessageBodies.set(new Map());
          loadProfileName(acct);
          loadProfileImage(acct);
        }
      })
    );

    // Clear selection when folder changes and update URL
    let lastFolderVal = get(selectedFolder) || '';
    mailboxSubscriptions.push(
      selectedFolder.subscribe((folder) => {
        if (folder !== lastFolderVal) {
          lastFolderVal = folder;
          mailboxStore?.actions?.setSelectedIds?.([]);
          selectionMode = false;
          // Update URL to reflect folder change (only if not triggered by popstate)
          // Always show just the folder - message selection happens separately
          if (folder && !skipFolderUrlUpdate) {
            const hash = buildHashUrl(folder, null);
            history.pushState({ folder }, '', hash);
          }
        }
      })
    );

    // Update URL when filter state changes (debounced to avoid rapid updates)
    let filterUrlUpdateTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedUrlUpdate = () => {
      if (filterUrlUpdateTimer) clearTimeout(filterUrlUpdateTimer);
      filterUrlUpdateTimer = setTimeout(() => {
        updateUrlWithFilters();
      }, 100);
    };

    mailboxSubscriptions.push(
      query.subscribe(() => debouncedUrlUpdate())
    );
    mailboxSubscriptions.push(
      sortOrder.subscribe(() => debouncedUrlUpdate())
    );
    mailboxSubscriptions.push(
      unreadOnly.subscribe(() => debouncedUrlUpdate())
    );
    mailboxSubscriptions.push(
      hasAttachmentsOnly.subscribe(() => debouncedUrlUpdate())
    );
    if (source.state?.starredOnly?.subscribe) {
      mailboxSubscriptions.push(
        source.state.starredOnly.subscribe(() => debouncedUrlUpdate())
      );
    }

    // Also update URL when selected message changes (e.g., cleared due to filter)
    if (source.state?.selectedMessage?.subscribe) {
      mailboxSubscriptions.push(
        source.state.selectedMessage.subscribe(() => debouncedUrlUpdate())
      );
      // Load message body when selectedMessage is set externally (e.g., search auto-select)
      // selectMessage() sets lastSelectedMessageId before calling loadMessage(),
      // so if the id doesn't match, this was an external store update.
      mailboxSubscriptions.push(
        source.state.selectedMessage.subscribe((msg) => {
          if (msg && msg.id && msg.id !== lastSelectedMessageId) {
            lastSelectedMessageId = msg.id;
            loadMessage(msg);
          }
        })
      );
    }

    // Enable URL state management after initial setup is complete
    setTimeout(() => {
      urlStateInitialized = true;
      skipFilterUrlUpdate = false;
    }, 200);

    return () => {
      window.removeEventListener('click', closeHandler, true);
      if (infiniteScrollObserver) {
        infiniteScrollObserver.disconnect();
      }
      // Clean up store subscriptions
      mailboxSubscriptions.forEach((unsub) => unsub?.());
      mailboxSubscriptions = [];
    };
  });

  // Observe infinite scroll sentinel when it becomes available - guard
  let sentinelObserved = false;
  $effect(() => {
    if (infiniteScrollSentinel && infiniteScrollObserver && !sentinelObserved) {
      sentinelObserved = true;
      infiniteScrollObserver.observe(infiniteScrollSentinel);
    }
  });

  // No longer need to sync to KO observables - mailboxView now uses Svelte stores directly
  // Override KO selection helpers to use Svelte store data for bulk actions - guard
  let selectionHelpersAttached = false;
  $effect(() => {
    if (mailboxView && mailboxStore && !selectionHelpersAttached) {
      selectionHelpersAttached = true;
      mailboxView.getSelectedConversations = () => {
        const ids = get(selectedConversationIds) || [];
        const convs = get(filteredConversations) || [];
        const msgs = get(filteredMessages) || [];
        const byId = new Map(convs.map((c: { id: string }) => [c.id, c]));
        const selected: unknown[] = [];
        ids.forEach((id: string) => {
          const conv = byId.get(id);
          if (conv) {
            selected.push(conv);
          } else {
            const msg = msgs.find((m: { id: string }) => m.id === id);
            if (msg) selected.push({ id: msg.id, messages: [msg], subject: msg.subject, snippet: msg.snippet });
          }
        });
        return selected;
      };
      mailboxView.getSelectedMessagesFromConversations = () =>
        (mailboxView.getSelectedConversations() || []).flatMap((c: { messages?: unknown[] }) => c.messages || []);
    }
  });
  // Default move target when dropdown opens (moveTarget is now selectedFolder store) - guard
  let moveTargetSet = false;
  $effect(() => {
    if ($availableMoveTargets?.length && !$selectedFolder && !moveTargetSet) {
      moveTargetSet = true;
      selectedFolder.set($availableMoveTargets[0].path);
    } else if ($selectedFolder) {
      moveTargetSet = false;
    }
  });

  // Auto-select first item removed (was causing loops) - user must click to select

  // Scroll message list to top (for page changes and folder navigation)
  const scrollMessageListToTop = () => {
    if (messageListWrapper) {
      messageListWrapper.scrollTop = 0;
    }
  };

  const collapseSidebarForMobile = () => {
    if (!isMobileViewport()) return;
    source.state?.sidebarOpen?.set?.(false);
    mailboxView?.sidebarOpen?.set?.(false);
    if (mailboxView?.mobileReader?.set) mailboxView.mobileReader.set(false);
    else if (typeof mailboxView?.mobileReader === 'function') mailboxView.mobileReader(false);
    mobileReader.set?.(false);
    source.state?.selectedMessage?.set?.(null);
    mailboxView?.selectedMessage?.set?.(null);
    updateSelectedConversation(null);
    source.state?.selectedConversationIds?.set?.([]);
  };

  // Prefetch effects removed (was causing loops) - prefetch disabled for now

  // Prefetch next page for instant pagination
  const getMessagePageSize = () => {
    const effective = getEffectiveSettingValue('messages_per_page');
    const parsed = Number.parseInt(effective, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    const settings = getSyncSettings();
    return settings.pageSize || 20;
  };

  const prefetchNextPage = async () => {
    if (!$hasNextPage || prefetchingNextPage || !isBodyPrefetchEnabled()) return;

    prefetchingNextPage = true;
    nextPagePrefetched = false;

    try {
      const account = Local.get('email') || 'default';
      const folder = $selectedFolder;
      const nextPageNum = $page + 1;
      const limit = getMessagePageSize();

      // Fetch next page message list metadata in the worker
      const searchTerm = ($query || '').trim();
      const res = await sendSyncRequest('messagePage', {
        account,
        folder,
        page: nextPageNum,
        limit,
        sort: $sortOrder === 'oldest'
          ? 'date'
          : $sortOrder === 'newest'
            ? '-date'
            : $sortOrder === 'subject'
              ? 'subject'
              : $sortOrder === 'sender'
                ? 'from'
                : '-date',
        ...(searchTerm ? { search: searchTerm } : {}),
        ...($unreadOnly ? { is_unread: true } : {}),
        ...($hasAttachmentsOnly ? { has_attachments: true } : {}),
        // Note: label filtering is done client-side
      });

      const messages = res?.messages || [];

      if (!Array.isArray(messages) || messages.length === 0) {
        nextPagePrefetched = true;
        return;
      }

      // Show button now - don't wait for full prefetch
      nextPagePrefetched = true;

      // Body prefetch is handled by the sync worker's background task
      // to avoid duplicate network calls.

    } catch {
      nextPagePrefetched = true; // Show button anyway on error
    } finally {
      prefetchingNextPage = false;
    }
  };
</script>

<Tooltip.Provider>
{#if isActive}
  <div
    class="fe-mailbox-wrapper"
    class:mobile-reader={$mobileReader}
  >
  {#if isOffline}
    <div class="flex items-center justify-center gap-2 px-4 py-1.5 bg-yellow-500/15 border-b border-yellow-500/25 text-yellow-700 dark:text-yellow-400 text-sm" role="status">
      <WifiOff class="h-3.5 w-3.5 shrink-0" />
      <span>You're offline. Cached messages are still available.</span>
    </div>
  {/if}
  <div class="flex items-center gap-3 px-4 py-2 bg-muted/50">
    <Tooltip.Root>
      <Tooltip.Trigger>
        <button class={`inline-flex items-center justify-center h-11 w-11 hover:bg-accent transition-colors ${$sidebarOpen ? 'bg-accent' : ''}`} type="button" aria-label="Toggle sidebar" onclick={toggleSidebar}>
          <span class={`inline-flex transition-transform duration-200 ${$sidebarOpen ? 'rotate-90' : ''}`}>
            <Menu class="h-4 w-4" />
          </span>
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom"><p>Toggle sidebar</p></Tooltip.Content>
    </Tooltip.Root>
      <div class="flex items-center gap-3 flex-1">
        <div class="relative flex-1 md:max-w-[420px]">
          <Search class="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            class="pl-9 pr-8 h-9 bg-background"
            placeholder="Search mail"
            title="Search mail (Ctrl+K)"
            value={$query}
            bind:this={searchInputEl}
            onfocus={showSuggestions}
            onblur={hideSuggestions}
            oninput={(e) => {
              showSuggestions();
              onSearch((e.target as HTMLInputElement).value);
            }}
          />
          {#if $searchingStore}
            <span class="absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary"></span>
          {/if}
          {#if searchSuggestionsVisible && filteredSuggestions.length}
            <div class="absolute top-full left-0 right-0 mt-1 z-50 bg-popover border border-border shadow-lg p-2 grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2 max-h-[300px] overflow-y-auto">
              {#each filteredSuggestions as suggestion}
                <button
                  type="button"
                  class="flex items-center justify-between gap-2 px-2.5 py-2 border border-border bg-background text-sm cursor-pointer transition-colors hover:border-primary hover:bg-primary/5"
                  data-type={suggestion.type || 'operator'}
                  onmousedown={(e) => { e.preventDefault(); applySuggestion(suggestion.value); }}
                  title={suggestion.type === 'label' ? 'Label' : suggestion.type === 'saved' ? 'Saved search' : 'Operator'}
                >
                  <span class="truncate">{suggestion.label}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#if showHeaderShortcuts && ($syncProgress.active || $indexProgress.active)}
          <div
            class="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs text-muted-foreground rounded-full shrink-0"
            role="status"
            aria-live="polite"
          >
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary shrink-0"></span>
            {#if $syncProgress.active}
              <span class="truncate max-w-[140px]">Syncing{$syncProgress.folder ? ` ${$syncProgress.folder}` : ''}</span>
            {:else}
              <span class="truncate max-w-[140px]">Indexing{$indexProgress.total > 0 ? ` ${Math.round(($indexProgress.current / $indexProgress.total) * 100)}%` : ''}</span>
            {/if}
          </div>
        {/if}
        <div class="inline-flex items-center gap-2.5 ml-auto shrink-0">
          {#if showHeaderShortcuts}
            <div class="inline-flex items-center gap-1.5">
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                data-tooltip="Contacts"
                data-tooltip-position="bottom"
                aria-label="Contacts"
                onclick={() => navigate('/contacts')}
              >
                <BookUser class="h-4.5 w-4.5" />
              </button>
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                data-tooltip="Calendar"
                data-tooltip-position="bottom"
                aria-label="Calendar"
                onclick={() => navigate('/calendar')}
              >
                <CalendarIcon class="h-4.5 w-4.5" />
              </button>
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                data-tooltip="Settings"
                data-tooltip-position="bottom"
                aria-label="Settings"
                onclick={() => navigate('/mailbox/settings')}
              >
                <SettingsIcon class="h-4.5 w-4.5" />
              </button>
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                data-tooltip={isDarkMode ? 'Light mode' : 'Dark mode'}
                data-tooltip-position="bottom"
                aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                onclick={toggleTheme}
              >
                {#if isDarkMode}
                  <Sun class="h-4.5 w-4.5" />
                {:else}
                  <Moon class="h-4.5 w-4.5" />
                {/if}
              </button>
            </div>
          {/if}
          <div class="inline-flex items-center gap-2.5">
            <button
              class="inline-flex items-center justify-center p-1.5 hover:bg-accent transition-colors"
              type="button"
              data-tooltip="Profile"
              data-tooltip-position="bottom"
              aria-label="Profile"
              onclick={() => navigate('/mailbox/profile')}
            >
              <span class="w-9 h-9 rounded-full flex items-center justify-center bg-muted border border-border text-sm font-semibold overflow-hidden">
                {#if $profileImageStore}
                  <img src={$profileImageStore} alt="Profile" />
                {:else if profileInitials}
                  <span class="tracking-wide">{profileInitials}</span>
                {:else}
                  <User class="h-4.5 w-4.5" />
                {/if}
              </span>
            </button>
          </div>
        </div>
    </div>
  </div>

  {#if $sidebarOpen}
    <div
      class="fixed inset-0 z-40 bg-black/50 md:hidden"
      role="presentation"
      tabindex="-1"
      onclick={toggleSidebar}
      onkeydown={(e) => activateOnKeys(e, toggleSidebar)}
    ></div>
  {/if}

  <div
    class="fe-mailbox-shell"
    class:fe-shell-collapsed={!$sidebarOpen}
    class:mobile-reader={$mobileReader}
    class:fe-layout-productivity={isProductivityLayout}
    class:fe-vertical-resizable={isVerticalDesktop}
    style={verticalSplitStyle || undefined}
  >
    <aside class="fe-folders" class:fe-folders-open={$sidebarOpen}>
      <div>
        <Button class="w-full gap-2" onclick={() => mailboxView?.composeModal?.open?.()}>
          <Pencil class="h-4 w-4" />
          <span>Compose</span>
        </Button>
      </div>

      <div class="relative mb-2 mt-2">
        <Button variant="outline" class="w-full justify-between px-3 py-2.5 font-medium h-11 bg-muted/50" onclick={() => mailboxView?.toggleAccountMenu?.()}>
          <span class="overflow-hidden text-ellipsis whitespace-nowrap max-w-[calc(100%-24px)]">{$currentAccount}</span>
          <ChevronDown class="ml-2 h-4 w-4 opacity-50" />
        </Button>
        {#if $accountMenuOpen}
          <div
            class="fixed inset-0 z-40"
            onclick={() => mailboxView?.toggleAccountMenu?.()}
            onkeydown={(e) => { if (e.key === 'Escape') mailboxView?.toggleAccountMenu?.(); }}
            role="presentation"
            tabindex="-1"
          ></div>
          <div class="absolute z-50 mt-1 min-w-[160px] border border-border bg-popover p-1 shadow-md" style="min-width: 100%; width: 100%; left: 0; right: auto">
            {#if $accounts.length > 1}
              <div
                style="
                  padding: 8px 12px;
                  font-size: 11px;
                  font-weight: 600;
                  text-transform: uppercase;
                  color: var(--color-text-secondary);
                  opacity: 0.7;
                "
              >
                Accounts
              </div>
              {#each $accounts as acct}
                <button
                  type="button"
                  class={`flex items-center w-full px-3 py-2 text-sm transition-colors ${acct.email === $currentAccount ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                  onclick={() => mailboxView?.switchAccount?.(acct)}
                >
                  <span class="truncate">{acct.email}</span>
                  {#if acct.email === $currentAccount}
                    <Check class="ml-auto h-4 w-4 shrink-0" />
                  {/if}
                </button>
              {/each}
              <div class="my-1 h-px bg-border"></div>
            {/if}
            <button type="button" class="flex items-center w-full px-3 py-2 text-sm transition-colors hover:bg-accent" onclick={() => mailboxView?.addAccount?.()}>
              <Plus class="h-4.5 w-4.5 mr-2 shrink-0" />
              <span>Add account</span>
            </button>
            <div class="my-1 h-px bg-border"></div>
            <button type="button" class="flex items-center w-full px-3 py-2 text-sm transition-colors text-destructive hover:bg-destructive/10" onclick={() => mailboxView?.signOut?.()}>
              <LogOut class="h-4.5 w-4.5 mr-2" />
              <span>Sign out {$currentAccount}</span>
            </button>
          </div>
        {/if}
      </div>

      <div class="flex-1 overflow-y-auto">
      <ul class="space-y-0.5 p-2">
        {#each visibleFolders as folder}
          <li
            class={`relative transition-colors ${!outboxSelected && $selectedFolder === folder.path ? 'bg-accent ring-1 ring-border' : ''}`}
            class:has-children={hasChildren(folder)}
            class:fe-drag-over={dragOverFolder === folder.path}
            oncontextmenu={(e) => handleFolderContextMenu(e, folder)}
            ondragenter={(e) => handleFolderDragEnter(e, folder)}
            ondragover={(e) => handleFolderDragOver(e, folder)}
            ondragleave={(e) => handleFolderDragLeave(e, folder)}
            ondrop={(e) => handleFolderDrop(e, folder)}
          >
            <button
              type="button"
              class={`flex items-center justify-between w-full px-3 py-2 text-sm transition-colors ${!outboxSelected && $selectedFolder === folder.path ? 'text-primary font-medium' : 'hover:bg-accent'}`}
              onclick={() => handleSelectFolder(folder.path)}
              onkeydown={(e) => activateOnKeys(e, () => handleSelectFolder(folder.path))}
            >
              <span class="flex items-center gap-2 min-w-0 flex-1" style={`padding-left: ${(folder.level || 0) * 12}px`}>
                <!-- Chevron for expand/collapse -->
                {#if hasChildren(folder)}
                  <button
                    type="button"
                    class="p-0.5 hover:bg-accent transition-colors shrink-0"
                    onclick={(e) => { e.stopPropagation(); toggleFolderExpansion(folder.path); }}
                    aria-label={$expandedFolders.has(folder.path) ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight class={`h-4 w-4 transition-transform ${$expandedFolders.has(folder.path) ? 'rotate-90' : ''}`} />
                  </button>
                {:else if (folder.level || 0) > 0}
                  <span class="w-4 shrink-0" aria-hidden="true"></span>
                {/if}

                <svelte:component this={getFolderIcon(folder)} class="h-5 w-5 text-primary shrink-0" />
                <span class="truncate text-sm">{folder.name || folder.path}</span>
              </span>

              {#if folder.count}
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary">{folder.count}</span>
              {/if}
            </button>
          </li>
        {/each}

        <!-- Outbox virtual folder -->
        <li class={`relative transition-colors ${outboxSelected ? 'bg-accent ring-1 ring-border' : ''}`}>
          <button
            type="button"
            class={`flex items-center justify-between w-full px-3 py-2 text-sm transition-colors ${outboxSelected ? 'text-primary font-medium' : 'hover:bg-accent'}`}
            onclick={selectOutbox}
            onkeydown={(e) => activateOnKeys(e, selectOutbox)}
          >
            <span class="flex items-center gap-2 min-w-0 flex-1">
              <Send class="h-5 w-5 text-primary shrink-0" />
              <span class="truncate text-sm">Outbox</span>
              {#if $outboxProcessing}
                <span class="ml-1 h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary"></span>
              {/if}
            </span>
            {#if $outboxCount > 0}
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-500/10 text-amber-600">{$outboxCount}</span>
            {/if}
          </button>
        </li>
      </ul>
      </div>

      <!-- Add folder button at bottom -->
      <div class="mt-auto p-3 border-t border-border">
        <button
          type="button"
          class="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          onclick={handleCreateRootFolder}
          title="Create new folder"
        >
          <Plus class="h-4 w-4" />
          <span>New Folder</span>
        </button>
        <div class="flex flex-col gap-1 mt-2">
          <button type="button" class="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onclick={() => navigate('/contacts')}>
            <BookUser class="h-4 w-4" />
            <span>Contacts</span>
          </button>
          <button type="button" class="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onclick={() => navigate('/calendar')}>
            <CalendarIcon class="h-4 w-4" />
            <span>Calendar</span>
          </button>
          <button type="button" class="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors" onclick={() => navigate('/mailbox/settings')}>
            <SettingsIcon class="h-4 w-4" />
            <span>Settings</span>
          </button>
        </div>
      </div>

      {#if $storageTotal > 0}
        <a
          href="https://forwardemail.net/my-account/billing"
          target="_blank"
          rel="noopener noreferrer"
          class="block px-3 pb-3 hover:bg-accent/50 transition-colors mx-2 mb-2"
          title="Manage billing and storage"
        >
          <div class="flex items-center justify-between text-xs text-muted-foreground mb-1">
            <small>Storage</small>
            <small>{storagePercent()}%</small>
          </div>
          <div class="h-1.5 w-full bg-secondary rounded-full overflow-hidden">
            <div class="h-full bg-primary transition-all rounded-full" style={`width:${storagePercent()}%`}></div>
          </div>
          <small class="text-xs text-muted-foreground mt-1">
            {formatStorage($storageUsed)} of {formatStorage($storageTotal)}
          </small>
        </a>
      {/if}

    </aside>

    <section
      class="fe-messages"
      class:mobile-reader-active={$mobileReader}
      bind:this={messagesPaneEl}
    >
      {#if $filteredConversations.length || $filteredMessages.length || $unreadOnly || $hasAttachmentsOnly || $starredOnly || ($filterByLabel && $filterByLabel.length)}
      <div class="flex items-center gap-3 px-4 py-2 border-b border-border bg-muted/30 relative z-40 overflow-visible">
        <div class="flex items-center gap-1 overflow-visible">
          {#if !outboxSelected && ($filteredConversations.length || $filteredMessages.length)}
            {@const allSelected = ($threadingEnabled ? $filteredConversations : $filteredMessages).length > 0 &&
                ($threadingEnabled ? $filteredConversations : $filteredMessages).every((item) =>
                  ($selectedConversationIds || []).includes(item.id),
                )}
            <button
              class={`inline-flex items-center justify-center h-11 w-11 transition-colors ${allSelected ? 'bg-accent text-primary' : selectionMode ? 'bg-accent/50 text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'}`}
              type="button"
              data-tooltip={selectionMode ? (allSelected ? 'Deselect all' : 'Select all') : 'Select'}
              data-tooltip-position="bottom"
              aria-label={selectionMode ? 'Select all visible messages' : 'Enter selection mode'}
              onclick={() =>
                selectAllVisible($threadingEnabled ? $filteredConversations : $filteredMessages)
              }
            >
              <CheckSquare class="h-5 w-5" />
            </button>
          {/if}
          <button
            class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
            type="button"
            data-tooltip="Refresh (F5)"
            data-tooltip-position="bottom"
            aria-label="Refresh"
            onclick={handleRefreshClick}
          >
            <RefreshCw class={`h-5 w-5 ${refreshAnimating ? 'animate-spin' : ''}`} />
          </button>
          <div class="relative" data-sort-toggle>
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Sort"
              aria-expanded={sortMenuOpen}
              data-tooltip={`Sort: ${getSortLabel($sortOrder)}`}
              data-tooltip-position="bottom"
              onclick={() => (sortMenuOpen = !sortMenuOpen)}
            >
              <ListFilter class="h-5 w-5" />
            </button>
            {#if sortMenuOpen}
              <div class="absolute z-50 mt-1.5 min-w-[160px] border border-border bg-popover p-1 shadow-md right-0" data-sort-dropdown>
                <div class="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">Sort by</div>
                {#each sortOptions as option}
                  <button
                    type="button"
                    class={`flex items-center w-full px-3 py-2 text-sm transition-colors ${$sortOrder === option.value ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                    aria-pressed={$sortOrder === option.value}
                    onclick={() => {
                      setSortOrder(option.value);
                      sortMenuOpen = false;
                    }}
                  >
                    <span>{option.label}</span>
                    {#if $sortOrder === option.value}
                      <Check class="ml-auto h-4 w-4 shrink-0" />
                    {/if}
                  </button>
                {/each}
                <div class="my-1 h-px bg-border"></div>
                <button
                  type="button"
                  class="flex items-center w-full px-3 py-2 text-sm transition-colors hover:bg-accent text-muted-foreground"
                  onclick={() => {
                    setSortOrder('date_desc');
                    sortMenuOpen = false;
                  }}
                >
                  Reset to default
                </button>
              </div>
            {/if}
          </div>
          <div class="relative" data-labels-toggle>
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Labels"
              aria-expanded={labelMenuOpen}
              data-tooltip="Labels"
              data-tooltip-position="bottom"
              onclick={() => (labelMenuOpen = !labelMenuOpen)}
            >
              <Tag class="h-5 w-5" />
            </button>
            {#if labelMenuOpen}
              <div class="absolute z-50 mt-1.5 min-w-[160px] border border-border bg-popover p-1 shadow-md right-0" data-labels-dropdown>
                <div class="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">Apply label</div>
                {#if !availableLabelsFromStore.length}
                  <div class="px-3 py-2 text-sm text-muted-foreground">No labels yet.</div>
                {/if}
                {#each availableLabelsFromStore as label}
                  {#if label}
                    <button
                      type="button"
                      class={`flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors ${labelState(label) === 'all' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                      aria-pressed={labelState(label) === 'all'}
                      data-state={labelState(label)}
                      onclick={() => applyLabelToTargets(label)}
                    >
                      <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${label.color || '#9ca3af'}`}></span>
                      <span class="flex-1 text-left">{label.name || label.label || label.value}</span>
                      {#if labelState(label) === 'partial'}
                        <span class="text-muted-foreground">•</span>
                      {:else if labelState(label) === 'all'}
                        <Check class="h-4 w-4 shrink-0" />
                      {/if}
                    </button>
                  {/if}
                {/each}
                <div class="my-1 h-px bg-border"></div>
                <button type="button" class="flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors hover:bg-accent text-muted-foreground" onclick={openLabelModal}>
                  <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${labelFormColor || labelPalette[0]}`}></span>
                  <span>Create new label</span>
                </button>
              </div>
            {/if}
          </div>
          <div class="relative" data-filters-toggle>
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Filters"
              aria-expanded={$showFiltersStore}
              data-tooltip={filterLabel}
              data-tooltip-position="bottom"
              onclick={toggleFilters}
            >
              <Filter class="h-5 w-5" />
            </button>
            {#if $showFiltersStore}
              <div class="absolute z-50 mt-1.5 min-w-[160px] border border-border bg-popover p-1 shadow-md right-0" data-filters-dropdown>
                <button
                  type="button"
                  class={`flex items-center w-full px-3 py-2 text-sm transition-colors ${$unreadOnly ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                  aria-pressed={$unreadOnly}
                  onclick={() => setUnreadOnly(!$unreadOnly)}
                >
                  <span>Unread only</span>
                  {#if $unreadOnly}<Check class="ml-auto h-4 w-4 shrink-0" />{/if}
                </button>
                <button
                  type="button"
                  class={`flex items-center w-full px-3 py-2 text-sm transition-colors ${$hasAttachmentsOnly ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                  aria-pressed={$hasAttachmentsOnly}
                  onclick={() => setHasAttachmentsOnly(!$hasAttachmentsOnly)}
                >
                  <span>With attachments</span>
                  {#if $hasAttachmentsOnly}<Check class="ml-auto h-4 w-4 shrink-0" />{/if}
                </button>
                {#if availableLabelsFromStore && availableLabelsFromStore.length > 0}
                  <div class="my-1 h-px bg-border"></div>
                  <div class="px-2 py-1 text-xs font-medium text-muted-foreground uppercase tracking-wider">Filter by label</div>
                  {#each availableLabelsFromStore as label}
                    {#if label}
                      <button
                        type="button"
                        class={`flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors ${($filterByLabel || []).includes(getLabelId(label)) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                        aria-pressed={($filterByLabel || []).includes(getLabelId(label))}
                        onclick={() => toggleFilterByLabel(getLabelId(label))}
                      >
                        <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${label.color || '#9ca3af'}`}></span>
                        <span class="flex-1 text-left">{label.name || label.label || label.value}</span>
                        {#if ($filterByLabel || []).includes(getLabelId(label))}<Check class="h-4 w-4 shrink-0" />{/if}
                      </button>
                    {/if}
                  {/each}
                {/if}
                <div class="my-1 h-px bg-border"></div>
                <button
                  type="button"
                  class="flex items-center w-full px-3 py-2 text-sm transition-colors hover:bg-accent text-muted-foreground"
                  onclick={() => {
                    setUnreadOnly(false);
                    setHasAttachmentsOnly(false);
                    starredOnly.set(false);
                    filterByLabel.set([]);
                    closeFilters();
                  }}
                >
                  Clear filters
                </button>
              </div>
            {/if}
          </div>
        </div>
        <span class="text-sm font-medium text-muted-foreground">{outboxSelected ? 'Outbox' : $selectedFolder}</span>
      </div>
      {/if}

      {#if $selectedConversationIds && $selectedConversationIds.length}
        <div class="flex items-center gap-3 px-4 py-2 bg-muted/50 sticky top-0 z-30">
          <div class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-primary text-primary-foreground">
            <span>{$selectedConversationIds.length}</span>
          </div>
          <div class="flex items-center gap-1">
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Clear selection"
              data-tooltip="Clear selection"
              data-tooltip-position="bottom"
              onclick={clearSelection}
            >
              <X class="h-5 w-5" />
            </button>
            {#if $selectedFolder?.toUpperCase?.() !== 'ARCHIVE'}
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                aria-label="Archive selected"
                data-tooltip="Archive selected"
                data-tooltip-position="bottom"
                onclick={bulkArchive}
              >
                <Archive class="h-5 w-5" />
              </button>
            {/if}
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Delete selected"
              data-tooltip="Delete selected"
              data-tooltip-position="bottom"
              onclick={bulkDelete}
            >
              <Trash2 class="h-5 w-5" />
            </button>
            <div class="relative" data-bulk-move>
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                aria-label="Move selected"
                data-tooltip="Move selected"
                data-tooltip-position="bottom"
                onclick={() => {
                  if (bulkMoveOpen?.update) {
                    bulkMoveOpen.update((v) => !v);
                  } else if (mailboxView?.toggleBulkMove) {
                    mailboxView.toggleBulkMove();
                  }
                }}
              >
                <FolderInput class="h-5 w-5" />
              </button>
              {#if $bulkMoveOpen}
                <div class="absolute right-0 z-50 mt-1 min-w-[160px] max-h-[300px] overflow-y-auto border border-border bg-popover p-1 shadow-md">
                  {#each (availableMoveTargetsFromStore.length ? availableMoveTargetsFromStore : $availableMoveTargets) as folder}
                    <button
                      type="button"
                      class="flex items-center w-full px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                      onclick={() => bulkMoveTo(folder.path)}
                    >
                      {folder.path || folder.name}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      <div class="fe-message-list-wrapper relative flex-1 min-h-0 overflow-y-auto" bind:this={messageListWrapper}>
        {#if outboxSelected}
          <!-- Outbox View -->
          <div class="flex flex-col">
            {#if outboxItems.length === 0}
              <div class="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <p>No messages in outbox</p>
                <small>Messages queued for sending will appear here</small>
              </div>
            {:else}
              <ul class="divide-y divide-border">
                {#each outboxItems as item (item.id)}
                  <li
                    class={`relative ${item.status === 'failed' ? 'bg-destructive/10' : ''} ${item.status === 'sending' ? 'opacity-70' : ''}`}
                   >
                    <div
                      class="flex items-start gap-3 p-3 transition-colors"
                    >
                      <div class="text-xs">
                        {#if item.status === 'pending'}
                          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" title="Pending">Queued</span>
                        {:else if item.status === 'scheduled'}
                          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" title="Scheduled">
                            {formatScheduledTime(item.sendAt)}
                          </span>
                        {:else if item.status === 'sending'}
                          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-primary/10 text-primary animate-pulse" title="Sending">Sending...</span>
                        {:else if item.status === 'sent'}
                          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" title="Sent">Sent</span>
                        {:else if item.status === 'failed'}
                          <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-destructive/10 text-destructive" title="Failed">Failed</span>
                        {/if}
                      </div>
                      <div class="flex-1 min-w-0 flex flex-col gap-1">
                        <div class="flex items-center gap-1.5">
                          <span class="font-medium truncate">{item.emailData?.subject || '(No subject)'}</span>
                        </div>
                        <div class="flex items-center gap-1.5 text-sm">
                          <span class="text-muted-foreground truncate">
                            To: {(item.emailData?.to || []).slice(0, 5).join(', ')}{#if (item.emailData?.to || []).length > 5}, +{(item.emailData?.to || []).length - 5} more{/if}
                          </span>
                        </div>
                        {#if item.lastError}
                          <div class="text-xs text-destructive">
                            <small>{item.lastError}</small>
                          </div>
                        {/if}
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <span class="text-xs text-muted-foreground whitespace-nowrap">{formatCompactDate(item.createdAt)}</span>
                        {#if item.retryCount > 0}
                          <small class="text-muted-foreground">Retries: {item.retryCount}</small>
                        {/if}
                      </div>
                      <div class="flex items-center gap-2 mt-2">
                        {#if item.status !== 'sending'}
                          <button
                            class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                            type="button"
                            title={item.status === 'scheduled' ? 'Cancel' : 'Delete'}
                            onclick={(e) => { e.stopPropagation(); handleDeleteOutbox(item); }}
                          >
                            <Trash2 class="h-4.5 w-4.5" />
                          </button>
                        {/if}
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {:else}
          <div
            class="divide-y divide-border"
            aria-busy={$loading}
            ontouchstart={handlePullStart}
            ontouchmove={handlePullMove}
            ontouchend={handlePullEnd}
            style="transform: translateY({pullDistance}px); transition: {isPulling ? 'none' : 'transform 0.3s ease-out'};"
          >
            {#if pullDistance > 0 || isRefreshing}
              <div
                class={`flex items-center justify-center gap-2 py-3 text-muted-foreground ${pullDistance > 60 ? 'text-primary' : ''} ${isRefreshing ? 'text-primary' : ''}`}
                style="opacity: {isRefreshing ? 1 : Math.min(pullDistance / 60, 1)}; margin-top: {isRefreshing ? 0 : (-60 + pullDistance)}px"
              >
                <div class={`h-5 w-5 rounded-full border-2 border-border border-t-primary ${isRefreshing ? 'animate-spin' : ''}`}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10" opacity="0.25"/>
                    <path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/>
                  </svg>
                </div>
                <span>{isRefreshing ? 'Refreshing...' : pullDistance > 60 ? 'Release to refresh' : 'Pull to refresh'}</span>
              </div>
            {/if}
            {#if $threadingEnabled}
              {@const convList = $filteredConversations}
              <ul class="divide-y divide-border">
                {#each convList as conv (conv.id)}
                <li
                  class={`relative cursor-pointer hover:bg-accent/50 transition-colors ${$selectedConversation?.id === conv.id ? 'bg-accent' : ''}`}
                  oncontextmenu={(e) => openContextMenu(e, conv)}
                  ondblclick={(e) => {
                    const message = conv?.messages?.[conv.messages.length - 1];
                    if (isDraftMessage(message || conv)) {
                      e.preventDefault();
                      e.stopPropagation();
                      openDraftFromMessage(message || conv);
                    }
                  }}
                >
                {#if swipeItemId === conv.id}
                  <div class="absolute inset-y-0 right-0 flex items-center">
                    {#if swipeDistance > 0}
                      <div class={`flex items-center justify-center gap-2 px-4 bg-green-500 text-white ${swipeDistance > 80 ? 'opacity-100' : 'opacity-60'}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>
                        </svg>
                        <span>Archive</span>
                      </div>
                    {:else if swipeDistance < 0}
                      <div class={`flex items-center justify-center gap-2 px-4 bg-destructive text-destructive-foreground ${Math.abs(swipeDistance) > 80 ? 'opacity-100' : 'opacity-60'}`}>
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                        </svg>
                        <span>Delete</span>
                      </div>
                    {/if}
                  </div>
                {/if}
                <div
                  class={`flex items-center gap-3 px-3 py-1.5 cursor-pointer ${swiping && swipeItemId === conv.id ? 'user-select-none' : ''} ${window.innerWidth > 640 ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  data-conversation-row
                  role="button"
                  tabindex="0"
                  draggable={window.innerWidth > 640}
                  onclick={() => {
                    const message = conv?.messages?.[conv.messages.length - 1] || conv;
                    if (isDraftMessage(message || conv)) {
                      openDraftFromMessage(message || conv);
                      return;
                    }
                    selectConversation(conv);
                  }}
                  onkeydown={(e) =>
                    activateOnKeys(e, () => {
                      const message = conv?.messages?.[conv.messages.length - 1] || conv;
                      if (isDraftMessage(message || conv)) {
                        openDraftFromMessage(message || conv);
                        return;
                      }
                      selectConversation(conv);
                    })}
                  ontouchstart={(e) => handleSwipeStart(e, conv)}
                  ontouchmove={(e) => handleSwipeMove(e, conv)}
                  ontouchend={() => handleSwipeEnd(conv)}
                  ondragstart={(e) => handleDragStart(e, conv)}
                  ondragend={handleDragEnd}
                  style="transform: translateX({swipeItemId === conv.id ? swipeDistance : 0}px); will-change: {swipeItemId === conv.id ? 'transform' : 'auto'}; transition: {swiping && swipeItemId === conv.id && !swipeAnimating ? 'none' : 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)'};"
                >
                  {#if selectionMode}
                    {@const convSelected = ($selectedConversationIds || []).includes(conv.id)}
                    <button
                      class={`relative w-8 h-8 rounded flex items-center justify-center shrink-0 transition-colors ${convSelected ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                      type="button"
                      aria-label={convSelected ? 'Deselect' : 'Select'}
                      onclick={(e) => { e.stopPropagation(); toggleSelection(conv, e); }}
                    >
                      {#if convSelected}
                        <CheckSquare class="h-5 w-5" />
                      {:else}
                        <Square class="h-5 w-5" />
                      {/if}
                    </button>
                  {:else}
                    <button
                      class={`relative w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${($selectedConversationIds || []).includes(conv.id) ? 'bg-primary text-primary-foreground' : ''}`}
                      type="button"
                      aria-label={($selectedConversationIds || []).includes(conv.id) ? 'Deselect' : 'Select'}
                      onclick={(e) => { e.stopPropagation(); toggleSelection(conv, e); }}
                      style={`--avatar-color: ${getAvatarColor(listIsSentFolder ? (getConversationToDisplay(conv) || getConversationFromDisplay(conv)) : getConversationFromDisplay(conv))}; ${!($selectedConversationIds || []).includes(conv.id) ? `background-color: var(--avatar-color)` : ''}`}
                    >
                      {#if ($selectedConversationIds || []).includes(conv.id)}
                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                        </svg>
                      {:else}
                        <span class="text-[10px] font-semibold text-white">{getInitials(listIsSentFolder ? (getConversationToDisplay(conv) || getConversationFromDisplay(conv)) : getConversationFromDisplay(conv))}</span>
                      {/if}
                    </button>
                  {/if}
                  <!-- Gmail-style: two rows -->
                  <div class="flex-1 min-w-0 flex flex-col gap-0.5 text-[13px]">
                    <!-- Row 1: From | Subject | Date -->
                    <div class="flex items-center gap-3">
                      <div class="w-[30%] min-w-[140px] max-w-[280px] shrink-0 flex items-center gap-1">
                        {#if conv.hasUnread || conv.is_unread}
                          <span class="w-1.5 h-1.5 rounded-full bg-primary shrink-0"></span>
                        {/if}
                        <span class={`truncate ${conv.hasUnread || conv.is_unread ? 'font-semibold' : ''}`}>{listIsSentFolder ? `To: ${getConversationToName(conv) || getConversationFromName(conv)}` : getConversationFromName(conv)}</span>
                        {#if conv.messageCount > 1}
                          <span class="text-[11px] text-muted-foreground shrink-0">({conv.messageCount})</span>
                        {/if}
                      </div>
                      <div class="flex-1 min-w-0">
                        <span class={`truncate block ${conv.hasUnread || conv.is_unread ? 'font-medium' : ''}`}>{conv.displaySubject || conv.subject}</span>
                      </div>
                      <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                        {#if hasConversationReplies(conv)}
                          <svg viewBox="0 0 24 24" class="h-3 w-3" aria-hidden="true">
                            <path d="M9 17l-5-5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                            <path d="M20 18v-2a4 4 0 0 0-4-4H4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                          </svg>
                        {/if}
                        {#if hasAttachments(conv)}
                          <svg viewBox="0 0 24 24" class="h-3 w-3" aria-hidden="true">
                            <path d="M21.44 11.05l-8.49 8.49a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 1 1 4.24 4.24l-9.19 9.19a1 1 0 1 1-1.41-1.41l8.49-8.49" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                          </svg>
                        {/if}
                        <span class="text-[11px] whitespace-nowrap">
                          {#if conv.latestDate}
                            {formatCompactDate(conv.latestDate)}
                          {:else}
                            {formatCompactDate(conv.date)}
                          {/if}
                        </span>
                      </div>
                    </div>
                    <!-- Row 2: Preview + Labels -->
                    <div class="flex items-center gap-2 text-xs text-muted-foreground">
                      <span class="truncate flex-1 min-w-0">
                        {truncatePreview(mailboxView?.getConversationPreview?.(conv) || conv.snippet || '')}
                      </span>
                      {#if Array.isArray(conv.labels) && conv.labels.length > 0}
                        <div class="flex items-center gap-1 shrink-0">
                          {#each conv.labels.slice(0, 3) as lbl}
                            {#if typeof lbl === 'string' && lbl && lbl !== '[]'}
                              {#if labelMap.get(lbl)}
                                <span class="inline-flex items-center px-1.5 py-0.5 text-[10px] truncate max-w-[80px]" style={labelMap.get(lbl).color ? `background:${labelMap.get(lbl).color}; color:#fff;` : ''}>
                                  {labelMap.get(lbl).name || labelMap.get(lbl).label || labelMap.get(lbl).value || lbl}
                                </span>
                              {/if}
                            {/if}
                          {/each}
                          {#if conv.labels.length > 3}
                            <span class="text-[10px] text-muted-foreground">+{conv.labels.length - 3}</span>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  </div>
                </div>
                </li>
              {/each}
            </ul>
          {:else}
            {@const msgList = $filteredMessages}
            {#each msgList as msg}
              <article
                class={`relative cursor-pointer hover:bg-accent/50 transition-colors ${($selectedConversationIds || []).includes(msg.id) ? 'bg-accent' : ''}`}
                oncontextmenu={(e) => openContextMenu(e, msg)}
                ondblclick={(e) => {
                  if (isDraftMessage(msg)) {
                    e.preventDefault();
                    e.stopPropagation();
                    openDraftFromMessage(msg);
                  }
                }}
              >
                <div
                  class={`flex items-center gap-3 px-3 py-1.5 cursor-pointer ${window.innerWidth > 640 ? 'cursor-grab active:cursor-grabbing' : ''}`}
                  data-conversation-row
                  role="button"
                  tabindex="0"
                  draggable={window.innerWidth > 640}
                  onclick={() => {
                    if (isDraftMessage(msg)) {
                      openDraftFromMessage(msg);
                      return;
                    }
                    selectMessage(msg);
                  }}
                  onkeydown={(e) =>
                    activateOnKeys(e, () => {
                      if (isDraftMessage(msg)) {
                        openDraftFromMessage(msg);
                        return;
                      }
                      selectMessage(msg);
                    })}
                  ondragstart={(e) => handleDragStart(e, msg)}
                  ondragend={handleDragEnd}
                >
                  {#if selectionMode}
                    {@const msgSelected = ($selectedConversationIds || []).includes(msg.id)}
                    <button
                      class={`relative w-10 h-10 rounded flex items-center justify-center shrink-0 transition-colors ${msgSelected ? 'text-primary' : 'text-muted-foreground hover:text-foreground'}`}
                      type="button"
                      aria-label={msgSelected ? 'Deselect' : 'Select'}
                      onclick={(e) => { e.stopPropagation(); toggleSelection({ id: msg.id }, e); }}
                    >
                      {#if msgSelected}
                        <CheckSquare class="h-5 w-5" />
                      {:else}
                        <Square class="h-5 w-5" />
                      {/if}
                    </button>
                  {:else}
                    <button
                      class={`relative w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${($selectedConversationIds || []).includes(msg.id) ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
                      type="button"
                      aria-label={($selectedConversationIds || []).includes(msg.id) ? 'Deselect' : 'Select'}
                      onclick={(e) => { e.stopPropagation(); toggleSelection({ id: msg.id }, e); }}
                      style={`--avatar-color: ${getAvatarColor(listIsSentFolder ? (getToDisplay(msg) || getFromDisplay(msg)) : getFromDisplay(msg))}; ${!($selectedConversationIds || []).includes(msg.id) ? `background-color: var(--avatar-color)` : ''}`}
                    >
                      <svg class="h-4 w-4 text-primary" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                      </svg>
                      <span class="text-xs font-medium">{getInitials(listIsSentFolder ? (getToDisplay(msg) || getFromDisplay(msg)) : getFromDisplay(msg))}</span>
                    </button>
                  {/if}
                  <div class="flex-1 min-w-0 flex flex-col gap-1">
                    <div class="flex items-center justify-between gap-2">
                      <div class="font-medium truncate">
                        {#if msg.is_unread}
                          <span class="w-2 h-2 rounded-full bg-primary shrink-0" title="Unread"></span>
                        {/if}
                        <span class={isProductivityLayout ? 'whitespace-normal break-words' : ''}>{msg.subject}</span>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        {#if hasAttachments(msg)}
                          <span class="text-muted-foreground" title="Has attachments">
                            <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" aria-hidden="true">
                              <path d="M21.44 11.05l-8.49 8.49a5 5 0 0 1-7.07-7.07l9.19-9.19a3 3 0 1 1 4.24 4.24l-9.19 9.19a1 1 0 1 1-1.41-1.41l8.49-8.49" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                            </svg>
                          </span>
                        {/if}
                        <span class="text-xs text-muted-foreground whitespace-nowrap">
                          {formatCompactDate(msg.date)}
                        </span>
                      </div>
                    </div>
                    <div class="text-sm text-muted-foreground truncate">{listIsSentFolder ? `To: ${getMessageToName(msg) || getMessageFromName(msg)}` : getMessageFromName(msg)}</div>
                    {#if Array.isArray(msg.labels) && msg.labels.length}
                      <div class="flex flex-wrap gap-1.5 mt-1">
                        {#each msg.labels.slice(0, 4) as lbl}
                          {#if typeof lbl === 'string' && lbl && lbl !== '[]'}
                            {#if labelMap.get(lbl)}
                              {#if labelMap.get(lbl).color}
                                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-secondary text-secondary-foreground truncate max-w-[120px]" style={`background:${labelMap.get(lbl).color}; color:#fff;`}>
                                  {labelMap.get(lbl).name || labelMap.get(lbl).label || labelMap.get(lbl).value || lbl}
                                </span>
                              {:else}
                                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-secondary text-secondary-foreground truncate max-w-[120px]">
                                  {labelMap.get(lbl).name || labelMap.get(lbl).label || labelMap.get(lbl).value || lbl}
                                </span>
                              {/if}
                            {:else}
                              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-secondary text-secondary-foreground truncate max-w-[120px]">{lbl}</span>
                            {/if}
                          {/if}
                        {/each}
                      </div>
                    {/if}
                    <div class="text-sm text-muted-foreground truncate">{msg.snippet || ''}</div>
                  </div>
                </div>
              </article>
            {/each}
          {/if}
          {#if showListSkeleton}
            <div class="space-y-0">
              {#each Array(8) as _, i}
                <div class="flex items-start gap-3 p-3 border-b border-border animate-pulse">
                  <div class="w-4 h-4 bg-muted shrink-0"></div>
                  <div class="flex-1 space-y-2">
                    <div class="h-4 bg-muted" style="width: {60 + (i % 3) * 10}%"></div>
                    <div class="h-3 bg-muted" style="width: {40 + (i % 4) * 8}%"></div>
                    <div class="h-3 bg-muted" style="width: {70 + (i % 5) * 5}%"></div>
                  </div>
                  <div class="w-12 h-3 bg-muted rounded shrink-0"></div>
                </div>
              {/each}
            </div>
          {:else if showEmptyState}
            <div class="flex flex-col items-center justify-center py-16 text-center">
              {#if $searchActiveStore}
                <svg class="h-12 w-12 text-muted-foreground mb-4" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" stroke="currentColor" fill="none" stroke-width="2"/>
                  <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2"/>
                </svg>
                <h3>No results found</h3>
                <p>Try adjusting your search or filters</p>
                {#if $unreadOnly || $hasAttachmentsOnly || $starredOnly || ($filterByLabel && $filterByLabel.length)}
                  <button
                    type="button"
                    class="mt-4 px-4 py-2 text-sm font-medium rounded-md border border-border hover:bg-accent hover:text-accent-foreground transition-colors"
                    onclick={() => {
                      setUnreadOnly(false);
                      setHasAttachmentsOnly(false);
                      starredOnly.set(false);
                      filterByLabel.set([]);
                    }}
                  >
                    Clear filters
                  </button>
                {/if}
              {:else if $selectedFolder === 'INBOX'}
                <svg class="h-12 w-12 text-muted-foreground mb-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" stroke="currentColor" fill="none" stroke-width="2"/>
                  <line x1="9" y1="13" x2="15" y2="13" stroke="currentColor" stroke-width="2"/>
                </svg>
                <h3>Inbox Zero!</h3>
                <p>You're all caught up</p>
              {:else if isDraftFolder($selectedFolder)}
                <svg class="h-12 w-12 text-muted-foreground mb-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" stroke="currentColor" fill="none" stroke-width="2"/>
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" fill="none" stroke-width="2"/>
                </svg>
                <h3>No drafts</h3>
                <p>Your draft messages will appear here</p>
              {:else}
                <svg class="h-12 w-12 text-muted-foreground mb-4" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" stroke="currentColor" fill="none" stroke-width="2"/>
                </svg>
                <h3>No messages</h3>
                <p>This folder is empty</p>
              {/if}
            </div>
          {/if}
          {#if isMobile && $loading && (($threadingEnabled && $filteredConversations.length) || (!$threadingEnabled && $filteredMessages.length))}
            <div class="flex items-center justify-center py-6">
              <span class="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border border-t-primary" style="margin-right: 8px;"></span>
              Loading more...
            </div>
          {/if}
          <!-- Sentinel element for infinite scroll -->
          <div bind:this={infiniteScrollSentinel} class="h-px" style="height: 1px;"></div>
        </div>
        {/if}
      </div>

      {#if !outboxSelected && !isMobile}
      <div class="fe-pagination flex items-center justify-center gap-2 px-3 py-1.5 border-t border-border text-xs text-muted-foreground">
        <button class="px-2 py-1 hover:bg-accent hover:text-accent-foreground disabled:opacity-50" type="button" onclick={prevPage} disabled={$page <= 1}>Prev</button>
        <span>Page {$page}</span>
        {#if $hasNextPage}
          <button class="px-2 py-1 hover:bg-accent hover:text-accent-foreground" type="button" onclick={nextPage}>Next</button>
        {/if}
      </div>
      {/if}
    </section>

    {#if contextMenuVisible && contextMenuMessage}
      <!-- Backdrop to capture clicks outside context menu -->
      <div class="fixed inset-0 z-[99]" onpointerdown={closeContextMenu} role="presentation" tabindex="-1"></div>
      <div
        class={`fixed z-[100] min-w-[200px] border border-border bg-popover p-1 shadow-lg touch-manipulation ${contextMenuFlipX ? 'origin-top-right' : 'origin-top-left'} ${contextMenuFlipY ? 'origin-bottom' : 'origin-top'}`}
        style={`top:${contextMenuY}px; left:${contextMenuX}px; ${contextMenuFlipX ? 'transform: translateX(-100%);' : ''} ${contextMenuFlipY ? 'transform: translateY(-100%);' : ''}`}
        role="menu"
        tabindex="0"
        data-context-menu
        onpointerdown={(e) => e.stopPropagation()}
        onclick={(e) => e.stopPropagation()}
        onkeydown={(e) => {
          if (e.key === 'Escape') {
            closeContextMenu();
          }
        }}
      >
        <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={contextToggleRead}>
          <Eye class="h-4.5 w-4.5 mr-2" />
          <span>{contextMenuMessage.is_unread ? 'Mark Read' : 'Mark Unread'}</span>
        </button>
        <div class="my-1 h-px bg-border"></div>
        <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={contextReply}>
          <Reply class="h-4.5 w-4.5 mr-2" />
          <span>Reply</span>
        </button>
        <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={contextForward}>
          <Forward class="h-4.5 w-4.5 mr-2" />
          <span>Forward</span>
        </button>
        <div class="my-1 h-px bg-border"></div>
        {#if isDraftMessage(contextMenuMessage)}
          <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={contextEditDraft}>
            <FileEdit class="h-4.5 w-4.5 mr-2" />
            <span>Edit draft</span>
          </button>
          <div class="my-1 h-px bg-border"></div>
        {/if}
        <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={contextArchive}>
          <Archive class="h-4.5 w-4.5 mr-2" />
          <span>Archive</span>
        </button>
        <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={contextDelete}>
          <Trash2 class="h-4.5 w-4.5 mr-2" />
          <span>Delete</span>
        </button>
        <div class="relative">
          <button
            type="button"
            class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onclick={toggleContextMoveMenu}
            disabled={!contextSubmenusEnabled}
            aria-disabled={!contextSubmenusEnabled}
          >
            <FolderInput class="h-4.5 w-4.5 mr-2" />
            <span class="flex-1 text-left">Move to…</span>
            {#if contextSubmenusEnabled}
              <span aria-hidden="true" class="ml-auto">›</span>
            {/if}
          </button>
          {#if contextSubmenusEnabled && contextMoveOpen}
            <div
              class={`absolute z-[101] min-w-[160px] border border-border bg-popover p-1 shadow-lg overflow-y-auto ${contextSubmenuFlipX ? 'right-full mr-1' : 'left-full ml-1'} ${contextSubmenuFlipY ? 'bottom-0' : 'top-0'}`}
              style={`max-height: ${contextSubmenuMaxHeight}px; transform: translateY(${contextSubmenuShiftY}px);`}
              bind:this={contextMoveSubmenuEl}
            >
              {#each availableMoveTargetsFromStore as folder}
                <button type="button" class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer" onclick={() => contextMoveTo(folder.path)}>
                  <span>{folder.path || folder.name}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
        <div class="relative">
          <button
            type="button"
            class="flex items-center w-full px-2 py-1.5 text-sm hover:bg-accent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            onclick={toggleContextLabelMenu}
            disabled={!contextSubmenusEnabled}
            aria-disabled={!contextSubmenusEnabled}
          >
            <Tag class="h-4.5 w-4.5 mr-2" />
            <span class="flex-1 text-left">Label as…</span>
            {#if contextSubmenusEnabled}
              <span aria-hidden="true" class="ml-auto">›</span>
            {/if}
          </button>
          {#if contextSubmenusEnabled && contextLabelOpen}
            <div
              class={`absolute z-[101] min-w-[160px] border border-border bg-popover p-1 shadow-lg overflow-y-auto ${contextSubmenuFlipX ? 'right-full mr-1' : 'left-full ml-1'} ${contextSubmenuFlipY ? 'bottom-0' : 'top-0'}`}
              style={`max-height: ${contextSubmenuMaxHeight}px; transform: translateY(${contextSubmenuShiftY}px);`}
              data-labels-dropdown
              bind:this={contextLabelSubmenuEl}
            >
              {#if !availableLabelsFromStore.length}
                <div class="px-3 py-2 text-sm text-muted-foreground">No labels yet.</div>
              {/if}
              {#each availableLabelsFromStore as label}
                {#if label}
                  <button
                    type="button"
                    class={`flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors ${contextLabelState(label) === 'all' ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'}`}
                    data-state={contextLabelState(label)}
                    onclick={() => contextLabel(label.id || label.keyword || label.value || label.name)}
                  >
                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${label.color || '#9ca3af'}`}></span>
                    <span class="flex-1 text-left">{label.name || label.label || label.value}</span>
                    {#if contextLabelState(label) === 'partial'}
                      <span class="text-muted-foreground">•</span>
                    {:else if contextLabelState(label) === 'all'}
                      <Check class="h-4 w-4 shrink-0" />
                    {/if}
                  </button>
                {/if}
              {/each}
              <div class="my-1 h-px bg-border"></div>
              <button
                type="button"
                class="flex items-center gap-2 w-full px-3 py-2 text-sm transition-colors hover:bg-accent"
                onclick={() => {
                  openLabelModal();
                  contextLabelOpen = false;
                  closeContextMenu();
                }}
              >
                <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${labelFormColor || labelPalette[0]}`}></span>
                <span>New label</span>
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    {#if isVerticalDesktop}
      <button
        type="button"
        class="fe-vertical-resizer"
        aria-label="Resize message and reader panes"
        onmousedown={startVerticalResize}
        onkeydown={(e) => {
          if (e.key === 'ArrowLeft') {
            verticalSplit = Math.max(0.25, verticalSplit - 0.02);
            e.preventDefault();
          } else if (e.key === 'ArrowRight') {
            verticalSplit = Math.min(0.75, verticalSplit + 0.02);
            e.preventDefault();
          }
        }}
      ></button>
    {/if}

    {#if !isProductivityLayout || $mobileReader}
      <section
        class="fe-reader"
        class:mobile-reader-active={$mobileReader}
        bind:this={readerPaneEl}
        ontouchstart={handleReaderSwipeStart}
        ontouchend={handleReaderSwipeEnd}
      >
      {#if outboxSelected && selectedOutboxItem}
        <!-- Outbox Item Reader -->
        {#if $mobileReader}
          <div class="flex items-center gap-2 p-2 border-b border-border">
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Back"
              onclick={() => {
                closeReaderFullscreen({ clearSelection: true });
                selectedOutboxItem = null;
              }}
            >
              <ChevronLeft class="h-5 w-5" />
            </button>
          </div>
        {/if}
        <div class="p-4 border-b border-border">
          <div class="mb-2">
            <strong class="text-lg font-semibold">{selectedOutboxItem.emailData?.subject || '(No subject)'}</strong>
          </div>
            <div class="space-y-1 text-sm">
              <div class="flex items-start gap-2">
                <span class="text-muted-foreground shrink-0">To:</span>
                <span class="flex flex-wrap items-center gap-1">
                  <span
                    class="hover:underline cursor-pointer"
                    data-tooltip="Click to copy"
                    role="button"
                    tabindex="0"
                    onclick={(e) => copyAddressValue(outboxRecipientsList, null, e)}
                    onkeydown={(e) => handleAddressCopyKey(outboxRecipientsList, null, e)}
                  >
                    {displayedOutboxRecipients.join(', ')}{#if outboxRecipientsList.length > 5 && !showAllOutboxRecipients}, ...{/if}
                  </span>
                  {#if outboxRecipientsList.length > 5}
                    <button
                      type="button"
                      class="text-xs text-primary hover:underline cursor-pointer"
                      onclick={() => showAllOutboxRecipients = !showAllOutboxRecipients}
                    >
                      {showAllOutboxRecipients ? 'show less' : `+${remainingOutboxRecipientsCount} more`}
                    </button>
                  {/if}
                </span>
              </div>
              <div class="flex items-center gap-2">
                {formatReaderDate(selectedOutboxItem.createdAt)}
              </div>
            </div>
        </div>
        <div class="flex items-center justify-end gap-2 p-3 border-b border-border">
          <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            selectedOutboxItem.status === 'pending' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' :
            selectedOutboxItem.status === 'sending' ? 'bg-primary/10 text-primary animate-pulse' :
            selectedOutboxItem.status === 'sent' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
            selectedOutboxItem.status === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
          }`}>
            {selectedOutboxItem.status === 'pending' ? 'Queued' :
             selectedOutboxItem.status === 'sending' ? 'Sending...' :
             selectedOutboxItem.status === 'sent' ? 'Sent' :
             selectedOutboxItem.status === 'failed' ? 'Failed' : selectedOutboxItem.status}
          </span>
          {#if selectedOutboxItem.status !== 'sending'}
            <Tooltip.Root>
              <Tooltip.Trigger>
                <button class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground" type="button" onclick={() => { handleDeleteOutbox(selectedOutboxItem); selectedOutboxItem = null; }}>
                  <svg class="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                  </svg>
                </button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Delete</p></Tooltip.Content>
            </Tooltip.Root>
          {/if}
        </div>
        {#if selectedOutboxItem.lastError}
          <div class="flex items-center gap-3 p-3 bg-destructive/10 border border-destructive/20 text-sm text-destructive mx-4 mt-4">
            <small>Error: {selectedOutboxItem.lastError}</small>
          </div>
        {/if}
        <div class="prose prose-sm dark:prose-invert max-w-none" bind:this={outboxMessageBodyContainer}>
          {@html sanitizeOutboxHtml(selectedOutboxItem.emailData?.html || selectedOutboxItem.emailData?.text || '')}
        </div>
        {#if selectedOutboxItem.emailData?.attachments?.length}
          <div class="flex flex-wrap gap-2 mt-4 pt-4 border-t border-border">
            {#each selectedOutboxItem.emailData.attachments as att}
              <div class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary">
                <span>{att.name || att.filename}</span>
                {#if att.size}<span class="text-xs text-muted-foreground">{formatAttachmentSize(att.size)}</span>{/if}
              </div>
            {/each}
          </div>
        {/if}
      {:else if $selectedMessage}
        {#if isProductivityLayout || $mobileReader}
          <div class="flex items-center gap-2 p-2 border-b border-border">
            <button
              class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
              type="button"
              aria-label="Back to list"
              data-tooltip="Back"
              data-tooltip-position="bottom"
              onclick={() => closeReaderFullscreen({ clearSelection: true })}
            >
              <ChevronLeft class="h-5 w-5" />
            </button>
            <div class="flex items-center gap-1">
              {#if canArchive}
                <button
                  class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                  type="button"
                  aria-label="Archive"
                  data-tooltip="Archive"
                  data-tooltip-position="bottom"
                  onclick={archiveSelected}
                >
                  <Archive class="h-5 w-5" />
                </button>
              {/if}
              {#if canNotSpam}
                <button
                  class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                  type="button"
                  aria-label="Not spam"
                  data-tooltip="Not spam"
                  data-tooltip-position="bottom"
                  onclick={markNotSpam}
                >
                  <Inbox class="h-5 w-5" />
                </button>
              {/if}
              <button
                class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                type="button"
                aria-label={readerIsTrashFolder ? 'Delete permanently' : 'Delete'}
                data-tooltip={readerIsTrashFolder ? 'Delete permanently' : 'Delete'}
                data-tooltip-position="bottom"
                onclick={deleteSelected}
              >
                <Trash2 class="h-5 w-5" />
              </button>
              {#if canToggleRead}
                <button
                  class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                  type="button"
                  aria-label={$selectedMessage?.is_unread ? 'Mark read' : 'Mark unread'}
                  data-tooltip={$selectedMessage?.is_unread ? 'Mark read' : 'Mark unread'}
                  data-tooltip-position="bottom"
                  onclick={() => toggleReadMessage($selectedMessage)}
                >
                  <Eye class="h-5 w-5" />
                </button>
              {/if}
              <div class="relative" data-reader-toolbar-move>
                <button
                  class="inline-flex items-center justify-center h-11 w-11 hover:bg-accent hover:text-accent-foreground"
                  type="button"
                  aria-label="Move to"
                  data-tooltip="Move to"
                  data-tooltip-position="bottom"
                  onclick={() => (readerToolbarMoveOpen = !readerToolbarMoveOpen)}
                >
                  <FolderInput class="h-5 w-5" />
                </button>
                {#if readerToolbarMoveOpen}
                  <div class="fixed inset-0 z-[99]" onpointerdown={() => readerToolbarMoveOpen = false} role="presentation" tabindex="-1"></div>
                  <div class="absolute right-0 z-[100] mt-1 min-w-[160px] border border-border bg-popover p-1 shadow-md touch-manipulation" onpointerdown={(e) => e.stopPropagation()} onclick={(e) => e.stopPropagation()}>
                    {#each (availableMoveTargetsFromStore.length ? availableMoveTargetsFromStore : $availableMoveTargets) as folder}
                      <button
                        type="button"
                        class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer"
                        onclick={() => { readerToolbarMoveOpen = false; moveReaderTo(folder.path); }}
                      >
                        {folder.path || folder.name}
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
        <div class="p-4 border-b border-border">
          <div class="flex items-start justify-between gap-4 mb-2">
            <div class="flex-1 min-w-0">
              <strong class="text-lg font-semibold">{threadSubject || $selectedMessage.subject}</strong>
              {#if Array.isArray($selectedMessage.labels) && $selectedMessage.labels.length}
                <div class="flex flex-wrap gap-1.5 mt-2">
                  {#each $selectedMessage.labels as lbl}
                    {#if typeof lbl === 'string' && lbl && lbl !== '[]'}
                      {#if labelMap.get(lbl)}
                        {#if labelMap.get(lbl).color}
                          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs truncate max-w-[150px]" style={`background:${labelMap.get(lbl).color}; color:#fff;`}>
                            {labelMap.get(lbl).name || labelMap.get(lbl).label || labelMap.get(lbl).value || lbl}
                          </span>
                        {:else}
                          <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-secondary text-secondary-foreground truncate max-w-[150px]">
                            {labelMap.get(lbl).name || labelMap.get(lbl).label || labelMap.get(lbl).value || lbl}
                          </span>
                        {/if}
                      {:else}
                        <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-secondary text-secondary-foreground truncate max-w-[150px]">{lbl}</span>
                      {/if}
                    {/if}
                  {/each}
                </div>
              {/if}
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <div class="inline-flex items-center px-2.5 py-1 text-xs font-medium bg-muted text-muted-foreground">
                {$threadingEnabled && $selectedConversation
                  ? ($selectedFolder || $selectedMessage.folder)
                  : ($selectedMessage.folder || $selectedFolder)}
              </div>
              {#if canReply}
                <button
                  class="inline-flex items-center justify-center h-9 w-9 hover:bg-accent hover:text-accent-foreground"
                  type="button"
                  aria-label="Reply"
                  data-tooltip="Reply (R)"
                  data-tooltip-position="bottom"
                  onclick={() => mailboxView?.replyTo?.($selectedMessage)}
                >
                  <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>
                </button>
              {/if}
              <div class="relative" data-action-menu>
                <button
                  class="inline-flex items-center justify-center h-9 w-9 hover:bg-accent hover:text-accent-foreground"
                  type="button"
                  aria-label="Message actions"
                  data-tooltip="Message actions"
                  data-tooltip-position="bottom"
                  onclick={() => {
                    actionMenuOpen = !actionMenuOpen;
                  }}
                >
                  ⋯
                </button>
                {#if actionMenuOpen}
                  <div
                    class="fixed inset-0 z-[99]"
                    onpointerdown={() => actionMenuOpen = false}
                    role="presentation"
                    tabindex="-1"
                  ></div>
                  <div
                    class="absolute right-0 z-[100] mt-1 min-w-[180px] border border-border bg-popover p-1 shadow-lg touch-manipulation"
                    role="menu"
                    tabindex="-1"
                    onpointerdown={(e) => e.stopPropagation()}
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => {
                      if (e.key === 'Escape') actionMenuOpen = false;
                    }}
                  >
                    {#if canReply}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; mailboxView?.replyTo?.($selectedMessage); }}>
                        <Reply class="h-4 w-4" />
                        <span>Reply</span>
                      </button>
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; mailboxView?.replyAll?.($selectedMessage); }}>
                        <ReplyAll class="h-4 w-4" />
                        <span>Reply all</span>
                      </button>
                    {/if}
                    {#if canForward}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; mailboxView?.forwardMessage?.($selectedMessage); }}>
                        <Forward class="h-4 w-4" />
                        <span>Forward</span>
                      </button>
                    {/if}
                    {#if canEditDraft}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; openDraftFromMessage($selectedMessage); }}>
                        <FileEdit class="h-4 w-4" />
                        <span>Edit draft</span>
                      </button>
                    {/if}
                    {#if canToggleRead}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; toggleReadMessage($selectedMessage); }}>
                        <Eye class="h-4 w-4" />
                        <span>{$selectedMessage.is_unread ? 'Mark Read' : 'Mark Unread'}</span>
                      </button>
                    {/if}
                    {#if showReaderMenuDivider}
                      <div class="my-1 h-px bg-border"></div>
                    {/if}
                    {#if canNotSpam}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; markNotSpam(); }}>
                        <Inbox class="h-4 w-4" />
                        <span>Not spam</span>
                      </button>
                    {/if}
                    {#if canArchive}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; archiveSelected(); }}>
                        <Archive class="h-4 w-4" />
                        <span>Archive</span>
                      </button>
                    {/if}
                    <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; deleteSelected(); }}>
                      <Trash2 class="h-4 w-4" />
                      <span>Delete</span>
                    </button>
                    {#if canDownloadOriginal}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; mailboxView?.downloadOriginal?.($selectedMessage); }}>
                        <Download class="h-4 w-4" />
                        <span>Download original</span>
                      </button>
                    {/if}
                    {#if canViewOriginal}
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={() => { actionMenuOpen = false; mailboxView?.viewOriginal?.($selectedMessage); }}>
                        <MailSearch class="h-4 w-4" />
                        <span>View original</span>
                      </button>
                    {/if}
                    <div class="my-1 h-px bg-border"></div>
                    <div class="relative" bind:this={readerMoveBtnEl}>
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={(e) => {
                        e.stopPropagation();
                        if (!readerMoveOpen && readerMoveBtnEl) {
                          const rect = readerMoveBtnEl.getBoundingClientRect();
                          const spaceRight = window.innerWidth - rect.right;
                          readerMoveMenuFlip = spaceRight < 180;
                        }
                        readerMoveOpen = !readerMoveOpen;
                      }}>
                        <FolderInput class="h-4 w-4" />
                        <span class="flex-1 text-left">Move to…</span>
                        <ChevronRight class={`h-4 w-4 transition-transform ${readerMoveMenuFlip ? 'rotate-180' : ''}`} />
                      </button>
                      {#if readerMoveOpen}
                        <div
                          class="absolute z-[101] min-w-[160px] border border-border bg-popover p-1 shadow-lg overflow-y-auto max-h-[300px]"
                          class:left-full={!readerMoveMenuFlip}
                          class:ml-1={!readerMoveMenuFlip}
                          class:right-full={readerMoveMenuFlip}
                          class:mr-1={readerMoveMenuFlip}
                          style="top: 0;"
                        >
                          {#each availableMoveTargetsFromStore as folder}
                            <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer" onclick={() => {
                              readerMoveOpen = false;
                              actionMenuOpen = false;
                              moveReaderTo(folder.path);
                            }}>
                              <span>{folder.path || folder.name}</span>
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>
                    <div class="relative" bind:this={readerLabelBtnEl}>
                      <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer active:bg-accent" onclick={(e) => {
                        e.stopPropagation();
                        if (!readerLabelMenuOpen && readerLabelBtnEl) {
                          const rect = readerLabelBtnEl.getBoundingClientRect();
                          const spaceRight = window.innerWidth - rect.right;
                          readerLabelMenuFlip = spaceRight < 180;
                        }
                        readerLabelMenuOpen = !readerLabelMenuOpen;
                      }}>
                        <Tag class="h-4 w-4" />
                        <span class="flex-1 text-left">Label as…</span>
                        <ChevronRight class={`h-4 w-4 transition-transform ${readerLabelMenuFlip ? 'rotate-180' : ''}`} />
                      </button>
                      {#if readerLabelMenuOpen}
                        <div
                          class="absolute z-[101] min-w-[160px] border border-border bg-popover p-1 shadow-lg overflow-y-auto max-h-[300px]"
                          class:left-full={!readerLabelMenuFlip}
                          class:ml-1={!readerLabelMenuFlip}
                          class:right-full={readerLabelMenuFlip}
                          class:mr-1={readerLabelMenuFlip}
                          style="top: 0;"
                        >
                          {#each availableLabelsFromStore as label}
                            <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer" onclick={() => {
                              mailboxView?.contextLabel?.(
                                $selectedMessage,
                                label.id || label.keyword || label.value || label.name,
                              );
                              readerLabelMenuOpen = false;
                              actionMenuOpen = false;
                            }}>
                              <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${label.color || '#9ca3af'}`}></span>
                              <span>{label.name || label.label || label.value}</span>
                            </button>
                          {/each}
                          <div class="my-1 h-px bg-border"></div>
                          <button type="button" class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground cursor-pointer" onclick={() => {
                            openLabelModal();
                            readerLabelMenuOpen = false;
                            actionMenuOpen = false;
                          }}>
                            <span class="w-2.5 h-2.5 rounded-full shrink-0" style={`background:${labelFormColor || labelPalette[0]}`}></span>
                            <span>New label</span>
                          </button>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            </div>
          </div>
              <div class="space-y-1 text-sm">
                <div class="flex items-start gap-3">
                  <div
                    class="font-medium cursor-pointer hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-tooltip="Click to copy"
                    data-tooltip-position="bottom"
                    role="button"
                    tabindex="0"
                    onclick={(e) => copyAddressValue(extractAddressList($selectedMessage, 'from'), $selectedMessage.from, e)}
                    onkeydown={(e) => handleAddressCopyKey(extractAddressList($selectedMessage, 'from'), $selectedMessage.from, e)}
                  >
                    {#if extractAddressList($selectedMessage, 'from').length}
                      {displayAddresses(extractAddressList($selectedMessage, 'from')).join(', ')}
                    {:else}
                      {$selectedMessage.from}
                    {/if}
                  </div>
                  <button
                    class="text-xs text-primary hover:underline cursor-pointer flex items-center gap-1"
                    type="button"
                    aria-label={showEmailDetails ? 'Hide details' : 'Show details'}
                    title={showEmailDetails ? 'Hide details' : 'Show details'}
                    onclick={() => showEmailDetails = !showEmailDetails}
                  >
                    <svg class="h-3 w-3 transition-transform" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      {#if showEmailDetails}
                        <polyline points="6 15 12 9 18 15"></polyline>
                      {:else}
                        <polyline points="6 9 12 15 18 9"></polyline>
                      {/if}
                    </svg>
                  </button>
                </div>
                {#if showEmailDetails}
                  <div class="mt-3 p-3 bg-muted/50 text-sm space-y-1">
                    <div class="flex items-start gap-2">
                      <span class="text-muted-foreground shrink-0 w-16">from:</span>
                      <span
                        class="flex-1 break-all cursor-pointer hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-tooltip="Click to copy"
                        role="button"
                        tabindex="0"
                        onclick={(e) => copyAddressValue(extractAddressList($selectedMessage, 'from'), $selectedMessage.from, e)}
                        onkeydown={(e) => handleAddressCopyKey(extractAddressList($selectedMessage, 'from'), $selectedMessage.from, e)}
                      >
                        {displayAddresses(extractAddressList($selectedMessage, 'from')).join(', ') || $selectedMessage.from}
                      </span>
                    </div>
                    <div class="flex items-start gap-2">
                      <span class="text-muted-foreground shrink-0 w-16">to:</span>
                      <span class="flex-1 break-all">
                        <span
                          class="hover:underline cursor-pointer"
                          data-tooltip="Click to copy"
                          role="button"
                          tabindex="0"
                          onclick={(e) => copyAddressValue(recipientsList, $selectedMessage.to || $selectedMessage.recipients, e)}
                          onkeydown={(e) => handleAddressCopyKey(recipientsList, $selectedMessage.to || $selectedMessage.recipients, e)}
                        >
                          {displayAddresses(displayedRecipients).join(', ')}{#if recipientsList.length > 5 && !showAllRecipients}, ...{/if}
                        </span>
                        {#if recipientsList.length > 5}
                          <button
                            type="button"
                            class="text-xs text-primary hover:underline cursor-pointer"
                            onclick={() => showAllRecipients = !showAllRecipients}
                          >
                            {showAllRecipients ? 'show less' : `+${remainingRecipientsCount} more`}
                          </button>
                        {/if}
                      </span>
                    </div>
                    {#if ccList.length}
                      <div class="flex items-start gap-2">
                        <span class="text-muted-foreground shrink-0 w-16">cc:</span>
                        <span class="flex-1 break-all">
                          <span
                            class="hover:underline cursor-pointer"
                            data-tooltip="Click to copy"
                            role="button"
                            tabindex="0"
                            onclick={(e) => copyAddressValue(ccList, $selectedMessage.cc, e)}
                            onkeydown={(e) => handleAddressCopyKey(ccList, $selectedMessage.cc, e)}
                          >
                            {displayAddresses(displayedCc).join(', ')}{#if ccList.length > 5 && !showAllCc}, ...{/if}
                          </span>
                          {#if ccList.length > 5}
                            <button
                              type="button"
                              class="text-xs text-primary hover:underline cursor-pointer"
                              onclick={() => showAllCc = !showAllCc}
                            >
                              {showAllCc ? 'show less' : `+${remainingCcCount} more`}
                            </button>
                          {/if}
                        </span>
                      </div>
                    {/if}
                    <div class="flex items-start gap-2">
                      <span class="text-muted-foreground shrink-0 w-16">date:</span>
                      <span class="flex-1 break-all">{formatReaderDate($selectedMessage.date)}</span>
                    </div>
                    <div class="flex items-start gap-2">
                      <span class="text-muted-foreground shrink-0 w-16">subject:</span>
                      <span class="flex-1 break-all">{$selectedMessage.subject}</span>
                    </div>
                    {#if getMailedBy($selectedMessage)}
                      <div class="flex items-start gap-2">
                        <span class="text-muted-foreground shrink-0 w-16">mailed-by:</span>
                        <span class="flex-1 break-all">{getMailedBy($selectedMessage)}</span>
                      </div>
                    {/if}
                    {#if getSignedBy($selectedMessage)}
                      <div class="flex items-start gap-2">
                        <span class="text-muted-foreground shrink-0 w-16">signed-by:</span>
                        <span class="flex-1 break-all">{getSignedBy($selectedMessage)}</span>
                      </div>
                    {/if}
                    {#if getSecurityInfo($selectedMessage)}
                      <div class="flex items-start gap-2">
                        <span class="text-muted-foreground shrink-0 w-16">security:</span>
                        <span class="flex-1 break-all text-green-600 dark:text-green-400">
                          {formatSecurityStatus(getSecurityInfo($selectedMessage))}
                        </span>
                      </div>
                    {/if}
                  </div>
                {:else}
                  {#if getReplyToList($selectedMessage).length}
                    <div class="flex items-center gap-2 mt-2 text-sm">
                      <span class="text-muted-foreground shrink-0">Reply-To:</span>
                      <span
                        class="text-muted-foreground cursor-pointer hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-tooltip="Click to copy"
                        role="button"
                        tabindex="0"
                        onclick={(e) => copyAddressValue(getReplyToList($selectedMessage), $selectedMessage.replyTo || $selectedMessage.reply_to, e)}
                        onkeydown={(e) => handleAddressCopyKey(getReplyToList($selectedMessage), $selectedMessage.replyTo || $selectedMessage.reply_to, e)}
                      >
                        {displayAddresses(getReplyToList($selectedMessage)).join(', ')}
                      </span>
                    </div>
                  {/if}
                  <div class="flex items-start gap-2 text-sm">
                    <span class="text-muted-foreground shrink-0">To:</span>
                    <span class="flex flex-wrap items-center gap-1">
                      <span
                        class="hover:underline cursor-pointer"
                        data-tooltip="Click to copy"
                        role="button"
                        tabindex="0"
                        onclick={(e) => copyAddressValue(recipientsList, $selectedMessage.to || $selectedMessage.recipients, e)}
                        onkeydown={(e) => handleAddressCopyKey(recipientsList, $selectedMessage.to || $selectedMessage.recipients, e)}
                      >
                        {displayAddresses(displayedRecipients).join(', ')}{#if recipientsList.length > 5 && !showAllRecipients}, ...{/if}
                      </span>
                      {#if recipientsList.length > 5}
                        <button
                          type="button"
                          class="text-xs text-primary hover:underline cursor-pointer"
                          onclick={() => showAllRecipients = !showAllRecipients}
                        >
                          {showAllRecipients ? 'show less' : `+${remainingRecipientsCount} more`}
                        </button>
                      {/if}
                    </span>
                  </div>
                  {#if ccList.length}
                    <div class="flex items-start gap-2 text-sm">
                      <span class="text-muted-foreground shrink-0">Cc:</span>
                      <span class="flex flex-wrap items-center gap-1">
                        <span
                          class="hover:underline cursor-pointer"
                          data-tooltip="Click to copy"
                          role="button"
                          tabindex="0"
                          onclick={(e) => copyAddressValue(ccList, $selectedMessage.cc, e)}
                          onkeydown={(e) => handleAddressCopyKey(ccList, $selectedMessage.cc, e)}
                        >
                          {displayAddresses(displayedCc).join(', ')}{#if ccList.length > 5 && !showAllCc}, ...{/if}
                        </span>
                        {#if ccList.length > 5}
                          <button
                            type="button"
                            class="text-xs text-primary hover:underline cursor-pointer"
                            onclick={() => showAllCc = !showAllCc}
                          >
                            {showAllCc ? 'show less' : `+${remainingCcCount} more`}
                          </button>
                        {/if}
                      </span>
                    </div>
                  {/if}
                <div class="flex items-center gap-2">
                  {formatReaderDate($selectedMessage.date)}
                </div>
              {/if}
            </div>
          </div>
        {#if isThreaded}
          <div class="flex items-center justify-between p-3 bg-muted/30 border-b border-border text-sm">
            <span class="text-muted-foreground">{threadMessages.length} messages in this conversation</span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="text-xs text-primary hover:underline cursor-pointer"
                onclick={expandAllThreadMessages}
                title="Expand all messages"
              >
                Expand all
              </button>
              <button
                type="button"
                class="text-xs text-primary hover:underline cursor-pointer"
                onclick={collapseAllThreadMessages}
                title="Collapse all messages"
              >
                Collapse all
              </button>
            </div>
          </div>
          <div class="divide-y divide-border">
            {#each threadMessages as message (message.id)}
              {@const isExpanded = $expandedThreadMessages.has(message.id)}
              {@const isSelected = message.id === $selectedMessage?.id}
              {@const cachedBody = $threadMessageBodies.get(message.id)}
              <article
                class={`p-4 ${isExpanded ? 'border border-border shadow-sm bg-card mb-3' : ''} ${isSelected ? 'ring-2 ring-primary/20' : ''}`}
                data-message-id={message.id}
              >
                <button
                  type="button"
                  class="flex items-center gap-2 cursor-pointer hover:bg-accent/50 p-2 -m-2 mb-2"
                  onclick={() => toggleThreadMessage(message)}
                  aria-expanded={isExpanded}
                >
                  <ChevronRight class={`h-4 w-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                  <span class="font-medium text-foreground truncate">{extractDisplayName(message.from) || message.from}</span>
                  <span class="text-xs text-muted-foreground ml-auto shrink-0">{formatReaderDate(message.date)}</span>
                </button>
                {#if isExpanded && isSelected}
                  {#if showSkeleton}
                    <div class="min-h-[120px] flex items-center justify-center p-6">
                      <div class="w-full space-y-4 animate-pulse">
                        <div class="space-y-2">
                          <div class="h-5 w-3/4 bg-muted"></div>
                          <div class="h-4 w-1/2 bg-muted"></div>
                          <div class="h-3 w-24 bg-muted"></div>
                        </div>
                        <div class="space-y-2 pt-4">
                          <div class="h-3 bg-muted" style="width: 90%"></div>
                          <div class="h-3 bg-muted" style="width: 85%"></div>
                          <div class="h-3 bg-muted" style="width: 92%"></div>
                          <div class="h-3 bg-muted" style="width: 78%"></div>
                          <div class="h-3 bg-muted" style="width: 88%"></div>
                          <div class="h-3 bg-muted" style="width: 80%"></div>
                          <div class="h-3 bg-muted" style="width: 70%"></div>
                        </div>
                      </div>
                    </div>
                  {:else}
                    {#if $pgpLocked}
                      <div class="flex items-center gap-3 p-3 mb-4 bg-blue-500/10 border border-blue-500/20 text-sm">
                        <Lock class="h-4.5 w-4.5 text-blue-500" />
                        <span class="flex-1">
                          This message is PGP encrypted and could not be decrypted.
                        </span>
                        <a
                          href="/mailbox/settings#accounts"
                          class="inline-flex items-center justify-center px-3 py-1.5 text-sm bg-blue-500/20 hover:bg-blue-500/30 text-blue-600 dark:text-blue-400"
                        >
                          Add PGP Key
                        </a>
                      </div>
                    {/if}
                    {#if $hasBlockedImages}
                      <div class="flex items-center gap-3 p-3 mb-4 bg-amber-500/10 border border-amber-500/20 text-sm">
                        <ImageIcon class="h-4.5 w-4.5" />
                        <span>
                          {#if $trackingPixelCount > 0 && $blockedImageCount > 0}
                            {$trackingPixelCount} tracking pixel{$trackingPixelCount !== 1 ? 's' : ''} and {$blockedImageCount} image{$blockedImageCount !== 1 ? 's' : ''} blocked
                          {:else if $trackingPixelCount > 0}
                            {$trackingPixelCount} tracking pixel{$trackingPixelCount !== 1 ? 's' : ''} blocked
                          {:else if $blockedImageCount > 0}
                            {$blockedImageCount} image{$blockedImageCount !== 1 ? 's' : ''} blocked
                          {:else}
                            Images blocked for your privacy
                          {/if}
                        </span>
                        <div style="display: flex; gap: 8px;">
                          {#if $blockedImageCount > 0}
                            <button class="inline-flex items-center justify-center px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" type="button" onclick={loadRemoteImages}>
                              Load Images
                            </button>
                          {/if}
                          {#if $trackingPixelCount > 0}
                            <button
                              class="inline-flex items-center justify-center px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                              type="button"
                              onclick={loadAllIncludingPixels}
                              title="Not recommended: allows senders to track that you opened this email"
                            >
                              Load All
                            </button>
                          {/if}
                        </div>
                      </div>
                    {/if}
                    <EmailIframe
                      html={$messageBody}
                      messageId={$selectedMessage?.id || $selectedMessage?.uid || ''}
                      onLinkClick={handleIframeLinkClick}
                      onFormSubmit={handleIframeFormSubmit}
                    />
                    {#if filterDownloadableAttachments($attachments).length}
                      <div class="flex flex-wrap gap-2 mt-4 pt-4 border-t border-border">
                        {#each filterDownloadableAttachments($attachments) as att}
                          {#if isPreviewableImage(att) && att.href}
                            <div class="flex flex-col gap-1 max-w-[120px]">
                              <button
                                type="button"
                                class="cursor-pointer rounded border border-border overflow-hidden hover:opacity-90 transition-opacity"
                                onclick={() => mailService.downloadAttachment(att, $selectedMessage)}
                                title="Download {att.name || att.filename}"
                              >
                                <img src={att.href} alt={att.name || att.filename} class="max-h-20 max-w-[120px] object-contain" />
                              </button>
                              <div class="flex items-center gap-1.5 text-xs text-muted-foreground px-0.5">
                                <span class="truncate">{att.name || att.filename}</span>
                                {#if att.size}<span class="shrink-0">{formatAttachmentSize(att.size)}</span>{/if}
                                <button
                                  type="button"
                                  class="shrink-0 hover:text-foreground transition-colors cursor-pointer"
                                  onclick={() => mailService.downloadAttachment(att, $selectedMessage)}
                                  title="Download"
                                >
                                  <Download class="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          {:else}
                            <button
                              type="button"
                              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 cursor-pointer transition-colors"
                              onclick={() => mailService.downloadAttachment(att, $selectedMessage)}
                              title="Download {att.name || att.filename}"
                            >
                              <span>{att.name || att.filename}</span>
                              {#if att.size}<span class="text-xs text-muted-foreground">{formatAttachmentSize(att.size)}</span>{/if}
                              <Download class="h-3.5 w-3.5 ml-1" />
                            </button>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  {/if}
                {:else if isExpanded && !isSelected}
                  <!-- Expanded but not selected: show cached body if available -->
                  {#if cachedBody?.loading}
                    <div class="min-h-[120px] flex items-center justify-center p-6">
                      <div class="w-full space-y-4 animate-pulse">
                        <div class="space-y-2 pt-4">
                          <div class="h-3 bg-muted" style="width: 90%"></div>
                          <div class="h-3 bg-muted" style="width: 85%"></div>
                          <div class="h-3 bg-muted" style="width: 78%"></div>
                        </div>
                      </div>
                    </div>
                  {:else if cachedBody?.body}
                    <EmailIframe
                      html={cachedBody.body}
                      messageId={message?.id || message?.uid || ''}
                      onLinkClick={handleIframeLinkClick}
                      onFormSubmit={handleIframeFormSubmit}
                    />
                  {:else}
                    <!-- Fallback to snippet if body not yet loaded -->
                    <div class="p-4 text-sm text-muted-foreground">
                      <div class="text-sm text-muted-foreground">{message.snippet || message.textContent || ''}</div>
                    </div>
                  {/if}
                {:else if !isExpanded}
                  <!-- Collapsed: show snippet inline -->
                  <div class="text-sm text-muted-foreground truncate pl-6">{message.snippet || ''}</div>
                {/if}
              </article>
            {/each}
          </div>
        {:else if $selectedMessage}
          {#if showSkeleton}
            <div class="min-h-[120px] flex items-center justify-center p-6">
              <div class="w-full space-y-4 animate-pulse">
                <div class="space-y-2">
                  <div class="h-5 w-3/4 bg-muted"></div>
                  <div class="h-4 w-1/2 bg-muted"></div>
                  <div class="h-3 w-24 bg-muted"></div>
                </div>
                <div class="space-y-2 pt-4">
                  <div class="h-3 bg-muted" style="width: 90%"></div>
                  <div class="h-3 bg-muted" style="width: 85%"></div>
                  <div class="h-3 bg-muted" style="width: 92%"></div>
                  <div class="h-3 bg-muted" style="width: 78%"></div>
                  <div class="h-3 bg-muted" style="width: 88%"></div>
                  <div class="h-3 bg-muted" style="width: 80%"></div>
                  <div class="h-3 bg-muted" style="width: 70%"></div>
                </div>
              </div>
            </div>
          {:else}
            {#if $pgpLocked}
              <div class="flex items-center gap-3 p-3 mb-4 bg-blue-500/10 border border-blue-500/20 text-sm">
                <Lock class="h-4.5 w-4.5 text-blue-500" />
                <span class="flex-1">
                  This message is PGP encrypted and could not be decrypted.
                </span>
                <a
                  href="/mailbox/settings#accounts"
                  class="inline-flex items-center justify-center px-3 py-1.5 text-sm bg-blue-500/20 hover:bg-blue-500/30 text-blue-600 dark:text-blue-400"
                >
                  Add PGP Key
                </a>
              </div>
            {/if}
            {#if $hasBlockedImages}
              <div class="flex items-center gap-3 p-3 mb-4 bg-amber-500/10 border border-amber-500/20 text-sm">
                <ImageIcon class="h-4.5 w-4.5" />
                <span>
                  {#if $trackingPixelCount > 0 && $blockedImageCount > 0}
                    {$trackingPixelCount} tracking pixel{$trackingPixelCount !== 1 ? 's' : ''} and {$blockedImageCount} image{$blockedImageCount !== 1 ? 's' : ''} blocked
                  {:else if $trackingPixelCount > 0}
                    {$trackingPixelCount} tracking pixel{$trackingPixelCount !== 1 ? 's' : ''} blocked
                  {:else if $blockedImageCount > 0}
                    {$blockedImageCount} image{$blockedImageCount !== 1 ? 's' : ''} blocked
                  {:else}
                    Images blocked for your privacy
                  {/if}
                </span>
                <div style="display: flex; gap: 8px;">
                  {#if $blockedImageCount > 0}
                    <button class="inline-flex items-center justify-center px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" type="button" onclick={loadRemoteImages}>
                      Load Images
                    </button>
                  {/if}
                  {#if $trackingPixelCount > 0}
                    <button
                      class="inline-flex items-center justify-center px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                      type="button"
                      onclick={loadAllIncludingPixels}
                      title="Not recommended: allows senders to track that you opened this email"
                    >
                      Load All
                    </button>
                  {/if}
                </div>
              </div>
            {/if}
            <EmailIframe
              html={$messageBody}
              messageId={$selectedMessage?.id || $selectedMessage?.uid || ''}
              onLinkClick={handleIframeLinkClick}
              onFormSubmit={handleIframeFormSubmit}
            />
            {#if filterDownloadableAttachments($attachments).length}
              <div class="flex flex-wrap gap-2 mt-4 pt-4 border-t border-border">
                {#each filterDownloadableAttachments($attachments) as att}
                  {#if isPreviewableImage(att) && att.href}
                    <div class="flex flex-col gap-1 max-w-[120px]">
                      <button
                        type="button"
                        class="cursor-pointer rounded border border-border overflow-hidden hover:opacity-90 transition-opacity"
                        onclick={() => mailService.downloadAttachment(att, $selectedMessage)}
                        title="Download {att.name || att.filename}"
                      >
                        <img src={att.href} alt={att.name || att.filename} class="max-h-20 max-w-[120px] object-contain" />
                      </button>
                      <div class="flex items-center gap-1.5 text-xs text-muted-foreground px-0.5">
                        <span class="truncate">{att.name || att.filename}</span>
                        {#if att.size}<span class="shrink-0">{formatAttachmentSize(att.size)}</span>{/if}
                        <button
                          type="button"
                          class="shrink-0 hover:text-foreground transition-colors cursor-pointer"
                          onclick={() => mailService.downloadAttachment(att, $selectedMessage)}
                          title="Download"
                        >
                          <Download class="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  {:else}
                    <button
                      type="button"
                      class="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-secondary hover:bg-secondary/80 cursor-pointer transition-colors"
                      onclick={() => mailService.downloadAttachment(att, $selectedMessage)}
                      title="Download {att.name || att.filename}"
                    >
                      <span>{att.name || att.filename}</span>
                      {#if att.size}<span class="text-xs text-muted-foreground">{formatAttachmentSize(att.size)}</span>{/if}
                      <Download class="h-3.5 w-3.5 ml-1" />
                    </button>
                  {/if}
                {/each}
              </div>
            {/if}
          {/if}
        {/if}
      {:else if outboxSelected}
        <div class="px-3 py-2 text-sm text-muted-foreground"></div>
      {:else if isProductivityLayout && readerTransitioning}
        <div class="min-h-[120px] flex items-center justify-center p-6">
          <div class="w-full space-y-4 animate-pulse">
            <div class="space-y-2">
              <div class="h-5 w-3/4 bg-muted"></div>
              <div class="h-4 w-1/2 bg-muted"></div>
              <div class="h-3 w-24 bg-muted"></div>
            </div>
            <div class="space-y-2 pt-4">
              <div class="h-3 bg-muted" style="width: 90%"></div>
              <div class="h-3 bg-muted" style="width: 85%"></div>
              <div class="h-3 bg-muted" style="width: 92%"></div>
              <div class="h-3 bg-muted" style="width: 78%"></div>
              <div class="h-3 bg-muted" style="width: 88%"></div>
              <div class="h-3 bg-muted" style="width: 80%"></div>
              <div class="h-3 bg-muted" style="width: 70%"></div>
            </div>
          </div>
        </div>
      {:else}
        <div class="px-3 py-2 text-sm text-muted-foreground">Select a message to preview.</div>
      {/if}
      </section>
    {/if}
  </div>
  <LabelModal
    visible={labelModalVisible}
    mode="create"
    bind:name={labelFormName}
    bind:color={labelFormColor}
    palette={labelPalette}
    error={labelModalError}
    saving={labelModalSaving}
    showClose={true}
    onClose={closeLabelModal}
    onSave={saveLabelModal}
    onClearError={clearLabelModalError}
  />

  <!-- Confirmation Dialog -->
  {#if confirmDialogVisible}
    <div
      class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      role="presentation"
      tabindex="-1"
      onclick={(e) => { if (e.target === e.currentTarget) hideConfirmDialog(); }}
      onkeydown={(e) => e.key === 'Escape' && hideConfirmDialog()}
    >
      <div
        class="bg-background border border-border shadow-lg max-w-md w-full mx-4 p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
          <div class="text-lg font-semibold mb-4">
            <h3 id="confirm-title">{confirmDialogTitle}</h3>
          </div>
          <div class="text-sm text-muted-foreground mb-6">
            <p>{confirmDialogMessage}</p>
          </div>
          <div class="flex justify-end gap-2">
            <button class="inline-flex items-center justify-center px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground" type="button" onclick={hideConfirmDialog}>
              Cancel
            </button>
            <button
              class={confirmDialogDanger ? 'inline-flex items-center justify-center px-4 py-2 text-sm font-medium bg-destructive text-destructive-foreground hover:bg-destructive/90' : 'inline-flex items-center justify-center px-4 py-2 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90'}
              type="button"
              onclick={confirmAction}
            >
              Confirm
            </button>
          </div>
      </div>
    </div>
  {/if}

  <!-- Mobile Floating Action Button (FAB) for Compose -->
  <Tooltip.Root>
    <Tooltip.Trigger>
      <Button
        class={`fixed bottom-6 right-5 w-14 h-14 rounded-full shadow-lg z-50 md:hidden ${$sidebarOpen || $mobileReader ? 'hidden' : ''}`}
        aria-label="Compose"
        onclick={() => mailboxView?.composeModal?.open?.()}
      >
        <Pencil class="h-5 w-5" />
      </Button>
    </Tooltip.Trigger>
    <Tooltip.Content side="left"><p>Compose</p></Tooltip.Content>
  </Tooltip.Root>

<!-- Folder management components -->
{#if $folderContextMenu}
  <FolderContextMenu
    menu={$folderContextMenu}
    onCreateSubfolder={handleCreateSubfolder}
    onRename={handleRenameFolder}
    onDelete={handleDeleteFolder}
    onMarkAsRead={handleMarkFolderAsRead}
    onClose={closeFolderContextMenu}
    isSystemFolder={isSystemFolder}
  />
{/if}

{#if folderActionModal}
  <FolderActionModal
    action={folderActionModal.action}
    folder={folderActionModal.folder}
    onConfirm={handleFolderActionConfirm}
    onClose={handleFolderActionClose}
  />
{/if}
</div>
{/if}
</Tooltip.Provider>

<!-- Mailto handler prompt (shown once on first INBOX render after sign-in) -->
{#if $selectedFolder === 'INBOX'}
  <MailtoPrompt account={$currentAccount || ''} />
{/if}

<style>
  /* Shared list layout tokens */
  :global(:root) {
    --fe-row-padding: 10px 5px;
    --fe-row-gap: 10px;
    --fe-row-font-size: 13px;
    --fe-row-from-font-size: 12px;
    --fe-row-date-font-size: 11px;
    --fe-row-preview-font-size: 12px;
    --fe-row-column-gap: 10px;
  }

  :global(.fe-layout-productivity) {
  --fe-row-padding: 8px 12px;
  --fe-row-gap: 8px;
  --fe-row-font-size: 11px;
  --fe-row-from-font-size: 11px;
  --fe-row-date-font-size: 11px;
  --fe-row-preview-font-size: 11px;
  --fe-row-column-gap: 12px;
}

  /* ============================================
     COMPACT LAYOUT (PRODUCTIVITY MODE)
     ============================================ */

  /* Shell layout - full screen mode */
  :global(.fe-mailbox-shell.fe-layout-productivity) {
    display: flex;
    gap: 14px;
    min-height: 0;
    height: 100%;
  }

  /* Folders sidebar */
  :global(.fe-mailbox-shell.fe-layout-productivity .fe-folders) {
    width: 280px;
    flex-shrink: 0;
  }

  /* Messages list panel */
  :global(.fe-mailbox-shell.fe-layout-productivity .fe-messages) {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Messages list scrollable area - target the message list wrapper, not pagination */
  :global(.fe-mailbox-shell.fe-layout-productivity .fe-messages .fe-message-list-wrapper) {
    flex: 1;
    overflow-x: hidden;
    overflow-y: auto;
    min-height: 0;
  }

  /* Pagination should not grow */
  :global(.fe-mailbox-shell.fe-layout-productivity .fe-messages .fe-pagination) {
    flex-shrink: 0;
  }

  /* Hide messages when reader is open */
  :global(.fe-mailbox-shell.fe-layout-productivity.mobile-reader .fe-messages) {
    display: none;
  }

  /* Reader hidden by default in compact mode */
  :global(.fe-mailbox-shell.fe-layout-productivity .fe-reader) {
    display: none;
  }

  /* Show reader when active */
  :global(.fe-mailbox-shell.fe-layout-productivity.mobile-reader .fe-reader) {
    display: flex;
    flex: 1;
    min-width: 0;
    min-height: 0;
  }

  /* Vertical split resizer (classic layout) */
  :global(.fe-mailbox-shell.fe-vertical-resizable) {
    display: grid !important;
    grid-template-columns:
      240px
      var(--fe-message-fr, 1fr)
      var(--fe-resizer-width, 10px)
      var(--fe-reader-fr, 1.2fr) !important;
    gap: 0 !important;
  }

  :global(.fe-mailbox-shell.fe-vertical-resizable.fe-shell-collapsed) {
    display: grid !important;
    grid-template-columns:
      var(--fe-message-fr, 1fr)
      var(--fe-resizer-width, 10px)
      var(--fe-reader-fr, 1.2fr) !important;
    gap: 0 !important;
  }

  /* Ensure grid children fill their cells and don't overflow */
  :global(.fe-mailbox-shell.fe-vertical-resizable > .fe-folders),
  :global(.fe-mailbox-shell.fe-vertical-resizable > .fe-messages),
  :global(.fe-mailbox-shell.fe-vertical-resizable > .fe-reader) {
    min-width: 0;
    width: 100%;
  }

  .fe-vertical-resizer {
    display: none;
    border: none;
    background: transparent;
    width: var(--fe-resizer-width, 10px);
    min-width: var(--fe-resizer-width, 10px);
    max-width: var(--fe-resizer-width, 10px);
    cursor: col-resize;
    align-self: stretch;
    position: relative;
    padding: 0;
    margin: 0;
  }

  .fe-vertical-resizer::before {
    content: '';
    position: absolute;
    top: 18px;
    bottom: 18px;
    left: 50%;
    width: 3px;
    transform: translateX(-50%);
    background: var(--color-border, #e5e7eb);
    border-radius: 999px;
    opacity: 0.7;
  }

  .fe-vertical-resizer:hover::before {
    background: var(--color-accent, #00aff8);
    opacity: 1;
  }

  @media (min-width: 901px) {
    .fe-vertical-resizer {
      display: block;
    }
  }

  /* Tighter padding for compact mode */
  :global(.fe-layout-productivity .fe-messages),
  :global(.fe-layout-productivity .fe-reader) {
    padding: 10px;
    min-height: 0;
  }

  /* Mailbox wrapper needs flex layout to fill height */
  .fe-mailbox-wrapper {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* Shell needs to fill remaining space */
  .fe-mailbox-wrapper > .fe-mailbox-shell {
    flex: 1;
    min-height: 0;
  }

  :global(.fe-layout-productivity .fe-mailbox-wrapper) {
    padding-top: 6px;
  }

  /* Conversation, thread, message, and reader styles moved to Tailwind */

  /* Folder sidebar layout - push storage to bottom on desktop */
  /* Only apply flex layout on desktop; mobile uses display:none/block from mailbox.css */
  @media (min-width: 821px) {
    aside.fe-folders {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 60px);
      padding: 12px 12px 10px;
    }
  }

  /* Mobile sidebar when open */
  @media (max-width: 820px) {
    aside.fe-folders.fe-folders-open {
      display: flex;
      flex-direction: column;
      padding: 12px 12px 10px;
    }
  }


  /* Highlight drop targets */
  .fe-drag-over {
    background: rgba(59, 130, 246, 0.1) !important;
    border-left: 3px solid #3b82f6;
    box-shadow: none !important;
  }

  /* Show move preview on folder hover */
  .fe-drag-over::after {
    content: 'Drop to move here';
    position: absolute;
    right: 12px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11px;
    color: #3b82f6;
    font-weight: 500;
    pointer-events: none;
    z-index: 10;
  }

  /* Make folders slightly larger drop targets during drag */
  :global(body.dragging) ul.space-y-0\.5 > li {
    min-height: 44px;
  }

  /* Prevent text selection during drag */
  :global(body.dragging) {
    user-select: none;
    -webkit-user-select: none;
  }

</style>
