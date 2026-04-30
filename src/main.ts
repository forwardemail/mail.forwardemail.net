import './polyfills';
import * as mailboxActions from './stores/mailboxActions';
import { createStarfield } from './utils/starfield';
import { Local, Accounts, reconcileOrphanedAccountData } from './utils/storage';
import {
  keyboardShortcuts,
  showKeyboardShortcutsHelp,
  TAB_SHORTCUTS,
} from './utils/keyboard-shortcuts';
import { i18n } from './utils/i18n';
import { createToastHost } from './svelte/toastsHost';
import Login from './svelte/Login.svelte';
import Settings from './svelte/Settings.svelte';
import Passphrase from './svelte/PassphraseModal.svelte';
import Mailbox from './svelte/Mailbox.svelte';
import Profile from './svelte/Profile.svelte';
import Diagnostics from './svelte/Diagnostics.svelte';
import Calendar from './svelte/Calendar.svelte';
import Contacts from './svelte/Contacts.svelte';
import Compose from './svelte/Compose.svelte';
import { mailService } from './stores/mailService';
import { mailboxStore } from './stores/mailboxStore';
import { effectiveTheme, getEffectiveSettingValue } from './stores/settingsStore';
import {
  closeTab,
  activateTab,
  getNextTabId,
  getPrevTabId,
  getTabIdByIndex,
  resetTabs,
  activeTabId,
  openMessageTab,
} from './stores/tabStore';
import { writable, get } from 'svelte/store';
import { mount } from 'svelte';
// Design system styles - base reset first, then tokens, components, pages, then main
import './styles/base.css';
import './styles/tokens.css';
import './styles/components/index.css';
import './styles/pages/index.css';
import './styles/main.css';

// Initialize error logger for feedback system
import './utils/error-logger';
import { sendSyncTask, terminateSyncWorker } from './utils/sync-worker-client.js';
import { canUseServiceWorker, isTauri, isTauriDesktop, isTauriMobile } from './utils/platform.js';
import { openComposeWindow, initComposeWindowListener } from './utils/compose-window';
import {
  isLockEnabled,
  isUnlocked,
  isVaultConfigured,
  wasUnlockedThisSession,
  lock as lockCryptoStore,
  restoreSessionCredentials,
} from './utils/crypto-store.js';
import {
  start as startInactivityTimer,
  pause as pauseInactivityTimer,
  resume as resumeInactivityTimer,
} from './utils/inactivity-timer.js';
import { startOutboxProcessor, processOutbox } from './utils/outbox-service';
import { initMutationQueue, processMutationQueue } from './utils/mutation-queue';
import { initNetworkStatus } from './utils/network-status';
import { syncPendingDrafts, deleteDraft } from './utils/draft-service';
import { setIndexToasts, searchStore } from './stores/searchStore';
import { setDemoToasts } from './utils/demo-mode';
import { setNotificationToasts } from './utils/notification-manager';
import { bindExternalLinkInterceptor } from './utils/external-links.js';
// Database initialization with recovery support
import {
  initializeDatabase,
  setRecoveryCallbacks,
  setTerminateWorkersCallback,
  terminateDbWorker,
} from './utils/db';
import { markBootstrapReady, markAppReady } from './utils/bootstrap-ready.js';
import { initPerfObservers } from './utils/perf-logger.ts';
import { attemptRecovery } from './utils/db-recovery';
import { parseMailto, mailtoToPrefill } from './utils/mailto';
import { selectedFolder, folders } from './stores/folderStore';
import {
  messageBody,
  selectedMessage,
  attachments,
  searchResults,
  searchActive,
  searching,
  messages,
  page,
  hasNextPage,
  filteredMessages,
  loading,
  messageLoading,
} from './stores/messageStore';
import {
  threadingEnabled,
  sidebarOpen,
  showFilters,
  query,
  unreadOnly,
  hasAttachmentsOnly,
} from './stores/viewStore';
import {
  selectedConversationIds,
  selectedConversationCount,
  filteredConversations,
} from './stores/conversationStore';

// Ensure hidden views don't block interaction
const style = document.createElement('style');
style.textContent = `
  #login-wrapper[style*="display: none"],
  #login-wrapper[style*="display: none"] *,
  #mailbox-root[style*="display: none"],
  #mailbox-root[style*="display: none"] *,
  #settings-root[style*="display: none"],
  #settings-root[style*="display: none"] *,
  #calendar-root[style*="display: none"],
  #calendar-root[style*="display: none"] *,
  #contacts-root[style*="display: none"],
  #contacts-root[style*="display: none"] *,
  #profile-root[style*="display: none"],
  #profile-root[style*="display: none"] * {
    pointer-events: none !important;
    visibility: hidden !important;
  }

  /* Ensure compose modal is always visible and clickable when present */
  #compose-root {
    pointer-events: auto !important;
    position: relative;
    z-index: 9999;
  }

  #compose-root .fe-modal-backdrop {
    display: flex !important;
    visibility: visible !important;
    opacity: 1 !important;
  }

  #compose-root .fe-modal {
    display: flex !important;
    flex-direction: column !important;
    visibility: visible !important;
    opacity: 1 !important;
  }
`;
document.head.append(style);

// Register tab shortcuts early (before component mount) so Settings.svelte sees them
if (isTauriDesktop) {
  keyboardShortcuts.addShortcuts(TAB_SHORTCUTS);
}

// Calendar, Contacts, and Compose are statically imported (see top of file)
// to prevent Svelte 5 runtime state fragmentation.  Dynamic imports combined
// with Vite's manualChunks caused each chunk to receive its own copy of
// Svelte's internal init_operations() state, leaving next_sibling_getter
// uninitialised and crashing bits-ui floating-layer components.
// See: https://github.com/sveltejs/svelte/issues/15960
//      https://github.com/huntabyte/bits-ui/issues/1465
//      https://github.com/huntabyte/shadcn-svelte/issues/1961

function detectRoute() {
  const parameters = new URLSearchParams(globalThis.location.search);
  const isAddingAccount = parameters.get('add_account') === 'true';

  if (globalThis.location.pathname === '/login') {
    return 'login';
  }

  if (globalThis.location.pathname.startsWith('/calendar')) {
    return 'calendar';
  }

  if (globalThis.location.pathname.startsWith('/contacts')) {
    return 'contacts';
  }

  if (globalThis.location.pathname.startsWith('/mailbox/profile')) {
    return 'profile';
  }

  if (globalThis.location.pathname.startsWith('/mailbox/settings')) {
    return 'settings';
  }

  // Hidden diagnostics page — auth-independent so users locked out at login
  // can still produce a support report. Not linked from the main UI.
  if (globalThis.location.pathname.startsWith('/mailbox/diagnostics')) {
    return 'diagnostics';
  }

  if (globalThis.location.pathname.startsWith('/mailbox')) {
    return 'mailbox';
  }

  // For root path, check if user is authenticated
  if (globalThis.location.pathname === '/' || globalThis.location.pathname === '') {
    // If adding account, always show login regardless of auth status
    if (isAddingAccount) {
      return 'login';
    }

    const hasAuth = Local.get('authToken') || Local.get('alias_auth');
    return hasAuth ? 'mailbox' : 'login';
  }

  return 'login';
}

const routeStore = writable(detectRoute());
const currentRoute = () => get(routeStore);

let composeVisible = false;
let composeMinimized = false;
let composeCompact = false;
let unsubscribeComposeVisibility = null;
let unsubscribeComposeMinimized = null;
let unsubscribeComposeCompact = null;

const updateShortcutState = (route) => {
  const activeRoute = route || currentRoute();
  const inMailbox = activeRoute === 'mailbox';
  const inSettings = activeRoute === 'settings';
  const inCalendar = activeRoute === 'calendar';
  const inContacts = activeRoute === 'contacts';
  const composeOpen = composeVisible && !composeMinimized && inMailbox;
  // Allow keyboard shortcuts when compose is in compact mode (user can interact with mailbox)
  const composeBlocking = composeOpen && !composeCompact;

  keyboardShortcuts.setEnabled(inMailbox && !composeBlocking);

  if (composeOpen) {
    keyboardShortcuts.setContext('compose');
  } else if (inMailbox) {
    keyboardShortcuts.setContext('list');
  } else if (inSettings) {
    keyboardShortcuts.setContext('settings');
  } else if (inCalendar) {
    keyboardShortcuts.setContext('calendar');
  } else if (inContacts) {
    keyboardShortcuts.setContext('contacts');
  } else {
    keyboardShortcuts.setContext('default');
  }
};

