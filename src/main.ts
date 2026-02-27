import * as mailboxActions from './stores/mailboxActions';
import { createStarfield } from './utils/starfield';
import { Local, Accounts, reconcileOrphanedAccountData } from './utils/storage';
import { keyboardShortcuts, showKeyboardShortcutsHelp } from './utils/keyboard-shortcuts';
import { i18n } from './utils/i18n';
import { createToastHost } from './svelte/toastsHost';
import Login from './svelte/Login.svelte';
import Settings from './svelte/Settings.svelte';
import Passphrase from './svelte/PassphraseModal.svelte';
import Mailbox from './svelte/Mailbox.svelte';
import Profile from './svelte/Profile.svelte';
import { mailService } from './stores/mailService';
import { mailboxStore } from './stores/mailboxStore';
import { effectiveTheme, getEffectiveSettingValue } from './stores/settingsStore';
import { writable, get } from 'svelte/store';
import { mount } from 'svelte';
// Design system styles - base reset first, then tokens, components, pages, then main
import './styles/base.css';
import './styles/tokens.css';
import './styles/components/index.css';
import './styles/pages/index.css';
import './styles/main.css';

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
document.head.appendChild(style);

// Initialize error logger for feedback system
import './utils/error-logger';

import { sendSyncTask, terminateSyncWorker } from './utils/sync-worker-client.js';
import { canUseServiceWorker, isTauri } from './utils/platform.js';
import {
  isLockEnabled,
  isUnlocked,
  isVaultConfigured,
  lock as lockCryptoStore,
} from './utils/crypto-store.js';
import {
  start as startInactivityTimer,
  pause as pauseInactivityTimer,
  resume as resumeInactivityTimer,
} from './utils/inactivity-timer.js';
import { startOutboxProcessor, processOutbox } from './utils/outbox-service';
import { initMutationQueue, processMutationQueue } from './utils/mutation-queue';
import { syncPendingDrafts } from './utils/draft-service';
import { setIndexToasts, searchStore } from './stores/searchStore';
import { setDemoToasts } from './utils/demo-mode';
// Database initialization with recovery support
import {
  initializeDatabase,
  setRecoveryCallbacks,
  setTerminateWorkersCallback,
  terminateDbWorker,
} from './utils/db';
import { markBootstrapReady } from './utils/bootstrap-ready.js';
import { initPerfObservers } from './utils/perf-logger.ts';
import { attemptRecovery } from './utils/db-recovery';
import { parseMailto, mailtoToPrefill } from './utils/mailto';
import { selectedFolder } from './stores/folderStore';
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

const loadCalendarComponent = () => import('./svelte/Calendar.svelte');
const loadContactsComponent = () => import('./svelte/Contacts.svelte');
const loadComposeComponent = () => import('./svelte/Compose.svelte');