const viewModel = {
  // Keep a mailboxView-compatible object for backwards compatibility during migration
  mailboxView: {
    // State stores
    storageUsed: mailboxActions.storageUsed,
    storageTotal: mailboxActions.storageTotal,
    localUsage: mailboxActions.localUsage,
    localQuota: mailboxActions.localQuota,
    indexCount: mailboxActions.indexCount,
    indexSize: mailboxActions.indexSize,
    syncPending: mailboxActions.syncPending,
    bodyIndexingEnabled: mailboxActions.bodyIndexingEnabled,
    starredOnly: mailboxActions.starredOnly,
    layoutMode: mailboxActions.layoutMode,
    threadingEnabled,
    selectedConversationIds,
    selectedConversation: mailboxActions.selectedConversation,
    selectedMessage,
    messageBody,
    attachments,
    searchResults,
    searchActive,
    searching,
    accounts: mailboxActions.accounts,
    currentAccount: mailboxActions.currentAccount,
    accountMenuOpen: mailboxActions.accountMenuOpen,
    sidebarOpen,
    mobileReader: mailboxActions.mobileReader,
    showFilters,
    selectedConversationCount,
    bulkMoveOpen: mailboxActions.bulkMoveOpen,
    availableMoveTargets: mailboxActions.availableMoveTargets,
    availableLabels: mailboxActions.availableLabels,
    query,
    unreadOnly,
    hasAttachmentsOnly,
    messages,
    page,
    hasNextPage,
    filteredMessages,
    filteredConversations,
    loading,
    messageLoading,

    // Actions
    load: async () => mailboxActions.load(),
    loadMessages: async () => mailboxActions.loadMessages(),
    toggleRead: async (message) => mailboxActions.toggleRead(message),
    archiveMessage: async (message) => mailboxActions.archiveMessage(message),
    deleteMessage: async (message, options) => mailboxActions.deleteMessage(message, options),
    toggleStar: async (message) => mailboxActions.toggleStar(message),
    replyTo: async (message) => mailboxActions.replyTo(message),
    replyAll: async (message) => mailboxActions.replyAll(message),
    forwardMessage: async (message) => mailboxActions.forwardMessage(message),
    onSearch: async (term) => mailboxActions.onSearch(term),
    getSelectedConversations: () => mailboxActions.getSelectedConversations(),
    getSelectedMessagesFromConversations: () =>
      mailboxActions.getSelectedMessagesFromConversations(),
    bulkMoveTo: async (target) => mailboxActions.bulkMoveTo(target),
    contextMoveTo: async (message, target) => mailboxActions.contextMoveTo(message, target),
    contextLabel: async (message, label, options) =>
      mailboxActions.contextLabel(message, label, options),
    createLabel: async (name, color) => mailboxActions.createLabel(name, color),
    loadLabels: async () => mailboxActions.loadLabels(),
    rebuildFullSearchIndex: async () => mailboxActions.rebuildFullSearchIndex(),
    rebuildSearchFromCache: async () => mailboxActions.rebuildSearchFromCache(),
    toggleBodyIndexing() {
      mailboxActions.toggleBodyIndexing();
    },
    toggleAccountMenu() {
      mailboxActions.toggleAccountMenu();
    },
    toggleBulkMove() {
      mailboxActions.toggleBulkMove();
    },
    addAccount() {
      mailboxActions.addAccount();
    },
    switchAccount: async (acct) => mailboxActions.switchAccount(acct),
    signOut: async () => mailboxActions.signOut(),
    setLayoutMode: async (mode) => mailboxActions.setLayoutMode(mode),
    moveTarget: selectedFolder, // Alias for compatibility
    downloadOriginal: async (message) => mailboxActions.downloadOriginal(message),
    viewOriginal: async (message) => mailboxActions.viewOriginal(message),
  },
  // Keep settingsModal for compatibility
  settingsModal: (() => {
    const visibleStore = writable(false);
    return {
      visible(value) {
        if (value !== undefined) {
          visibleStore.set(value);
        }

        return get(visibleStore);
      },
      open() {
        visibleStore.set(true);
      },
      storageUsed: mailboxActions.storageUsed,
      storageTotal: mailboxActions.storageTotal,
      localUsage: mailboxActions.localUsage,
      localQuota: mailboxActions.localQuota,
      indexCount: mailboxActions.indexCount,
      indexSize: mailboxActions.indexSize,
      syncPending: mailboxActions.syncPending,
      bodyIndexingEnabled: mailboxActions.bodyIndexingEnabled,
      rebuildIndex: async () => mailboxActions.rebuildFullSearchIndex(),
      toggleBodyIndexing() {
        mailboxActions.toggleBodyIndexing();
      },
    };
  })(),
  route: routeStore,
  currentRoute,
};

const toastsRoot = document.querySelector('#toasts-root');
const toasts = toastsRoot
  ? createToastHost(toastsRoot)
  : {
      show() {},
      dismiss() {},
      items: {
        subscribe: (run) => run([]) || (() => {}),
      },
    };

globalThis.addEventListener('outbox-sent', (event) => {
  const subject = event?.detail?.subject;
  toasts.show(`Message sent${subject ? `: ${subject}` : ''}`, 'success');
});

globalThis.addEventListener('mutation-queue-failed', () => {
  toasts.show("Some changes couldn't be synced. Please try again.", 'error');
});

// Manual lock button — dispatched from Mailbox.svelte sidebar
globalThis.addEventListener('fe:lock-app', () => {
  if (!isLockEnabled() || !isVaultConfigured()) {
    return;
  }

  lockCryptoStore();
  pauseInactivityTimer();
  showLockScreen().then(() => {
    resumeInactivityTimer();
  });
});

// Set up mailboxActions references
mailboxActions.setToasts(toasts);
setIndexToasts(toasts);
setDemoToasts(toasts);
setNotificationToasts(toasts);
viewModel.toasts = toasts;
viewModel.mailboxView.toasts = toasts;

const loginRoot = document.querySelector('#login-root');
const loginWrapper = document.querySelector('.fe-login-shell');
if (loginRoot) {
  mount(Login, {
    target: loginRoot,
    props: {
      onSuccess(path = '/mailbox') {
        mailboxActions.resetSessionState?.();
        if (viewModel.navigate) {
          // Replace the login history entry so users cannot swipe back to it
          viewModel.navigate(path, { replace: true });
        } else {
          globalThis.location.replace(path);
        }
      },
    },
  });
}

const settingsRoot = document.querySelector('#settings-root');
const profileRoot = document.querySelector('#profile-root');

if (settingsRoot) {
  mount(Settings, {
    target: settingsRoot,
    props: {
      navigate: (path: string) => viewModel.navigate?.(path),
      storageUsed: viewModel.mailboxView.storageUsed,
      storageTotal: viewModel.mailboxView.storageTotal,
      localUsage: viewModel.mailboxView.localUsage,
      localQuota: viewModel.mailboxView.localQuota,
      syncPending: viewModel.mailboxView.syncPending,
      indexCount: viewModel.mailboxView.indexCount,
      indexSize: viewModel.mailboxView.indexSize,
      bodyIndexingEnabled: viewModel.mailboxView.bodyIndexingEnabled,
      rebuildIndex:
        viewModel.mailboxView.rebuildFullSearchIndex?.bind(viewModel.mailboxView) ||
        viewModel.mailboxView.rebuildSearchFromCache?.bind(viewModel.mailboxView) ||
        (async () => {
          console.warn('rebuildIndex not available');
        }),
      toggleBodyIndexing: viewModel.mailboxView.toggleBodyIndexing.bind(viewModel.mailboxView),
      toasts,
      applyTheme,
      applyFont,
    },
  });
}

// Diagnostics page — mounted lazily on first navigation. Auth-independent
// so it works when login or sync is broken (the times we most need it).
const diagnosticsRoot = document.querySelector('#diagnostics-root') as HTMLElement | null;
let _diagnosticsApp: ReturnType<typeof mount> | null = null;
function mountDiagnostics() {
  if (_diagnosticsApp || !diagnosticsRoot) return;
  _diagnosticsApp = mount(Diagnostics, { target: diagnosticsRoot });
}

let _profileApp = null;
const profileActive = writable(currentRoute() === 'profile');
if (profileRoot) {
  _profileApp = mount(Profile, {
    target: profileRoot,
    props: {
      navigate: (path: string) => viewModel.navigate?.(path),
      active: profileActive,
    },
  });
}

const calendarRoot = document.querySelector('#calendar-root');
let _calendarApp = null;
let calendarApi = {
  reload() {},
  prefillQuickEvent() {},
};

const calendarActive = writable(currentRoute() === 'calendar');

// Flag set after bootstrap() completes.  routeStore.subscribe fires
// immediately on subscription (before bootstrap), so without this guard
// mountCalendar/mountContacts would run on the login page and crash.
let _bootstrapComplete = false;

// Flag to track whether background services (sync, outbox, keyboard shortcuts,
// etc.) have been started.  They are deferred until the first authenticated
// mailbox route to avoid errors on the login page, but must only start once.
let _backgroundServicesStarted = false;

// Calendar is now statically imported — mount synchronously.
function mountCalendar() {
  if (_calendarApp || !calendarRoot) {
    return;
  }

  try {
    _calendarApp = mount(Calendar, {
      target: calendarRoot,
      props: {
        navigate: (path: string) => viewModel.navigate?.(path),
        toasts,
        active: calendarActive,
        registerApi(api: typeof calendarApi) {
          if (api) {
            calendarApi = api;
            if (currentRoute() === 'calendar') {
              calendarApi.reload?.();
            }
          }
        },
      },
    });
  } catch (err) {
    console.error('Failed to mount calendar component', err);
  }
}

viewModel.calendarView = {
  load() {
    calendarApi.reload?.();
  },
  prefillQuickEvent(email) {
    calendarApi.prefillQuickEvent?.(email);
  },
};

const contactsRoot = document.querySelector('#contacts-root');
let contactsApi = {
  reload() {},
};

// Contacts is now statically imported — mount synchronously.
function mountContacts() {
  if (!contactsRoot) {
    return;
  }

  // Guard: only mount once (successful mount sets dataset.mounted)
  if (contactsRoot.dataset.mounted) {
    return;
  }

  try {
    contactsRoot.dataset.mounted = '1';
    mount(Contacts, {
      target: contactsRoot,
      props: {
        navigate: (path: string) => viewModel.navigate?.(path),
        toasts,
        registerApi(api: typeof contactsApi) {
          if (api) {
            contactsApi = api;
            if (currentRoute() === 'contacts') {
              contactsApi.reload?.();
            }
          }
        },
      },
    });
  } catch (err) {
    console.error('Failed to mount contacts component', err);
  }
}

// Wire WebSocket CustomEvents to Calendar and Contacts APIs.
// The websocket-updater dispatches these events when CalDAV/CardDAV changes arrive.
// We listen here because calendarApi/contactsApi are only available in main.ts scope.
// Store references for cleanup on sign-out.
const _feCalendarChanged = () => {
  calendarApi.reload?.();
};

const _feCalendarEventChanged = () => {
  calendarApi.reload?.();
};

const _feContactsChanged = () => {
  contactsApi.reload?.();
};

const _feContactChanged = () => {
  contactsApi.reload?.();
};

const _feMailServiceToast = (event: Event) => {
  const detail = (event as CustomEvent<{ message?: string; type?: string }>).detail;
  const message = typeof detail?.message === 'string' ? detail.message : '';
  const type = typeof detail?.type === 'string' ? detail.type : 'error';
  if (message) {
    toasts?.show?.(message, type);
  }
};

// Wire the `fe:new-release` CustomEvent (dispatched by websocket-updater's
// releaseWatcher) to the updater modules.  This follows the same pattern
// used for CalDAV/CardDAV events above — websocket-updater dispatches,
// main.ts routes to the appropriate consumer.
let _handleNewReleaseTauri: ((e: Event) => void) | undefined = null;
let _handleNewReleaseWeb: ((e: Event) => void) | undefined = null;

globalThis.addEventListener('fe:calendar-changed', _feCalendarChanged);
globalThis.addEventListener('fe:calendar-event-changed', _feCalendarEventChanged);
globalThis.addEventListener('fe:contacts-changed', _feContactsChanged);
globalThis.addEventListener('fe:contact-changed', _feContactChanged);
globalThis.addEventListener('fe:mail-service-toast', _feMailServiceToast);

export function cleanupCustomEventListeners() {
  globalThis.removeEventListener('fe:calendar-changed', _feCalendarChanged);
  globalThis.removeEventListener('fe:calendar-event-changed', _feCalendarEventChanged);
  globalThis.removeEventListener('fe:contacts-changed', _feContactsChanged);
  globalThis.removeEventListener('fe:contact-changed', _feContactChanged);
  globalThis.removeEventListener('fe:mail-service-toast', _feMailServiceToast);
  if (_handleNewReleaseTauri) {
    globalThis.removeEventListener('fe:new-release', _handleNewReleaseTauri);
    _handleNewReleaseTauri = null;
  }

  if (_handleNewReleaseWeb) {
    globalThis.removeEventListener('fe:new-release', _handleNewReleaseWeb);
    _handleNewReleaseWeb = null;
  }
}