function detectRoute() {
  const params = new URLSearchParams(window.location.search);
  const isAddingAccount = params.get('add_account') === 'true';

  if (window.location.pathname === '/login') return 'login';
  if (window.location.pathname.startsWith('/calendar')) return 'calendar';
  if (window.location.pathname.startsWith('/contacts')) return 'contacts';
  if (window.location.pathname.startsWith('/mailbox/profile')) return 'profile';
  if (window.location.pathname.startsWith('/mailbox/settings')) return 'settings';
  if (window.location.pathname.startsWith('/mailbox')) return 'mailbox';

  // For root path, check if user is authenticated
  if (window.location.pathname === '/' || window.location.pathname === '') {
    // If adding account, always show login regardless of auth status
    if (isAddingAccount) return 'login';

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
    load: () => mailboxActions.load(),
    loadMessages: () => mailboxActions.loadMessages(),
    toggleRead: (msg) => mailboxActions.toggleRead(msg),
    archiveMessage: (msg) => mailboxActions.archiveMessage(msg),
    deleteMessage: (msg, opts) => mailboxActions.deleteMessage(msg, opts),
    toggleStar: (msg) => mailboxActions.toggleStar(msg),
    replyTo: (msg) => mailboxActions.replyTo(msg),
    replyAll: (msg) => mailboxActions.replyAll(msg),
    forwardMessage: (msg) => mailboxActions.forwardMessage(msg),
    onSearch: (term) => mailboxActions.onSearch(term),
    getSelectedConversations: () => mailboxActions.getSelectedConversations(),
    getSelectedMessagesFromConversations: () =>
      mailboxActions.getSelectedMessagesFromConversations(),
    bulkMoveTo: (target) => mailboxActions.bulkMoveTo(target),
    contextMoveTo: (msg, target) => mailboxActions.contextMoveTo(msg, target),
    contextLabel: (msg, label, options) => mailboxActions.contextLabel(msg, label, options),
    createLabel: (name, color) => mailboxActions.createLabel(name, color),
    loadLabels: () => mailboxActions.loadLabels(),
    rebuildFullSearchIndex: () => mailboxActions.rebuildFullSearchIndex(),
    rebuildSearchFromCache: () => mailboxActions.rebuildSearchFromCache(),
    toggleBodyIndexing: () => mailboxActions.toggleBodyIndexing(),
    toggleAccountMenu: () => mailboxActions.toggleAccountMenu(),
    toggleBulkMove: () => mailboxActions.toggleBulkMove(),
    addAccount: () => mailboxActions.addAccount(),
    switchAccount: (acct) => mailboxActions.switchAccount(acct),
    signOut: () => mailboxActions.signOut(),
    setLayoutMode: (mode) => mailboxActions.setLayoutMode(mode),
    moveTarget: selectedFolder, // Alias for compatibility
    downloadOriginal: (msg) => mailboxActions.downloadOriginal(msg),
    viewOriginal: (msg) => mailboxActions.viewOriginal(msg),
  },
  // Keep settingsModal for compatibility
  settingsModal: (() => {
    const visibleStore = writable(false);
    return {
      visible: (val) => {
        if (val !== undefined) visibleStore.set(val);
        return get(visibleStore);
      },
      open: () => visibleStore.set(true),
      storageUsed: mailboxActions.storageUsed,
      storageTotal: mailboxActions.storageTotal,
      localUsage: mailboxActions.localUsage,
      localQuota: mailboxActions.localQuota,
      indexCount: mailboxActions.indexCount,
      indexSize: mailboxActions.indexSize,
      syncPending: mailboxActions.syncPending,
      bodyIndexingEnabled: mailboxActions.bodyIndexingEnabled,
      rebuildIndex: () => mailboxActions.rebuildFullSearchIndex(),
      toggleBodyIndexing: () => mailboxActions.toggleBodyIndexing(),
    };
  })(),
};
viewModel.route = routeStore;
viewModel.currentRoute = currentRoute;

const toastsRoot = document.getElementById('toasts-root');
const toasts = toastsRoot
  ? createToastHost(toastsRoot)
  : {
      show: () => {},
      dismiss: () => {},
      items: { subscribe: (run) => run([]) || (() => {}) },
    };

window.addEventListener('outbox-sent', (event) => {
  const subject = event?.detail?.subject;
  toasts.show(`Message sent${subject ? `: ${subject}` : ''}`, 'success');
});

window.addEventListener('mutation-queue-failed', () => {
  toasts.show("Some changes couldn't be synced. Please try again.", 'error');
});

// Set up mailboxActions references
mailboxActions.setToasts(toasts);
setIndexToasts(toasts);
setDemoToasts(toasts);
viewModel.toasts = toasts;
viewModel.mailboxView.toasts = toasts;

const loginRoot = document.getElementById('login-root');
const loginWrapper = document.querySelector('.fe-login-shell');
if (loginRoot) {
  mount(Login, {
    target: loginRoot,
    props: {
      onSuccess: (path = '/mailbox') => {
        mailboxActions.resetSessionState?.();
        if (viewModel.navigate) {
          viewModel.navigate(path);
        } else {
          window.location.href = path;
        }
      },
    },
  });
}

const settingsRoot = document.getElementById('settings-root');
const profileRoot = document.getElementById('profile-root');

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

const calendarRoot = document.getElementById('calendar-root');
let _calendarApp = null;
let calendarApi = {
  reload: () => {},
  prefillQuickEvent: () => {},
};