const composeRoot = document.querySelector('#compose-root');
let _composeApp = null;
let composeApi = {
  open() {},
  close() {},
  forward() {},
  reply() {},
  setContacts() {},
  isVisible: () => false,
  isMinimized: () => false,
  setToList() {},
  saveDraft() {},
};

const passphraseRoot = document.querySelector('#passphrase-root');
let passphraseApi = {
  async open() {
    throw new Error('Passphrase modal not available');
  },
  close() {},
};

const mailboxRoot = document.querySelector('#mailbox-root');
let _mailboxApp = null;
let mailboxApi = null;

const composeMailboxView = writable(null);
// Compose is now statically imported — mount synchronously.
if (composeRoot) {
  try {
    _composeApp = mount(Compose, {
      target: composeRoot,
      props: {
        toasts,
        mailboxView: composeMailboxView,
        onSent(result?: { archive?: boolean; queued?: boolean }) {
          if (result?.archive) {
            const message = get(selectedMessage);
            if (message) {
              mailboxActions.archiveMessage(message).catch((error) => {
                console.error('[Compose] Failed to archive after send:', error);
              });
            }
          }
        },
        registerApi(api: typeof composeApi) {
          if (api) {
            composeApi = api;
            if (unsubscribeComposeVisibility) {
              unsubscribeComposeVisibility();
              unsubscribeComposeVisibility = null;
            }

            if (api.visibility?.subscribe) {
              unsubscribeComposeVisibility = api.visibility.subscribe((isVisible: boolean) => {
                composeVisible = Boolean(isVisible);
                if (!composeVisible) {
                  composeMinimized = false;
                }

                updateShortcutState();
              });
            }

            if (unsubscribeComposeMinimized) {
              unsubscribeComposeMinimized();
              unsubscribeComposeMinimized = null;
            }

            if (api.minimized?.subscribe) {
              unsubscribeComposeMinimized = api.minimized.subscribe((isMinimized: boolean) => {
                composeMinimized = Boolean(isMinimized);
                updateShortcutState();
              });
            } else if (api.isMinimized) {
              composeMinimized = Boolean(api.isMinimized());
              updateShortcutState();
            }

            if (unsubscribeComposeCompact) {
              unsubscribeComposeCompact();
              unsubscribeComposeCompact = null;
            }

            if (api.compact?.subscribe) {
              unsubscribeComposeCompact = api.compact.subscribe((isCompact: boolean) => {
                composeCompact = Boolean(isCompact);
                updateShortcutState();
              });
            }
          }
        },
      },
    });
  } catch (err) {
    console.error('Failed to mount compose component', err);
  }
}

if (passphraseRoot) {
  mount(Passphrase, {
    target: passphraseRoot,
    props: {
      registerApi(api: typeof passphraseApi) {
        if (api) {
          passphraseApi = api;
          viewModel.pgpPassphraseModal = passphraseApi;
          viewModel.mailboxView.passphraseModal = passphraseApi;
          mailService.setPassphraseModal(passphraseApi);
        }
      },
    },
  });
}

const mailboxActive = writable(currentRoute() === 'mailbox');
if (mailboxRoot) {
  _mailboxApp = mount(Mailbox, {
    target: mailboxRoot,
    props: {
      mailboxView: viewModel.mailboxView,
      mailboxStore,
      navigate: (path: string) => viewModel.navigate?.(path),
      active: mailboxActive,
      applyTheme,
      registerApi(api: typeof mailboxApi) {
        if (api) {
          mailboxApi = api;
        }
      },
    },
  });

  // Initialize desktop-only systems (tabs + compose window listener)
  if (isTauriDesktop) {
    resetTabs('INBOX');
    initComposeWindowListener();

    // Keep dock/taskbar badge in sync with INBOX unread count
    folders.subscribe((list) => {
      const inbox = list.find((f) => f.path?.toUpperCase?.() === 'INBOX');
      const count = inbox?.count ?? 0;
      import('./utils/notification-manager.js')
        .then(({ setBadgeCount }) => setBadgeCount(count))
        .catch(() => {});
    });
  }

  // Tauri: intercept all external link clicks app-wide and route them
  // through the shared helper. WRY doesn't reliably support target="_blank"
  // for external links, so explicit opener calls remain the safest behavior.
  if (isTauri) {
    bindExternalLinkInterceptor({
      navigate: (nextPath: string) => viewModel.navigate(nextPath),
      log(...args: unknown[]) {
        console.warn('[main]', ...args);
      },
    });
  }
}

const updateRouteVisibility = (route) => {
  if (loginWrapper) {
    loginWrapper.style.display = route === 'login' ? 'block' : 'none';
  }

  if (mailboxRoot) {
    mailboxRoot.style.display = route === 'mailbox' ? 'block' : 'none';
  }

  if (settingsRoot) {
    settingsRoot.style.display = route === 'settings' ? 'block' : 'none';
  }

  if (calendarRoot) {
    calendarRoot.style.display = route === 'calendar' ? 'block' : 'none';
  }

  if (contactsRoot) {
    contactsRoot.style.display = route === 'contacts' ? 'block' : 'none';
  }

  if (profileRoot) {
    profileRoot.style.display = route === 'profile' ? 'block' : 'none';
  }

  if (diagnosticsRoot) {
    diagnosticsRoot.style.display = route === 'diagnostics' ? 'block' : 'none';
  }
};

// Forward declaration for handleHashActions
let handleHashActions;
const autoSyncTimer = null;
let starfieldDisposer = null;
let themeUnsub = null;
let systemThemeMediaQuery = null;

// SPA-style navigation to avoid reload flicker
viewModel.navigate = (path, options) => {
  if (!path || typeof path !== 'string') {
    return;
  }

  const sameOrigin = path.startsWith('/');
  if (!sameOrigin) {
    globalThis.location.href = path;
    return;
  }

  // Check auth for protected routes
  const targetRoute = path.startsWith('/mailbox/settings')
    ? 'settings'
    : path.startsWith('/mailbox/profile')
      ? 'profile'
      : path.startsWith('/mailbox')
        ? 'mailbox'
        : path.startsWith('/calendar')
          ? 'calendar'
          : path.startsWith('/contacts')
            ? 'contacts'
            : 'login';

  if (
    (targetRoute === 'mailbox' ||
      targetRoute === 'settings' ||
      targetRoute === 'profile' ||
      targetRoute === 'calendar' ||
      targetRoute === 'contacts') &&
    !Local.get('authToken') &&
    !Local.get('alias_auth')
  ) {
    history.replaceState({ route: 'login' }, '', '/');
    routeStore.set('login');
    return;
  }

  const useReplace = options?.replace === true;
  const stateObject = { route: targetRoute };
  const previousHash = window.location.hash;
  const previousHref = window.location.href;
  if (useReplace) {
    history.replaceState(stateObject, '', path);
  } else {
    history.pushState(stateObject, '', path);
  }

  // history.{push,replace}State doesn't fire `hashchange` even when only
  // the hash changes (per HTML spec). Components that listen for
  // hashchange (e.g. Calendar's tab section) rely on it for in-page nav,
  // so we synthesise the event here when the hash actually changed.
  if (window.location.hash !== previousHash) {
    window.dispatchEvent(
      new HashChangeEvent('hashchange', {
        oldURL: previousHref,
        newURL: window.location.href,
      }),
    );
  }

  routeStore.set(detectRoute());

  // Dispatch event for Login component to clear fields when adding account
  if (path.includes('add_account=true')) {
    globalThis.dispatchEvent(new CustomEvent('login-clear-fields'));
  }

  // Handle hash-based actions after route is set
  if (handleHashActions) {
    handleHashActions();
  }
};

// Expose navigation to child contexts
viewModel.mailboxView.navigate = viewModel.navigate;
viewModel.settingsModal.navigate = viewModel.navigate;
mailboxActions.setNavigate(viewModel.navigate);

viewModel.pgpPassphraseModal = passphraseApi;

// Block <input type="file"> clicks on Tauri desktop — WebKit's runOpenPanel
// delegate panics in WKWebView, crashing the app. All file picking is handled
// by the Tauri dialog plugin via pickFiles() in file-picker.ts instead.
if (isTauriDesktop) {
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target as HTMLElement;
      if (target instanceof HTMLInputElement && target.type === 'file') {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}

// Compose: Tauri desktop uses separate native windows, web/mobile uses in-app modal
if (isTauriDesktop) {
  viewModel.mailboxView.composeModal = {
    open(prefill) {
      openComposeWindow({ action: 'open', prefill });
    },
    close() {},
    async forward(prefill) {
      const selectedMessage_ = get(selectedMessage);
      let rawBody = get(messageBody) || '';
      rawBody ||= (await mailboxActions.getMessageBodyForReply(selectedMessage_ || prefill)) || '';

      rawBody ||= prefill?.body || '';
      const cleanBody = mailboxActions.stripQuoteCollapseMarkup(rawBody);
      const quotedHtml = mailboxActions.buildForwardQuotedBody(
        selectedMessage_ || { subject: prefill?.subject },
        cleanBody,
      );
      openComposeWindow({
        action: 'forward',
        prefill: {
          subject: prefill?.subject,
          html: quotedHtml,
        },
      });
    },
    async reply(prefill) {
      // Build the quoted reply body immediately since the compose window
      // is a separate Tauri webview and updateReplyBody can't reach it.
      // Try multiple sources: store → IDB cache → snippet/prefill body.
      const selected = get(selectedMessage);
      let rawBody = get(messageBody) || '';
      // Always try IDB cache if store body looks empty or is just the wrapper
      if (!rawBody || rawBody.length < 50) {
        const cached = (await mailboxActions.getMessageBodyForReply(selected || prefill)) || '';
        if (cached) {
          rawBody = cached;
        }
      }

      rawBody ||= prefill?.body || '';
      let cleanBody = mailboxActions.stripQuoteCollapseMarkup(rawBody);
      // Use snippet/textContent as final fallback
      if (!cleanBody || cleanBody.replaceAll(/<[^>]*>/g, '').trim().length < 5) {
        const message = selected || prefill;
        cleanBody = message?.snippet || message?.textContent || cleanBody || '';
      }

      const quotedHtml = mailboxActions.buildReplyQuotedBody(
        { from: prefill?.from, date: prefill?.date },
        cleanBody,
      );
      openComposeWindow({
        action: 'reply',
        prefill: {
          subject: prefill?.subject,
          from: prefill?.from,
          to: prefill?.to,
          cc: prefill?.cc,
          date: prefill?.date,
          html: quotedHtml,
          inReplyTo: prefill?.inReplyTo,
          references: prefill?.references,
        },
      });
    },
    updateReplyBody() {},
    toList() {},
    setContacts() {},
    isVisible: () => false,
  };

  // Listen for compose:sent events from compose windows.
  // The compose webview can't reliably access IDB / db worker, so it
  // relays draft + source IDs back here for the main window to clean up.
  import('@tauri-apps/api/event').then(({ listen }) => {
    listen('compose:sent', async (event) => {
      const result = event.payload as
        | {
            archive?: boolean;
            queued?: boolean;
            draftId?: string;
            serverDraftId?: string;
            sourceMessageId?: string;
            sentCopyPayload?: Record<string, unknown>;
          }
        | undefined;
      const preservedSelection = get(selectedMessage);
      const preservedSelectionId = preservedSelection?.id || null;
      const preservedFolder = preservedSelection?.folder || get(mailboxStore.state.selectedFolder);

      // Clean up local draft record (IDB)
      if (result?.draftId) {
        try {
          await deleteDraft(result.draftId);
        } catch (error) {
          console.warn('[main] Failed to delete local draft after send:', error);
        }
      }

      // Delete server-side draft and source draft message via API.
      // Use dynamic imports to avoid bloating the main bundle.
      const idsToDelete = new Set<string>();
      if (result?.sourceMessageId) {
        idsToDelete.add(result.sourceMessageId);
      }

      if (result?.serverDraftId && result.serverDraftId !== result.sourceMessageId) {
        idsToDelete.add(result.serverDraftId);
      }

      if (idsToDelete.size > 0) {
        try {
          const { Remote } = await import('./utils/remote');
          const { db } = await import('./utils/db');
          const account = (await import('./utils/storage')).Local.get('email') || 'default';
          for (const id of idsToDelete) {
            // Server delete (404 = already gone)
            try {
              await Remote.request(
                'MessageDelete',
                {},
                {
                  method: 'DELETE',
                  pathOverride: `/v1/messages/${encodeURIComponent(id)}?permanent=1`,
                },
              );
            } catch (error) {
              const status = (error as { status?: number })?.status;
              if (status !== 404) {
                console.warn('[main] Failed to delete server draft after send:', error);
              }
            }

            // Local cache delete (best effort)
            try {
              await db.messages.where('[account+id]').equals([account, id]).delete();
            } catch {
              // Ignore — main goal was server cleanup
            }
          }
        } catch (error) {
          console.warn('[main] Draft cleanup imports failed:', error);
        }
      }

      // Save sent copy — the native compose window can't access IDB so we handle it here
      if (result?.sentCopyPayload) {
        try {
          const { saveSentCopy } = await import('./utils/sent-copy.js');
          await saveSentCopy(result.sentCopyPayload);
        } catch (error) {
          console.warn('[main] Failed to save sent copy:', error);
        }

        // Set \Answered flag on the original message if this was a reply
        const origId = result.sentCopyPayload.replyToMessageId as string;
        if (origId) {
          try {
            const { Remote } = await import('./utils/remote');
            const { db } = await import('./utils/db');
            const account = (await import('./utils/storage')).Local.get('email') || 'default';
            const records = await db.messages
              .where('[account+id]')
              .equals([account, origId])
              .toArray();
            const message = records?.[0];
            if (message) {
              const flags: string[] = Array.isArray(message.flags) ? message.flags : [];
              if (!flags.includes(String.raw`\Answered`)) {
                const newFlags = [...flags, String.raw`\Answered`];
                await db.messages
                  .where('[account+id]')
                  .equals([account, origId])
                  .modify({ flags: newFlags });
                await Remote.request(
                  'MessageUpdate',
                  {
                    flags: newFlags,
                    folder:
                      (result.sentCopyPayload.replyToMessageFolder as string) || message.folder,
                  },
                  { method: 'PUT', pathOverride: `/v1/messages/${encodeURIComponent(origId)}` },
                );
              }
            }
          } catch (error) {
            console.warn(String.raw`[main] Failed to set \Answered flag:`, error);
          }
        }

        try {
          await mailboxStore.actions.refreshReplyTargets?.({ force: true });
        } catch (error) {
          console.warn('[main] Failed to refresh reply targets after send:', error);
        }
      }

      if (result?.archive) {
        const message = get(selectedMessage);
        if (message) {
          await mailboxActions.archiveMessage(message).catch(() => {});
        }

        return;
      }

      await mailboxStore.actions.loadMessages?.();
      if (preservedSelectionId && get(mailboxStore.state.selectedFolder) === preservedFolder) {
        const refreshedSelection = get(mailboxStore.state.messages).find(
          (message) => message?.id === preservedSelectionId,
        );
        if (refreshedSelection) {
          mailboxStore.actions.selectMessage?.(refreshedSelection);
        }
      }
    });
  });
} else {
  viewModel.mailboxView.composeModal = {
    open(prefill) {
      composeApi.open(prefill);
    },
    close() {
      composeApi.close();
    },
    forward(prefill) {
      composeApi.forward({
        subject: prefill?.subject,
        body: prefill?.body || get(messageBody),
      });
    },
    reply(prefill) {
      composeApi.reply({
        subject: prefill?.subject,
        from: prefill?.from,
        to: prefill?.to,
        cc: prefill?.cc,
        date: prefill?.date,
        body: prefill?.body || get(messageBody),
        bodyLoading: prefill?.bodyLoading,
        inReplyTo: prefill?.inReplyTo,
        references: prefill?.references,
      });
    },
    updateReplyBody: (body, options) => composeApi.updateReplyBody?.(body, options),
    toList(list) {
      composeApi.setToList(list);
    },
    setContacts(list) {
      composeApi.setContacts(list);
    },
    isVisible: () => composeApi.isVisible?.(),
  };
}

mailboxActions.setComposeModal(viewModel.mailboxView.composeModal);
viewModel.mailboxView.passphraseModal = viewModel.pgpPassphraseModal;
// Update Svelte compose with mailboxView ref via store
composeMailboxView.set(viewModel.mailboxView);

// Share toasts with settings
viewModel.settingsModal.toasts = viewModel.toasts;

routeStore.subscribe((route) => {
  const mailboxMode =
    route === 'mailbox' ||
    route === 'settings' ||
    route === 'profile' ||
    route === 'calendar' ||
    route === 'contacts';
  document.body.classList.toggle('mailbox-mode', mailboxMode);
  document.body.classList.toggle('settings-mode', route === 'settings');
  document.body.classList.toggle('route-mailbox', route === 'mailbox');
  if (route !== 'mailbox') {
    composeApi.close();
  }

  // Update active stores instead of using $set
  mailboxActive.set(route === 'mailbox');
  calendarActive.set(route === 'calendar');
  profileActive.set(route === 'profile');
  if (mailboxMode && _bootstrapComplete) {
    // Lazily mount Calendar and Contacts on first authenticated route.
    // They are deferred to avoid Svelte 5 runtime crashes on the login page.
    mountCalendar();
    mountContacts();
    // Start background services on first authenticated route if bootstrap
    // ran on the login page (where mailboxMode was false).  These must only
    // start once — the flag prevents duplicate timers/listeners.
    if (!_backgroundServicesStarted) {
      _backgroundServicesStarted = true;
      startAutoMetadataSync();
      initKeyboardShortcuts();
      startOutboxProcessor();
      syncPendingDrafts();
      initMutationQueue();
      globalThis.addEventListener('online', () => {
        processOutbox();
        syncPendingDrafts();
        processMutationQueue();
      });
    }

    if (starfieldDisposer) {
      starfieldDisposer();
      starfieldDisposer = null;
    }
  } else if (!mailboxMode && !starfieldDisposer) {
    // Only init starfield on non-mailbox routes (login page).
    // The extra !mailboxMode guard prevents the starfield from starting
    // when _bootstrapComplete is still false on the initial subscription
    // fire (before bootstrap runs).
    starfieldDisposer = initStarfield();
  }

  updateRouteVisibility(route);
  if (route !== 'settings') {
    viewModel.settingsModal.visible(false);
  }

  if (route === 'mailbox') {
    viewModel.mailboxView.load();
  }

  if (route === 'settings') {
    viewModel.settingsModal.open();
  }

  if (route === 'diagnostics') {
    mountDiagnostics();
  }

  if (route === 'calendar') {
    viewModel.calendarView.load();
  }

  if (route === 'contacts') {
    contactsApi.reload?.();
  }
});

function initKeyboardShortcuts() {
  const handleRouteChange = (route) => {
    updateShortcutState(route);
  };

  routeStore.subscribe(handleRouteChange);
  updateShortcutState(currentRoute());

  // Register handlers
  // Common / message-level
  keyboardShortcuts.on('new-message', () => {
    if (currentRoute() === 'mailbox') {
      composeApi.open();
    }
  });

  keyboardShortcuts.on('reply', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.replyTo(message);
    } else {
      viewModel.mailboxView.toasts?.show?.('Select a message to reply', 'info');
    }
  });

  keyboardShortcuts.on('reply-all', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.replyAll?.(message);
    } else {
      viewModel.mailboxView.toasts?.show?.('Select a message to reply all', 'info');
    }
  });

  keyboardShortcuts.on('reply-list', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.replyTo(message);
    } else {
      viewModel.mailboxView.toasts?.show?.('Select a message to reply', 'info');
    }
  });

  keyboardShortcuts.on('forward', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.forwardMessage?.(message);
    }
  });

  keyboardShortcuts.on('edit-as-new', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.toasts?.show?.('Edit as new not yet implemented', 'info');
    }
  });

  keyboardShortcuts.on('save-draft', async () => {
    if (!composeApi?.isVisible?.()) {
      viewModel.mailboxView.toasts?.show?.('Open compose to save a draft first', 'info');
      return;
    }

    try {
      await composeApi.saveDraft?.();
    } catch (error) {
      console.error('[Shortcuts] Failed to save draft', error);
      viewModel.mailboxView.toasts?.show?.('Failed to save draft', 'error');
    }
  });

  keyboardShortcuts.on('print', () => {
    try {
      globalThis.print();
    } catch {
      if (isTauri) {
        viewModel.mailboxView.toasts?.show?.(
          'Print is not supported in the desktop app. Use "View Original" to print from your browser.',
          'info',
        );
      }
    }
  });

  keyboardShortcuts.on('send-now', () => {
    viewModel.mailboxView.toasts?.show?.('Send now shortcut not yet implemented', 'info');
  });

  // Receiving / navigation
  keyboardShortcuts.on('refresh', () => {
    if (currentRoute() === 'mailbox') {
      viewModel.mailboxView.loadMessages();
    }
  });

  keyboardShortcuts.on('refresh-all', () => {
    viewModel.mailboxView.loadMessages();
  });

  keyboardShortcuts.on('expand-thread', () => {
    if (currentRoute() !== 'mailbox') {
      return;
    }

    mailboxApi?.expandSelectedThread?.();
  });
  keyboardShortcuts.on('collapse-thread', () => {
    if (currentRoute() !== 'mailbox') {
      return;
    }

    mailboxApi?.collapseSelectedThread?.();
  });

  // Managing / marking / tags
  keyboardShortcuts.on('toggle-read', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.toggleRead(message);
    }
  });

  keyboardShortcuts.on('mark-thread-read', () => {
    if (currentRoute() !== 'mailbox') {
      return;
    }

    mailboxApi?.markSelectedThreadRead?.();
  });

  keyboardShortcuts.on('mark-folder-read', () => {
    viewModel.mailboxView.toasts?.show?.('Mark folder read not yet implemented', 'info');
  });

  keyboardShortcuts.on('mark-date-read', () => {
    viewModel.mailboxView.toasts?.show?.('Mark as read by date not yet implemented', 'info');
  });

  keyboardShortcuts.on('mark-junk', () => {
    viewModel.mailboxView.toasts?.show?.('Mark as junk not yet implemented', 'info');
  });

  keyboardShortcuts.on('mark-not-junk', () => {
    viewModel.mailboxView.toasts?.show?.('Mark as not junk not yet implemented', 'info');
  });

  keyboardShortcuts.on('star', () => {
    viewModel.mailboxView.toasts?.show?.('Star not yet implemented', 'info');
  });

  keyboardShortcuts.on('archive', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (mailboxApi?.archiveSelected) {
      mailboxApi.archiveSelected();
      return;
    }

    if (message) {
      viewModel.mailboxView.archiveMessage(message);
    }
  });

  keyboardShortcuts.on('delete', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (mailboxApi?.deleteSelected) {
      mailboxApi.deleteSelected();
      return;
    }

    if (message) {
      viewModel.mailboxView.deleteMessage(message, { permanent: false });
    }
  });

  keyboardShortcuts.on('delete-permanent', () => {
    const message = get(viewModel.mailboxView.selectedMessage);
    if (message) {
      viewModel.mailboxView.deleteMessage(message, { permanent: true });
    }
  });

  keyboardShortcuts.on('next-message', () => {
    if (currentRoute() !== 'mailbox') {
      return;
    }

    mailboxApi?.selectNext?.();
  });

  keyboardShortcuts.on('previous-message', () => {
    if (currentRoute() !== 'mailbox') {
      return;
    }

    mailboxApi?.selectPrevious?.();
  });

  keyboardShortcuts.on('move-copy', () => {
    viewModel.mailboxView.toasts?.show?.('Move / copy not yet implemented', 'info');
  });

  // Search
  keyboardShortcuts.on('quick-filter', () => {
    const searchInput = document.querySelector('.fe-search');
    if (searchInput) {
      searchInput.focus();
    }
  });

  keyboardShortcuts.on('find-in-message', () => {
    const searchInput = document.querySelector('.fe-search');
    if (searchInput) {
      searchInput.focus();
    }
  });

  keyboardShortcuts.on('advanced-search', () => {
    viewModel.mailboxView.toasts?.show?.('Advanced search not yet implemented', 'info');
  });

  keyboardShortcuts.on('quick-filter-advanced', () => {
    const searchInput = document.querySelector('.fe-search');
    if (searchInput) {
      searchInput.focus();
    }
  });

  // Help
  keyboardShortcuts.on('help', () => {
    showShortcutsHelp();
  });

  keyboardShortcuts.on('redo', () => {
    viewModel.mailboxView.toasts?.show?.('Redo not yet implemented', 'info');
  });

  // Tab shortcut handlers (desktop only — shortcuts registered at module init, handlers bound here)
  if (isTauriDesktop) {
    keyboardShortcuts.on('new-tab', () => {
      const message = get(selectedMessage);
      if (message) {
        openMessageTab(message);
      }
    });

    keyboardShortcuts.on('close-tab', () => {
      closeTab(get(activeTabId));
    });

    keyboardShortcuts.on('next-tab', () => {
      const id = getNextTabId();
      if (id) {
        activateTab(id);
      }
    });

    keyboardShortcuts.on('prev-tab', () => {
      const id = getPrevTabId();
      if (id) {
        activateTab(id);
      }
    });

    for (let i = 1; i <= 9; i++) {
      keyboardShortcuts.on(`tab-${i}`, () => {
        const id = getTabIdByIndex(i - 1);
        if (id) {
          activateTab(id);
        }
      });
    }
  }
}