const calendarActive = writable(currentRoute() === 'calendar');
if (calendarRoot) {
  loadCalendarComponent()
    .then(({ default: Calendar }) => {
      _calendarApp = mount(Calendar, {
        target: calendarRoot,
        props: {
          navigate: (path: string) => viewModel.navigate?.(path),
          toasts,
          active: calendarActive,
          registerApi: (api: typeof calendarApi) => {
            if (api) {
              calendarApi = api;
              // If user is currently on calendar, ensure initial render
              if (currentRoute() === 'calendar') {
                calendarApi.reload?.();
              }
            }
          },
        },
      });
    })
    .catch((err) => {
      console.error('Failed to load calendar component', err);
    });
}

viewModel.calendarView = {
  load: () => calendarApi.reload?.(),
  prefillQuickEvent: (email) => calendarApi.prefillQuickEvent?.(email),
};

const contactsRoot = document.getElementById('contacts-root');
let contactsApi = {
  reload: () => {},
};

if (contactsRoot) {
  loadContactsComponent()
    .then(({ default: Contacts }) => {
      mount(Contacts, {
        target: contactsRoot,
        props: {
          navigate: (path: string) => viewModel.navigate?.(path),
          toasts,
          registerApi: (api: typeof contactsApi) => {
            if (api) {
              contactsApi = api;
              if (currentRoute() === 'contacts') {
                contactsApi.reload?.();
              }
            }
          },
        },
      });
    })
    .catch((err) => {
      console.error('Failed to load contacts component', err);
    });
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
window.addEventListener('fe:calendar-changed', _feCalendarChanged);
window.addEventListener('fe:calendar-event-changed', _feCalendarEventChanged);
window.addEventListener('fe:contacts-changed', _feContactsChanged);
window.addEventListener('fe:contact-changed', _feContactChanged);

export function cleanupCustomEventListeners() {
  window.removeEventListener('fe:calendar-changed', _feCalendarChanged);
  window.removeEventListener('fe:calendar-event-changed', _feCalendarEventChanged);
  window.removeEventListener('fe:contacts-changed', _feContactsChanged);
  window.removeEventListener('fe:contact-changed', _feContactChanged);
}

const composeRoot = document.getElementById('compose-root');
let _composeApp = null;
let composeApi = {
  open: () => {},
  close: () => {},
  forward: () => {},
  reply: () => {},
  setContacts: () => {},
  isVisible: () => false,
  isMinimized: () => false,
  setToList: () => {},
  saveDraft: () => {},
};

const passphraseRoot = document.getElementById('passphrase-root');
let passphraseApi = {
  open: () => Promise.reject(new Error('Passphrase modal not available')),
  close: () => {},
};

const mailboxRoot = document.getElementById('mailbox-root');
let _mailboxApp = null;
let mailboxApi = null;

const composeMailboxView = writable(null);
if (composeRoot) {
  loadComposeComponent()
    .then(({ default: Compose }) => {
      _composeApp = mount(Compose, {
        target: composeRoot,
        props: {
          toasts,
          mailboxView: composeMailboxView,
          registerApi: (api: typeof composeApi) => {
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
    })
    .catch((err) => {
      console.error('Failed to load compose component', err);
    });
}

if (passphraseRoot) {
  mount(Passphrase, {
    target: passphraseRoot,
    props: {
      registerApi: (api: typeof passphraseApi) => {
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
      registerApi: (api: typeof mailboxApi) => {
        if (api) mailboxApi = api;
      },
    },
  });
}

const updateRouteVisibility = (route) => {
  if (loginWrapper) loginWrapper.style.display = route === 'login' ? 'block' : 'none';
  if (mailboxRoot) mailboxRoot.style.display = route === 'mailbox' ? 'block' : 'none';
  if (settingsRoot) settingsRoot.style.display = route === 'settings' ? 'block' : 'none';
  if (calendarRoot) calendarRoot.style.display = route === 'calendar' ? 'block' : 'none';
  if (contactsRoot) contactsRoot.style.display = route === 'contacts' ? 'block' : 'none';
  if (profileRoot) profileRoot.style.display = route === 'profile' ? 'block' : 'none';
};

// Forward declaration for handleHashActions
let handleHashActions;
let autoSyncTimer = null;
let starfieldDisposer = null;
let themeUnsub = null;

// SPA-style navigation to avoid reload flicker
viewModel.navigate = (path) => {
  if (!path || typeof path !== 'string') return;
  const sameOrigin = path.startsWith('/');
  if (!sameOrigin) {
    window.location.href = path;
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
    history.replaceState({}, '', '/');
    routeStore.set('login');
    return;
  }

  history.pushState({}, '', path);
  routeStore.set(detectRoute());

  // Dispatch event for Login component to clear fields when adding account
  if (path.includes('add_account=true')) {
    window.dispatchEvent(new CustomEvent('login-clear-fields'));
  }

  // Handle hash-based actions after route is set
  if (handleHashActions) {
    handleHashActions();
  }
};

// expose navigation to child contexts
viewModel.mailboxView.navigate = viewModel.navigate;
viewModel.settingsModal.navigate = viewModel.navigate;
mailboxActions.setNavigate(viewModel.navigate);

viewModel.pgpPassphraseModal = passphraseApi;
// Use Svelte compose
viewModel.mailboxView.composeModal = {
  open: (prefill) => {
    return composeApi.open(prefill);
  },
  close: () => composeApi.close(),
  forward: (prefill) =>
    composeApi.forward({
      subject: prefill?.subject,
      // Use the body from prefill (set by mailboxActions) or fall back to store
      body: prefill?.body || get(messageBody),
    }),
  reply: (prefill) =>
    composeApi.reply({
      subject: prefill?.subject,
      from: prefill?.from,
      to: prefill?.to,
      cc: prefill?.cc,
      date: prefill?.date,
      // Use the body from prefill (set by mailboxActions) or fall back to store
      body: prefill?.body || get(messageBody),
      bodyLoading: prefill?.bodyLoading,
      inReplyTo: prefill?.inReplyTo,
    }),
  updateReplyBody: (body, options) => composeApi.updateReplyBody?.(body, options),
  toList: (list) => composeApi.setToList(list),
  setContacts: (list) => composeApi.setContacts(list),
  isVisible: () => composeApi.isVisible?.(),
};
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
  if (route !== 'mailbox') composeApi.close();
  // Update active stores instead of using $set
  mailboxActive.set(route === 'mailbox');
  calendarActive.set(route === 'calendar');
  profileActive.set(route === 'profile');
  if (mailboxMode) {
    if (starfieldDisposer) {
      starfieldDisposer();
      starfieldDisposer = null;
    }
  } else if (!starfieldDisposer) {
    starfieldDisposer = initStarfield();
  }
  updateRouteVisibility(route);
  if (route !== 'settings') {
    viewModel.settingsModal.visible(false);
  }
  if (route === 'mailbox') viewModel.mailboxView.load();
  if (route === 'settings') viewModel.settingsModal.open();
  if (route === 'calendar') viewModel.calendarView.load();
  if (route === 'contacts') contactsApi.reload?.();
  if (mailboxMode) {
    if (starfieldDisposer) {
      starfieldDisposer();
      starfieldDisposer = null;
    }
  } else if (!starfieldDisposer) {
    starfieldDisposer = initStarfield();
  }
});

function initKeyboardShortcuts() {
  const handleRouteChange = (route) => updateShortcutState(route);

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
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
      viewModel.mailboxView.replyTo(msg);
    } else {
      viewModel.mailboxView.toasts?.show?.('Select a message to reply', 'info');
    }
  });

  keyboardShortcuts.on('reply-all', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
      viewModel.mailboxView.replyAll?.(msg);
    } else {
      viewModel.mailboxView.toasts?.show?.('Select a message to reply all', 'info');
    }
  });

  keyboardShortcuts.on('reply-list', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
      viewModel.mailboxView.replyTo(msg);
    } else {
      viewModel.mailboxView.toasts?.show?.('Select a message to reply', 'info');
    }
  });

  keyboardShortcuts.on('forward', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
      viewModel.mailboxView.forwardMessage?.(msg);
    }
  });

  keyboardShortcuts.on('edit-as-new', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
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
    } catch (err) {
      console.error('[Shortcuts] Failed to save draft', err);
      viewModel.mailboxView.toasts?.show?.('Failed to save draft', 'error');
    }
  });

  keyboardShortcuts.on('print', () => {
    window.print();
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
    if (currentRoute() !== 'mailbox') return;
    mailboxApi?.expandSelectedThread?.();
  });
  keyboardShortcuts.on('collapse-thread', () => {
    if (currentRoute() !== 'mailbox') return;
    mailboxApi?.collapseSelectedThread?.();
  });

  // Managing / marking / tags
  keyboardShortcuts.on('toggle-read', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
      viewModel.mailboxView.toggleRead(msg);
    }
  });

  keyboardShortcuts.on('mark-thread-read', () => {
    if (currentRoute() !== 'mailbox') return;
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
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (mailboxApi?.archiveSelected) {
      mailboxApi.archiveSelected();
      return;
    }
    if (msg) {
      viewModel.mailboxView.archiveMessage(msg);
    }
  });

  keyboardShortcuts.on('delete', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (mailboxApi?.deleteSelected) {
      mailboxApi.deleteSelected();
      return;
    }
    if (msg) {
      viewModel.mailboxView.deleteMessage(msg, { permanent: false });
    }
  });

  keyboardShortcuts.on('delete-permanent', () => {
    const msg = get(viewModel.mailboxView.selectedMessage);
    if (msg) {
      viewModel.mailboxView.deleteMessage(msg, { permanent: true });
    }
  });

  keyboardShortcuts.on('next-message', () => {
    if (currentRoute() !== 'mailbox') return;
    mailboxApi?.selectNext?.();
  });

  keyboardShortcuts.on('previous-message', () => {
    if (currentRoute() !== 'mailbox') return;
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
}

function showShortcutsHelp() {
  showKeyboardShortcutsHelp();

  // Show in modal (you'll need to create a modal for this)
  viewModel.mailboxView.toasts?.show?.('Press ? to see keyboard shortcuts', 'info');
}

function applyTheme(pref) {
  const theme = pref || getEffectiveSettingValue('theme') || 'system';
  const prefersDark =
    window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
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
    { id: 'stars', starCount: 180, speed: 0.15, maxRadius: 1.2 },
    { id: 'stars2', starCount: 120, speed: 0.08, maxRadius: 1.4 },
    { id: 'stars3', starCount: 80, speed: 0.04, maxRadius: 1.6 },
  ];

  const disposers = layers.map((layer) => createStarfield(layer.id, layer));

  return () => disposers.forEach((dispose) => dispose && dispose());
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
    if (!res.ok) return;
    const manifest = await res.json();
    if (!manifest.clear_below) return;

    // Compare semver portion only (strip build hash suffix like "-a1b2c3d4")
    const raw = import.meta.env.VITE_PKG_VERSION || '0.0.0';
    const parts = raw.split('.').map(Number);
    const threshold = manifest.clear_below.split('.').map(Number);
    const isBelow =
      parts[0] < threshold[0] ||
      (parts[0] === threshold[0] && parts[1] < threshold[1]) ||
      (parts[0] === threshold[0] && parts[1] === threshold[1] && parts[2] < threshold[2]);
    if (!isBelow) return;

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
    await Promise.all(cacheKeys.map((k) => caches.delete(k)));
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.unregister();
    }

    // Clear web storage
    localStorage.clear();
    sessionStorage.clear();

    // Reload — fresh assets will have the current version, so this won't loop
    window.location.reload();
  } catch {
    // Manifest fetch failed or parse error — continue normally
  }
}