function showShortcutsHelp() {
  showKeyboardShortcutsHelp();

  // Show in modal (you'll need to create a modal for this)
  viewModel.mailboxView.toasts?.show?.('Press ? to see keyboard shortcuts', 'info');
}

function applyTheme(pref) {
  const theme = pref || getEffectiveSettingValue('theme') || 'system';
  const prefersDark =
    globalThis.matchMedia && globalThis.matchMedia('(prefers-color-scheme: dark)').matches;
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);

  // For shadcn compatibility, toggle 'dark' class on <html> element
  document.documentElement.classList.toggle('dark', isDark);

  // Keep legacy body classes for backward compatibility during migration
  document.body.classList.remove('light-mode', 'dark-mode');
  document.body.classList.add(isDark ? 'dark-mode' : 'light-mode');
}

/**
 * Apply font to document
 * Updates CSS variables to change font throughout app
 * @param {string} fontFamily - CSS font-family value (e.g., '"Inter Variable", system-ui, sans-serif')
 */
function applyFont(fontFamily) {
  if (!fontFamily) {
    fontFamily = 'system-ui, -apple-system, sans-serif'; // Default
  }

  // Update CSS variables on :root
  document.documentElement.style.setProperty('--brand-font', fontFamily);

  // For headings, keep serif if system, otherwise use same font
  if (fontFamily.includes('system-ui')) {
    document.documentElement.style.setProperty('--brand-heading-font', "'Georgia', serif");
  } else {
    // Use same font for headings when custom font selected
    document.documentElement.style.setProperty('--brand-heading-font', fontFamily);
  }
}

function initStarfield() {
  const layers = [
    {
      id: 'stars',
      starCount: 180,
      speed: 0.15,
      maxRadius: 1.2,
    },
    {
      id: 'stars2',
      starCount: 120,
      speed: 0.08,
      maxRadius: 1.4,
    },
    {
      id: 'stars3',
      starCount: 80,
      speed: 0.04,
      maxRadius: 1.6,
    },
  ];

  const disposers = layers.map((layer) => createStarfield(layer.id, layer));

  return () => {
    for (const dispose of disposers) {
      dispose?.();
    }
  };
}

/**
 * Check if a deployed clear-manifest.json requires this client to wipe
 * local caches and reload. Runs before any DB or store initialization.
 * This is a kill switch for bad releases — update clear_below in the
 * manifest to force all clients below that version to reset.
 */
async function checkClearManifest() {
  try {
    const res = await fetch('/clear-manifest.json', { cache: 'no-store' });
    if (!res.ok) {
      return;
    }

    const manifest = await res.json();
    if (!manifest.clear_below) {
      return;
    }

    // Compare semver portion only (strip build hash suffix like "-a1b2c3d4")
    const raw = import.meta.env.VITE_PKG_VERSION || '0.0.0';
    const parts = raw.split('.').map(Number);
    const threshold = manifest.clear_below.split('.').map(Number);
    const isBelow =
      parts[0] < threshold[0] ||
      (parts[0] === threshold[0] && parts[1] < threshold[1]) ||
      (parts[0] === threshold[0] && parts[1] === threshold[1] && parts[2] < threshold[2]);
    if (!isBelow) {
      return;
    }

    console.warn(
      '[clear-manifest] Client version %s is below %s — clearing site data',
      raw,
      manifest.clear_below,
    );

    // Nuke IndexedDB
    if (typeof indexedDB.databases === 'function') {
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map((db) => indexedDB.deleteDatabase(db.name)));
    } else {
      // Safari fallback — delete known DB name
      const { DB_NAME } = await import('./utils/db-constants');
      indexedDB.deleteDatabase(DB_NAME);
    }

    // Nuke SW caches and unregister service worker
    const cacheKeys = await caches.keys();
    await Promise.all(cacheKeys.map(async (k) => caches.delete(k)));
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
    }

    // Clear web storage
    localStorage.clear();
    sessionStorage.clear();

    // Reload — fresh assets will have the current version, so this won't loop
    globalThis.location.reload();
  } catch {
    // Manifest fetch failed or parse error — continue normally
  }
}

// ── App Lock helpers (used by bootstrap and exported for Settings) ──

/**
 * Show the lock screen overlay and wait for the user to unlock.
 * Returns a promise that resolves when unlock succeeds.
 * Guarded against concurrent calls — if a lock screen is already showing,
 * returns the existing promise instead of mounting a second component.
 */
let _lockScreenPromise: Promise<void> | undefined = null;
async function showLockScreen(): Promise<void> {
  if (_lockScreenPromise) {
    return _lockScreenPromise;
  }

  _lockScreenPromise = new Promise((resolve) => {
    const lockOverlay = document.querySelector('#app-lock-overlay');
    if (!lockOverlay) {
      _lockScreenPromise = null;
      resolve();
      return;
    }

    lockOverlay.style.display = 'block';
    import('svelte').then(({ mount, unmount }) => {
      import('./svelte/LockScreen.svelte').then(({ default: LockScreen }) => {
        const comp = mount(LockScreen, { target: lockOverlay });
        lockOverlay.addEventListener(
          'unlock',
          () => {
            unmount(comp);
            lockOverlay.style.display = 'none';
            _lockScreenPromise = null;
            resolve();
          },
          { once: true },
        );
      });
    });
  });
  return _lockScreenPromise;
}

/**
 * Start the inactivity timer that re-locks the app.
 * Safe to call multiple times — restarts the timer each time.
 * Exported so AppLockSettings can start it when the user first enables lock.
 */
export function startAppLockTimer() {
  startInactivityTimer(() => {
    lockCryptoStore();
    pauseInactivityTimer();
    showLockScreen().then(() => {
      resumeInactivityTimer();
    });
  });
}