// ── App Lock helpers (used by bootstrap and exported for Settings) ──

/**
 * Show the lock screen overlay and wait for the user to unlock.
 * Returns a promise that resolves when unlock succeeds.
 */
function showLockScreen(): Promise<void> {
  return new Promise((resolve) => {
    const lockOverlay = document.getElementById('app-lock-overlay');
    if (!lockOverlay) {
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
            resolve();
          },
          { once: true },
        );
      });
    });
  });
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
  const root = document.getElementById('rl-app');
  if (!root) return;

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
            await Promise.all(registrations.map((reg) => reg.unregister()));
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
    if (typeof window.__markAppBootstrapped === 'function') {
      window.__markAppBootstrapped();
    }

    // Initialize i18n first
    await i18n.init();
    initPerfObservers();

    // Eagerly load libsodium on Tauri to avoid first-use latency
    if (window.__TAURI_INTERNALS__) {
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
      onRecoveryStart: (error) => {
        console.warn('[DB] Database recovery started due to:', error?.message);
        // Show a non-dismissible toast during recovery
        toasts?.show?.('Updating local database...', 'info', 0);
      },
      onRecoveryComplete: () => {
        // Dismiss the recovery toast and show success
        toasts?.dismiss?.();
        toasts?.show?.('Local database updated successfully', 'success');
      },
      onRecoveryFailed: (error) => {
        console.error('[DB] Database recovery failed:', error?.message);
        toasts?.dismiss?.();
        toasts?.show?.(
          'Database update failed. You may need to clear browser data in Settings.',
          'error',
          10000,
        );
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
        10000,
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
      reconcileOrphanedAccountData().catch((err) => {
        console.warn('[DB] Account reconciliation failed:', err);
      });
    }

    let route = currentRoute();
    const params = new URLSearchParams(window.location.search);
    const isAddingAccount = params.get('add_account') === 'true';

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
      history.replaceState({}, '', '/');
      route = 'login';
    } else if (route === 'mailbox' && window.location.pathname === '/' && !isAddingAccount) {
      // Update URL to /mailbox when user is authenticated and on root path
      // But skip this if we're adding an account
      history.replaceState({}, '', '/mailbox');
    }

    // Handle ?email= query parameter for account switching
    const emailParam = params.get('email');
    if (emailParam && route !== 'login') {
      const allAccounts = Accounts.getAll();
      const activeEmail = Accounts.getActive();
      const normalizedEmail = emailParam.trim().toLowerCase();
      const matchedAccount = allAccounts.find((a) => a.email.toLowerCase() === normalizedEmail);

      if (matchedAccount) {
        // Already logged in with this account — switch to it if not already active
        if (activeEmail?.toLowerCase() !== normalizedEmail) {
          mailboxActions.switchAccount(normalizedEmail);
        }
        // Clean up URL — remove query params, go to /mailbox
        history.replaceState({}, '', '/mailbox');
        route = 'mailbox';
        routeStore.set('mailbox');
      } else {
        // Not logged in with this account — go to add-account login with email prefilled
        history.replaceState({}, '', `/?add_account=true&email=${encodeURIComponent(emailParam)}`);
        route = 'login';
        routeStore.set('login');
        window.dispatchEvent(new CustomEvent('login-prefill-email', { detail: emailParam }));
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
    if (isLockEnabled() && isVaultConfigured() && !isUnlocked()) {
      await showLockScreen();
    }

    // Start inactivity timer if app lock is enabled (re-locks after idle)
    if (isLockEnabled() && isVaultConfigured()) {
      startAppLockTimer();
    }

    viewModel.settingsModal.applyTheme = applyTheme;
    viewModel.settingsModal.applyFont = applyFont;
    themeUnsub?.();
    themeUnsub = effectiveTheme.subscribe((value) => applyTheme(value || 'system'));

    // Apply saved font preference
    const currentAcct = Local.get('email') || 'default';
    const savedFont = getEffectiveSettingValue('font', { account: currentAcct });
    if (savedFont && savedFont !== 'system') {
      // Import and apply font loader
      import('./utils/font-loader.js')
        .then(({ loadFont }) => {
          loadFont(savedFont)
            .then(applyFont)
            .catch((err) => {
              console.warn('[bootstrap] Failed to load saved font:', err);
            });
        })
        .catch((err) => {
          console.warn('[bootstrap] Failed to import font-loader:', err);
        });
    }

    // Svelte compose handles its own editor initialization
    if (route === 'mailbox') viewModel.mailboxView.load();
    if (route === 'settings') viewModel.settingsModal.open();
    if (route === 'calendar') viewModel.calendarView.load();
    if (route === 'contacts') contactsApi.reload?.();
    if (!starfieldDisposer && !mailboxMode) {
      starfieldDisposer = initStarfield();
    }
    startAutoMetadataSync();
    initKeyboardShortcuts();

    // Start outbox processor for offline email queue with retry
    startOutboxProcessor();
    syncPendingDrafts();
    initMutationQueue();

    window.addEventListener('online', () => {
      processOutbox(); // New outbox service
      syncPendingDrafts();
      processMutationQueue();
    });

    // Tauri-specific native integrations (desktop + mobile)
    if (isTauri) {
      import('./utils/tauri-bridge.js').then(({ initTauriBridge }) => initTauriBridge());
      import('./utils/updater-bridge.js').then(({ initAutoUpdater }) => initAutoUpdater());
      import('./utils/notification-bridge.js').then(({ initNotificationChannels }) =>
        initNotificationChannels(),
      );
    }

    if (canUseServiceWorker() && import.meta.env.PROD) {
      window.addEventListener('load', () => {
        registerServiceWorker();
      });
    }

    // Web auto-updater: listen for newRelease WebSocket events
    if (!isTauri && import.meta.env.PROD) {
      import('./utils/web-updater.js').then(({ start: startWebUpdater }) => startWebUpdater());
    }

    // Register as mailto: handler on the web (not in Tauri — Tauri handles via OS registration)
    if (!isTauri && navigator.registerProtocolHandler) {
      try {
        // The %s placeholder is replaced by the browser with the full mailto: URI
        navigator.registerProtocolHandler('mailto', `${window.location.origin}/mailbox#mailto=%s`);
      } catch (err) {
        console.warn('[main] Failed to register mailto: handler', err);
      }
    }

    // Listen for deep-link events from Tauri (mailto:, forwardemail://)
    // The tauri-bridge dispatches 'app:deep-link' CustomEvents on window.
    window.addEventListener('app:deep-link', (event: Event) => {
      const url = (event as CustomEvent)?.detail?.url;
      if (!url || typeof url !== 'string') return;

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
    window.addEventListener('app:single-instance', (event: Event) => {
      const args = (event as CustomEvent)?.detail?.args;
      if (!Array.isArray(args)) return;

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
  } catch (error) {
    console.error('[main] bootstrap failed', error);

    // Show the fallback recovery UI so user can clear cache and reload
    const fallback = document.getElementById('fe-fallback-recovery');
    if (fallback) {
      fallback.style.display = 'block';
    }

    // Track the error
    if (window.gtag) {
      window.gtag('event', 'exception', {
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
    if (!data || data.type !== 'dbError') return;

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
        setTimeout(() => window.location.reload(), 1500);
      } else {
        toasts?.show?.(
          'Could not fix storage issue. Try clearing browser data in Settings.',
          'error',
          10000,
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
  window.addEventListener('sync-shim-message', (event) => {
    handleDbError((event as CustomEvent).detail);
  });
}

function getServiceWorkerUrl() {
  let baseUrl = import.meta.env.BASE_URL || '/';
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  return new URL('sw.js', `${window.location.origin}${baseUrl}`).toString();
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
    window.__swRegistration = registration;
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

window.addEventListener('popstate', () => {
  routeStore.set(detectRoute());
});

// Handle hash-based deep links (e.g., /mailbox#compose=user@example.com or /mailbox#INBOX/12345)
handleHashActions = function () {
  const hash = window.location.hash || '';
  if (hash.startsWith('#compose=') || hash.startsWith('#mailto=')) {
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
    // clear hash to avoid repeat
    history.replaceState({}, '', window.location.pathname);
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
    // clear hash to avoid repeat
    history.replaceState({}, '', window.location.pathname);
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
    // clear hash to avoid repeat
    history.replaceState({}, '', window.location.pathname);
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

window.addEventListener('hashchange', handleHashActions);
handleHashActions();

function getPrefetchFolders() {
  const account = Local.get('email') || 'default';
  const extra = getEffectiveSettingValue('prefetch_folders', { account });
  const list = Array.isArray(extra) ? extra : [];
  const folders = ['INBOX', ...list];
  return Array.from(new Set(folders.filter(Boolean)));
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
  if (get(mailboxActions.initialSyncStarted)) return;

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