async function bootstrap() {
  const root = document.querySelector('#rl-app');
  if (!root) {
    return;
  }

  // Check if this client needs a forced reset before any initialization
  await checkClearManifest();

  // Mark as ready early to avoid blank screen if async init stalls.
  root.classList.add('ready');

  try {
    // In development, aggressively cleanup any stale workers/service workers
    // This prevents old code from holding stale database connections
    // which causes version mismatches when code changes during HMR
    if (import.meta.env.DEV) {
      // Terminate web workers (sync, search, db)
      try {
        terminateSyncWorker();
        searchStore.actions.terminateWorker();
        terminateDbWorker();
      } catch {
        // Ignore errors if workers don't exist yet
      }

      // Unregister any service workers (they shouldn't exist in dev mode,
      // but might be stale from when PWA was enabled)
      if ('serviceWorker' in navigator) {
        try {
          const registrations = await navigator.serviceWorker.getRegistrations();
          if (registrations.length > 0) {
            await Promise.all(registrations.map(async (reg) => reg.unregister()));
          }
        } catch {
          // ignore service worker cleanup failures in dev
        }
      }

      // Brief delay to ensure workers are fully terminated before database init
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    markBootstrapReady();

    // Signal to fallback recovery UI that the app has bootstrapped successfully
    if (typeof globalThis.__markAppBootstrapped === 'function') {
      globalThis.__markAppBootstrapped();
    }

    // Initialize i18n first
    await i18n.init();
    initPerfObservers();

    // Eagerly load libsodium on Tauri to avoid first-use latency
    if (globalThis.__TAURI_INTERNALS__) {
      import('./utils/crypto-store.js').then((m) => m.getSodium()).catch(() => {});
    }

    // Initialize database with recovery callbacks
    // This happens early to ensure the database is ready before any stores try to use it

    // Set up worker termination callback for database recovery
    // This ensures all workers are terminated before database deletion to prevent blocked connections
    setTerminateWorkersCallback(() => {
      terminateSyncWorker();
      searchStore.actions.terminateWorker();
      terminateDbWorker();
    });

    setRecoveryCallbacks({
      onRecoveryStart(error) {
        console.warn('[DB] Database recovery started due to:', error?.message);
        // Show a non-dismissible toast during recovery
        toasts?.show?.('Updating local database...', 'info', 0);
      },
      onRecoveryComplete() {
        // Dismiss the recovery toast and show success
        toasts?.dismiss?.();
        toasts?.show?.('Local database updated successfully', 'success');
      },
      onRecoveryFailed(error) {
        console.error('[DB] Database recovery failed:', error?.message);
        toasts?.dismiss?.();
        toasts?.show?.('Local database is stuck. Click to reset and reload.', 'error', 0, {
          label: 'Reset and reload',
          callback: async () => {
            try {
              const regs = await navigator.serviceWorker?.getRegistrations?.();
              if (Array.isArray(regs)) {
                await Promise.all(regs.map((r) => r.unregister().catch(() => false)));
              }
            } catch {
              /* best-effort — proceed to reload regardless */
            }
            window.location.reload();
          },
        });
      },
    });

    // Initialize database with automatic recovery
    const dbResult = await initializeDatabase();
    if (!dbResult.success) {
      console.error('[DB] Database initialization failed:', dbResult.error);
      // Show a persistent error toast
      toasts?.show?.(
        'Local storage unavailable. Some features may not work offline.',
        'warning',
        10_000,
      );
    } else if (dbResult.recovered) {
      // Database was recovered - user's cached data was cleared
      toasts?.show?.(
        'Local cache was cleared to fix a storage issue. Your data will sync from the server.',
        'info',
        8000,
      );
    }

    if (dbResult.success) {
      reconcileOrphanedAccountData().catch((error) => {
        console.warn('[DB] Account reconciliation failed:', error);
      });

      // Backwards-compatible fix: if the user is stuck with both a demo
      // account and a real account in the Accounts list, silently remove
      // the demo account and deactivate demo mode so the real account
      // takes over cleanly.
      try {
        const { isDemoMode, cleanupDemoAccount } = await import('./utils/demo-mode.js');
        const { DEMO_EMAIL } = await import('./utils/demo-data.js');
        const allAccounts = Accounts.getAll();
        const hasDemoAccount = allAccounts.some((a) => a.email === DEMO_EMAIL);
        const hasRealAccount = allAccounts.some((a) => a.email !== DEMO_EMAIL);
        if ((hasDemoAccount && hasRealAccount) || (hasDemoAccount && !isDemoMode())) {
          console.info('[bootstrap] Cleaning up stale demo account');
          await cleanupDemoAccount({ preserveCredentials: true });
          // If a real account exists, make sure it is the active one
          const remaining = Accounts.getAll();
          if (remaining.length > 0 && Accounts.getActive() === DEMO_EMAIL) {
            Accounts.setActive(remaining[0].email);
          }
        }
      } catch (error) {
        console.warn('[bootstrap] Demo cleanup failed:', error);
      }
    }

    let route = currentRoute();
    const parameters = new URLSearchParams(globalThis.location.search);
    const isAddingAccount = parameters.get('add_account') === 'true';

    // Check auth before showing anything
    if (
      (route === 'mailbox' ||
        route === 'settings' ||
        route === 'profile' ||
        route === 'calendar' ||
        route === 'contacts') &&
      !Local.get('authToken') &&
      !Local.get('alias_auth')
    ) {
      // Use navigate instead of full page reload to prevent flicker
      routeStore.set('login');
      history.replaceState({ route: 'login' }, '', '/');
      route = 'login';
    } else if (route === 'mailbox' && globalThis.location.pathname === '/' && !isAddingAccount) {
      // Update URL to /mailbox when user is authenticated and on root path
      // But skip this if we're adding an account
      // Preserve any hash that may have been set by the Mailbox component's
      // initial folder setup (e.g., #INBOX) during the async bootstrap gap.
      const currentHash = globalThis.location.hash || '';
      // Merge with existing state to preserve folder info set by Mailbox component
      const existingState = history.state || {};
      history.replaceState({ ...existingState, route: 'mailbox' }, '', '/mailbox' + currentHash);
    }

    // Handle ?email= query parameter for account switching
    const emailParameter = parameters.get('email');
    if (emailParameter && route !== 'login') {
      const allAccounts = Accounts.getAll();
      const activeEmail = Accounts.getActive();
      const normalizedEmail = emailParameter.trim().toLowerCase();
      const matchedAccount = allAccounts.find((a) => a.email.toLowerCase() === normalizedEmail);

      if (matchedAccount) {
        // Already logged in with this account — switch to it if not already active
        if (activeEmail?.toLowerCase() !== normalizedEmail) {
          mailboxActions.switchAccount(normalizedEmail);
        }

        // Clean up URL — remove query params, go to /mailbox
        history.replaceState({ route: 'mailbox' }, '', '/mailbox');
        route = 'mailbox';
        routeStore.set('mailbox');
      } else {
        // Not logged in with this account — go to add-account login with email prefilled
        history.replaceState(
          { route: 'login' },
          '',
          `/?add_account=true&email=${encodeURIComponent(emailParameter)}`,
        );
        route = 'login';
        routeStore.set('login');
        globalThis.dispatchEvent(
          new CustomEvent('login-prefill-email', { detail: emailParameter }),
        );
      }
    }

    const mailboxMode =
      route === 'mailbox' ||
      route === 'settings' ||
      route === 'profile' ||
      route === 'calendar' ||
      route === 'contacts';
    document.body.classList.toggle('mailbox-mode', mailboxMode);
    updateRouteVisibility(route);

    // ── App Lock: show lock screen if enabled and vault is locked ──
    // Skip if the user already unlocked in this tab session (survives page
    // reloads within the same tab but not new tabs or tab close).  The DEK
    // is lost on reload but the session flag lets us silently re-prompt via
    // the inactivity timer path rather than blocking the UI on every navigation.
    if (isLockEnabled() && isVaultConfigured() && !isUnlocked() && !wasUnlockedThisSession()) {
      pauseInactivityTimer(); // Prevent timer from firing while lock screen is showing
      await showLockScreen();
      // OpenVault() already calls restoreSessionCredentials() after
      // successful unlock, so credentials are ready now.
    } else if (isLockEnabled() && isVaultConfigured() && wasUnlockedThisSession()) {
      // Session was previously unlocked but DEK is gone (page reload).
      // sessionStorage should still have plaintext credentials from the
      // prior unlock, but if they were lost ensure they're available.
      restoreSessionCredentials();
    } else if (!isLockEnabled()) {
      // No app lock — credentials are stored as plaintext in localStorage.
      // Ensure sessionStorage has a copy of each tab-scoped key.  The browser
      // can clear sessionStorage under memory pressure or after a crash,
      // leaving Local.get() with no session copy and causing silent 401s.
      const tabKeys = ['alias_auth', 'api_key', 'authToken', 'email'];
      for (const key of tabKeys) {
        const prefixed = `webmail_${key}`;
        try {
          if (sessionStorage.getItem(prefixed) === null) {
            const lv = localStorage.getItem(prefixed);
            if (lv) {
              sessionStorage.setItem(prefixed, lv);
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // Signal that auth credentials are available and components can
    // safely issue API requests.
    markAppReady();

    // Start inactivity timer if app lock is enabled (re-locks after idle)
    if (isLockEnabled() && isVaultConfigured()) {
      startAppLockTimer();
    }

    viewModel.settingsModal.applyTheme = applyTheme;
    viewModel.settingsModal.applyFont = applyFont;
    themeUnsub?.();
    themeUnsub = effectiveTheme.subscribe((value) => {
      applyTheme(value || 'system');
    });

    // Listen for OS-level light/dark mode changes so the app reacts
    // immediately when the system theme switches (e.g. macOS auto
    // appearance schedule).  Without this listener, applyTheme only
    // runs when the user-facing setting store changes.
    if (systemThemeMediaQuery) {
      systemThemeMediaQuery.removeEventListener('change', applyTheme);
    }

    if (globalThis.matchMedia) {
      systemThemeMediaQuery = globalThis.matchMedia('(prefers-color-scheme: dark)');
      systemThemeMediaQuery.addEventListener('change', () => {
        applyTheme();
      });
    }

    // Apply saved font preference
    const currentAcct = Local.get('email') || 'default';
    const savedFont = getEffectiveSettingValue('font', { account: currentAcct });
    if (savedFont && savedFont !== 'system') {
      // Import and apply font loader
      import('./utils/font-loader.js')
        .then(({ loadFont }) => {
          loadFont(savedFont)
            .then(applyFont)
            .catch((error) => {
              console.warn('[bootstrap] Failed to load saved font:', error);
            });
        })
        .catch((error) => {
          console.warn('[bootstrap] Failed to import font-loader:', error);
        });
    }

    // Svelte compose handles its own editor initialization
    if (route === 'mailbox') {
      viewModel.mailboxView.load();
    }

    if (route === 'settings') {
      viewModel.settingsModal.open();
    }

    if (route === 'calendar') {
      viewModel.calendarView.load();
    }

    if (route === 'contacts') {
      contactsApi.reload?.();
    }

    // Mark bootstrap complete so routeStore.subscribe can mount components
    // on subsequent route changes (e.g. navigating to calendar/contacts).
    _bootstrapComplete = true;

    // Mount Calendar and Contacts lazily on first authenticated route
    if (mailboxMode) {
      mountCalendar();
      mountContacts();
      // Dispose starfield if it was started (e.g. from the initial
      // routeStore.subscribe fire before _bootstrapComplete was set).
      if (starfieldDisposer) {
        starfieldDisposer();
        starfieldDisposer = null;
      }
    }

    if (!starfieldDisposer && !mailboxMode) {
      starfieldDisposer = initStarfield();
    }

    // Initialize verified network status (replaces unreliable navigator.onLine)
    // This runs regardless of route so the offline banner works everywhere.
    initNetworkStatus();

    // Start background services when the user is authenticated and on a
    // mailbox-related route.  Running these on the login page causes console
    // errors because auth headers are missing.  The _backgroundServicesStarted
    // flag ensures they only start once; if bootstrap runs on the login page
    // the routeStore.subscribe handler will start them on the first
    // post-login route change instead.
    if (mailboxMode && !_backgroundServicesStarted) {
      _backgroundServicesStarted = true;
      startAutoMetadataSync();
      initKeyboardShortcuts();

      // Start outbox processor for offline email queue with retry
      startOutboxProcessor();
      syncPendingDrafts();
      initMutationQueue();

      globalThis.addEventListener('online', () => {
        processOutbox(); // New outbox service
        syncPendingDrafts();
        processMutationQueue();
      });
    }

    // ── Auth failure handling ─────────────────────────────────────────
    // fe:auth-failed  — WebSocket auth failure (close code 4401/4403)
    // fe:auth-expired — consecutive HTTP 401s detected by Remote.request()
    //
    // Both events trigger the same recovery: clear stale credentials,
    // stop background services, and redirect to login so the user can
    // re-authenticate.  A guard prevents double-firing within 5 seconds.
    let _authRecoveryInProgress = false;

    const handleAuthRecovery = (reason) => {
      if (_authRecoveryInProgress) {
        return;
      }

      _authRecoveryInProgress = true;

      console.warn(`[auth] Forced re-auth triggered (${reason})`);
      toasts?.show?.('Session expired. Redirecting to login\u2026', 'error', 4000);

      // Clear stale credentials so the auth guard redirects to login
      Local.remove('alias_auth');
      Local.remove('api_key');
      Local.remove('authToken');
      // Clear session-scoped copies too
      try {
        sessionStorage.removeItem('webmail_alias_auth');
        sessionStorage.removeItem('webmail_api_key');
        sessionStorage.removeItem('webmail_authToken');
      } catch {
        // ignore
      }

      // Short delay so the toast is visible before navigation
      setTimeout(() => {
        // SPA navigation to login — avoids full page reload
        history.replaceState({ route: 'login' }, '', '/');
        routeStore.set('login');
        updateRouteVisibility('login');
        document.body.classList.remove('mailbox-mode');
        // Dispatch event for Login component to clear fields
        globalThis.dispatchEvent(new CustomEvent('login-clear-fields'));
        _authRecoveryInProgress = false;
      }, 1500);
    };

    globalThis.addEventListener('fe:auth-failed', () => {
      handleAuthRecovery('websocket');
    });
    globalThis.addEventListener('fe:auth-expired', () => {
      handleAuthRecovery('http-401');
    });

    // Register deep-link and single-instance event handlers BEFORE
    // initTauriBridge() so they are ready when pending cold-start URLs
    // are drained.  The tauri-bridge dispatches 'app:deep-link' and
    // 'app:single-instance' CustomEvents on window.
    globalThis.addEventListener('app:deep-link', (event: Event) => {
      const url = (event as CustomEvent)?.detail?.url;
      if (!url || typeof url !== 'string') {
        return;
      }

      const trimmed = url.trim();

      // Handle mailto: deep links → open Compose with prefilled fields
      if (trimmed.toLowerCase().startsWith('mailto:')) {
        const parsed = parseMailto(trimmed);
        if (viewModel?.mailboxView?.composeModal?.open) {
          viewModel.mailboxView.composeModal.open(mailtoToPrefill(parsed));
        }

        return;
      }

      // Handle forwardemail:// deep links → navigate to the path
      if (trimmed.toLowerCase().startsWith('forwardemail://')) {
        const path = trimmed.replace(/^forwardemail:\/\//i, '/');
        if (viewModel?.navigate && /^\/[a-z]/.test(path)) {
          viewModel.navigate(path);
        }
      }
    });

    // Handle single-instance events (second app launch with mailto: arg)
    // When the user clicks a mailto: link while the app is already running,
    // Tauri sends the URL via the single-instance plugin.
    globalThis.addEventListener('app:single-instance', (event: Event) => {
      const args = (event as CustomEvent)?.detail?.args;
      if (!Array.isArray(args)) {
        return;
      }

      for (const arg of args) {
        if (typeof arg === 'string' && arg.toLowerCase().startsWith('mailto:')) {
          const parsed = parseMailto(arg);
          if (viewModel?.mailboxView?.composeModal?.open) {
            viewModel.mailboxView.composeModal.open(mailtoToPrefill(parsed));
          }

          break;
        }
      }
    });

    // Tauri-specific native integrations (desktop + mobile)
    if (isTauri) {
      import('./utils/tauri-bridge.js').then(({ initTauriBridge, onShareReceived }) => {
        initTauriBridge();
        // Handle Android share intents → open Compose with shared content
        onShareReceived((data: { subject: string; text: string }) => {
          if (viewModel?.mailboxView?.composeModal?.open) {
            viewModel.mailboxView.composeModal.open({
              subject: data.subject,
              body: data.text,
              text: data.text,
            });
          }
        });
      });
      import('./utils/updater-bridge.js').then(({ initAutoUpdater, handleWsNewRelease }) => {
        initAutoUpdater();
        // Route fe:new-release events from the releaseWatcher to the Tauri updater
        _handleNewReleaseTauri = (event: Event) => {
          handleWsNewRelease((event as CustomEvent)?.detail);
        };

        globalThis.addEventListener('fe:new-release', _handleNewReleaseTauri);
      });
      import('./utils/notification-bridge.js').then(
        ({ initNotificationChannels, initTauriNotificationClickHandler }) => {
          initNotificationChannels();
          initTauriNotificationClickHandler();
        },
      );
      // Initialize background service for app lifecycle management (tray keep-alive,
      // foreground/background detection, push token management)
      import('./utils/background-service.js').then(({ initBackgroundService, onResume }) => {
        initBackgroundService();
        // On mobile, sync and process queued mutations when the app resumes
        if (isTauriMobile) {
          onResume(() => {
            processMutationQueue();
            import('./utils/sync-controller.js').then(({ resumeSync }) => resumeSync());
            globalThis.dispatchEvent(new CustomEvent('fe:force-reconnect'));
          });
        }
      });
      // Initialize push notifications on mobile (APNs, FCM, UnifiedPush fallback)
      import('./utils/push-notifications.js').then(({ initPushNotifications }) => {
        const authToken = Local.get('authToken') || Local.get('api_key') || '';
        if (authToken) {
          initPushNotifications({ authToken }).catch((error) => {
            console.warn('[main] Push notification init failed:', error);
          });
        }
      });
    }

    if (canUseServiceWorker() && import.meta.env.PROD) {
      // Register after page load to avoid competing with critical resources.
      // If the load event already fired (bootstrap is async and may finish
      // after load), register immediately.
      if (document.readyState === 'complete') {
        registerServiceWorker();
      } else {
        window.addEventListener('load', () => {
          registerServiceWorker();
        });
      }
    }

    // Web auto-updater: check GitHub releases + listen for newRelease WebSocket events
    //
    // All update channels (WS, GitHub poll, SW detection, visibility, manual)
    // funnel through a single performAppUpdate() to guarantee:
    //   - Dedup: only one reload can happen at a time
    //   - Draft-safe: saves any in-progress compose before reloading
    //   - Toast + push notification: always shown before reload
    //   - SW cache flush: triggers registration.update() + SKIP_WAITING
    if (!isTauri && import.meta.env.PROD) {
      let _updateInProgress = false;

      /**
       * Centralized update handler.  Every detection channel calls this.
       * Saves draft → shows toast → sends push notification → flushes SW → reloads.
       */
      async function performAppUpdate(version?: string) {
        if (_updateInProgress) {
          return;
        }

        _updateInProgress = true;

        const label = version ? `v${version}` : 'latest';
        console.info(`[update] Performing app update to ${label}`);

        // 1. Save draft if the composer has unsaved content
        try {
          if (composeApi?.isVisible?.()) {
            console.info('[update] Saving draft before reload');
            await composeApi.saveDraft?.();
          }
        } catch (error) {
          console.warn('[update] Failed to save draft before reload:', error);
        }

        // 2. Show toast so the user knows what's happening
        try {
          toasts?.show?.(`Updating to ${label}…`, 'info', 0);
        } catch {
          // Toast system may not be ready
        }

        // 3. Send push notification so the user sees it even if the tab is in the background
        try {
          const { notify } = await import('./utils/notification-bridge.js');
          await notify({
            title: 'Forward Email Updated',
            body: `App updated to ${label}. Reloading…`,
            tag: 'app-update',
          });
        } catch {
          // Notification permission may not be granted — that's fine
        }

        // 4. Trigger SW update so the new precache manifest is fetched
        try {
          const reg = globalThis.__swRegistration;
          if (reg) {
            await reg.update().catch(() => {});
            // If a new SW is waiting, tell it to activate
            if (reg.waiting) {
              reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              // Give the SW a moment to activate before reload
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        } catch {
          // SW may not be available
        }

        // 5. Store the new version so we recognise it after reload
        if (version) {
          try {
            localStorage.setItem('webmail_current_version', version);
          } catch {
            // ignore
          }
        }

        // 6. Reload after a short delay so the toast is visible
        setTimeout(() => {
          globalThis.location.reload();
        }, 1200);
      }

      // Expose globally so registerServiceWorker() and Settings can use it
      globalThis.__performAppUpdate = performAppUpdate;

      import('./utils/web-updater.js').then(
        ({ start: startWebUpdater, handleWsNewRelease, checkNow }) => {
          startWebUpdater({
            onUpdateAvailable(info) {
              performAppUpdate(info?.newVersion);
            },
          });

          // Expose checkNow globally so Settings can call it
          globalThis.__checkForWebUpdates = checkNow;

          // Route fe:new-release events from the releaseWatcher to the web updater
          _handleNewReleaseWeb = (event: Event) => {
            handleWsNewRelease((event as CustomEvent)?.detail);
          };

          globalThis.addEventListener('fe:new-release', _handleNewReleaseWeb);
        },
      );
    }

    // NOTE: We intentionally do NOT auto-register as the browser's mailto:
    // handler here.  Chromium checks its internal protocol handler BEFORE
    // the OS default, so auto-registering the web app would prevent the
    // desktop app from ever receiving mailto: links from the browser.
    // Instead, the user explicitly opts in via Settings > Default Email App
    // or the one-time MailtoPrompt banner.  See mailto-handler.js.

    // Deep-link and single-instance listeners are registered earlier
    // (before initTauriBridge) so they are ready for cold-start URLs.
  } catch (error) {
    console.error('[main] bootstrap failed', error);

    // Show the fallback recovery UI so user can clear cache and reload
    const fallback = document.querySelector('#fe-fallback-recovery');
    if (fallback) {
      fallback.style.display = 'block';
    }

    // Track the error
    if (globalThis.gtag) {
      globalThis.gtag('event', 'exception', {
        description: `Bootstrap failed: ${error?.message || 'unknown'}`,
        fatal: true,
      });
    }
  }
}

// Handle database error messages from service worker or sync-shim
function setupServiceWorkerDbErrorHandler() {
  // Shared handler for dbError messages from any sync back-end
  const handleDbError = async (data) => {
    if (data?.type !== 'dbError') {
      return;
    }

    console.error('[Sync -> Main] Database error:', data);

    // If the error is recoverable, attempt recovery
    if (data.recoverable) {
      const error = new Error(data.error);
      error.name = data.errorName;

      toasts?.show?.('Fixing local storage issue...', 'info', 0);

      const result = await attemptRecovery(error);
      toasts?.dismiss?.();

      if (result.recovered) {
        toasts?.show?.('Local storage fixed. Refreshing...', 'success');
        // Reload the page to reinitialize everything with the fresh database
        setTimeout(() => {
          globalThis.location.reload();
        }, 1500);
      } else {
        toasts?.show?.(
          'Could not fix storage issue. Try clearing browser data in Settings.',
          'error',
          10_000,
        );
      }
    } else {
      toasts?.show?.('Local storage error. Some features may not work.', 'warning');
    }
  };

  // Listen from service worker (web)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', async (event) => {
      handleDbError(event.data);
    });
  }

  // Listen from sync-shim (Tauri desktop / mobile)
  globalThis.addEventListener('sync-shim-message', (event) => {
    handleDbError((event as CustomEvent).detail);
  });
}

function getServiceWorkerUrl() {
  let baseUrl = import.meta.env.BASE_URL || '/';
  if (!baseUrl.endsWith('/')) {
    baseUrl += '/';
  }

  return new URL('sw.js', `${globalThis.location.origin}${baseUrl}`).toString();
}

// Service worker registration
async function registerServiceWorker() {
  // Set up database error handler first
  setupServiceWorkerDbErrorHandler();

  try {
    const swUrl = getServiceWorkerUrl();

    const registration = await navigator.serviceWorker.register(swUrl, {
      updateViaCache: 'none', // Always check for updates
    });

    // Expose registration globally for cache clearing
    globalThis.__swRegistration = registration;

    // Detect when a new SW is installed and trigger the centralized update handler.
    // This covers the case where a deploy pushes new assets and the SW precache
    // manifest changes — workbox detects the diff and installs a new SW.
    registration.addEventListener('updatefound', () => {
      const newWorker = registration.installing;
      if (!newWorker) {
        return;
      }

      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // New SW installed while an existing one controls the page.
          // Tell it to activate immediately; controllerchange will handle reload.
          console.info('[SW] New service worker installed, activating');
          newWorker.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });

    // Auto-reload when a new SW takes control (covers skipWaiting activation).
    // Only reload if there was already a controller — avoids reloading on first
    // SW installation when the page had no controller yet.
    // Funnels through performAppUpdate() for draft-save, toast, and push notification.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) {
        return;
      }

      // Use the centralized handler if available, otherwise fall back to raw reload
      if (typeof globalThis.__performAppUpdate === 'function') {
        globalThis.__performAppUpdate();
      } else {
        globalThis.location.reload();
      }
    });

    // Periodically check for SW updates so long-lived tabs pick up new releases.
    // Check every 60s for the first 5 minutes (fast catch-up after deploy),
    // then every 15 minutes thereafter.
    let swCheckCount = 0;
    const swUpdateInterval = setInterval(() => {
      registration.update().catch(() => {});
      swCheckCount++;
      if (swCheckCount >= 5) {
        clearInterval(swUpdateInterval);
        setInterval(
          () => {
            registration.update().catch(() => {});
          },
          15 * 60 * 1000,
        );
      }
    }, 60 * 1000);
  } catch (error) {
    // SW registration failed - app works fine without it
    console.warn('[SW] Service worker registration failed:', error.message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}

globalThis.addEventListener('popstate', () => {
  const route = detectRoute();
  const hasAuth = Boolean(Local.get('authToken') || Local.get('alias_auth'));
  const isProtected =
    route === 'mailbox' ||
    route === 'settings' ||
    route === 'profile' ||
    route === 'calendar' ||
    route === 'contacts';

  if (isProtected && !hasAuth) {
    // User pressed back into a protected route after signing out — redirect to login
    history.replaceState({ route: 'login' }, '', '/');
    routeStore.set('login');
    return;
  }

  if (route === 'login' && hasAuth) {
    // User pressed back into login while still authenticated — redirect to mailbox
    history.replaceState({ route: 'mailbox' }, '', '/mailbox');
    routeStore.set('mailbox');
    return;
  }

  // Only update the route store if the route actually changed.
  // For same-route popstate events (e.g., folder hash changes within /mailbox),
  // skip the set to avoid re-triggering load() and other side effects.
  if (route !== currentRoute()) {
    routeStore.set(route);
  }
});

// Handle hash-based deep links (e.g., /mailbox#compose=user@example.com or /mailbox#INBOX/12345)
handleHashActions = function () {
  const hash = globalThis.location.hash || '';
  // ── mailto: handler deep-link ──────────────────────────────────────────
  // The mailto-handler.js registers: {origin}/#compose?mailto=%s
  // Browsers replace %s with the percent-encoded mailto: URI, producing
  // hashes like: #compose?mailto=mailto%3Auser%40example.com%3Fsubject%3DHello
  // Handle this format FIRST because it would otherwise fall through the
  // #compose= / #mailto= checks (the fourth character is '?' not '=').
  if (hash.startsWith('#compose?mailto=')) {
    const raw = hash.slice('#compose?mailto='.length);
    // The browser percent-encodes the entire mailto: URI when substituting
    // %s, so a single decodeURIComponent recovers the original RFC 6068 URL.
    const mailtoUrl = decodeURIComponent(raw).trim();
    if (mailtoUrl) {
      const current = currentRoute();
      if (current !== 'mailbox') {
        routeStore.set('mailbox');
      }

      setTimeout(() => {
        const parsed = parseMailto(mailtoUrl);
        viewModel.mailboxView.composeModal.open(mailtoToPrefill(parsed));
      }, 0);
    }

    history.replaceState({ route: currentRoute() }, '', globalThis.location.pathname);
  } else if (hash.startsWith('#compose=') || hash.startsWith('#mailto=')) {
    const rawValue = hash.startsWith('#compose=')
      ? decodeURIComponent(hash.replace('#compose=', ''))
      : decodeURIComponent(hash.replace('#mailto=', ''));
    const value = (rawValue || '').trim();
    if (value) {
      const current = currentRoute();
      if (current !== 'mailbox') {
        routeStore.set('mailbox');
      }

      setTimeout(() => {
        const isMailto =
          value.toLowerCase().startsWith('mailto:') ||
          value.includes('?') ||
          hash.startsWith('#mailto=');
        if (isMailto) {
          const parsed = parseMailto(value);
          viewModel.mailboxView.composeModal.open(mailtoToPrefill(parsed));
        } else {
          viewModel.mailboxView.composeModal.open();
          viewModel.mailboxView.composeModal.toList([value]);
        }
      }, 0);
    }

    // Clear hash to avoid repeat
    history.replaceState({ route: currentRoute() }, '', globalThis.location.pathname);
  } else if (hash.startsWith('#addevent=')) {
    const addr = decodeURIComponent(hash.replace('#addevent=', ''));
    // Only set route if not already on calendar
    const current = currentRoute();
    if (current !== 'calendar') {
      routeStore.set('calendar');
    }

    // Use setTimeout to ensure the route and calendar are ready
    setTimeout(() => {
      if (viewModel.calendarView.prefillQuickEvent) {
        viewModel.calendarView.prefillQuickEvent(addr);
      }
    }, 0);
    // Clear hash to avoid repeat
    history.replaceState({ route: currentRoute() }, '', globalThis.location.pathname);
  } else if (hash.startsWith('#search=')) {
    const term = decodeURIComponent(hash.replace('#search=', ''));
    // Only set route if not already on mailbox
    const current = currentRoute();
    if (current !== 'mailbox') {
      routeStore.set('mailbox');
    }

    setTimeout(() => {
      if (typeof viewModel.mailboxView.onSearch === 'function') {
        viewModel.mailboxView.onSearch(term);
        viewModel.mailboxView.page?.(1);
        viewModel.mailboxView.loadMessages?.();
      }
    }, 0);
    // Clear hash to avoid repeat
    history.replaceState({ route: currentRoute() }, '', globalThis.location.pathname);
  } else if (hash.length > 1 && hash.includes('/')) {
    // Message deep link: #FOLDER/MESSAGE_ID (e.g., #INBOX/12345)
    // This is handled by Mailbox.svelte's onMount, just ensure we're on mailbox route
    const current = currentRoute();
    if (current !== 'mailbox') {
      routeStore.set('mailbox');
    }
    // Don't clear hash for message links - Mailbox.svelte will handle navigation
  }
};

globalThis.addEventListener('hashchange', handleHashActions);
handleHashActions();

function getPrefetchFolders() {
  const account = Local.get('email') || 'default';
  const extra = getEffectiveSettingValue('prefetch_folders', { account });
  const list = Array.isArray(extra) ? extra : [];
  const folders = ['INBOX', ...list];
  return [...new Set(folders.filter(Boolean))];
}

async function runMetadataSync() {
  const folders = getPrefetchFolders();
  for (const folder of folders) {
    try {
      await sendSyncTask({
        type: 'metadata',
        folder,
        account: Local.get('email'),
        pageSize: 200,
      });
    } catch {
      // ignore metadata sync failures
    }
  }
}

function startAutoMetadataSync() {
  if (autoSyncTimer) {
    clearInterval(autoSyncTimer);
  }

  if (get(mailboxActions.initialSyncStarted)) {
    return;
  }

  // Disabled automatic interval sync - only sync on startup and manual refresh
  // autoSyncTimer = setInterval(() => {
  //   if (currentRoute() === 'mailbox') {
  //     runMetadataSync('interval');
  //   }
  // }, AUTO_SYNC_INTERVAL);

  if (currentRoute() === 'mailbox') {
    runMetadataSync('startup');
  }
}
