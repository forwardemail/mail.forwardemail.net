<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { readable, type Readable, type Unsubscriber } from 'svelte/store';
  import { Local } from '../utils/storage';
  import { keyboardShortcuts } from '../utils/keyboard-shortcuts';
  import { getDatabaseInfo, CURRENT_SCHEMA_VERSION, db } from '../utils/db';
  import { cacheManager } from '../utils/cache-manager';
  import { unregisterServiceWorker } from '../utils/sw-cache.js';
  import AppLockSettings from './AppLockSettings.svelte';
  import MailtoSettings from './components/MailtoSettings.svelte';
  import { forceDeleteAllDatabases } from '../utils/db-recovery.js';
  import { closeDatabase, terminateDbWorker } from '../utils/db-worker-client.js';
  import { deactivateDemoMode } from '../utils/demo-mode.js';
  import { refreshSyncWorkerPgpKeys } from '../utils/sync-worker-client.js';
  import { initPerfObservers } from '../utils/perf-logger.ts';
  import { mailService, clearPgpKeyCache, invalidatePgpCachedBodies } from '../stores/mailService';
  import { searchStore } from '../stores/searchStore';
  const { health: healthStore, stats: searchStatsStore } = searchStore.state;
  const { checkHealth, rebuildFromCache } = searchStore.actions;
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Label } from '$lib/components/ui/label';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import * as Card from '$lib/components/ui/card';
  import * as Alert from '$lib/components/ui/alert';
  import * as Select from '$lib/components/ui/select';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Tabs from '$lib/components/ui/tabs';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Separator } from '$lib/components/ui/separator';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Plus from '@lucide/svelte/icons/plus';
  import Info from '@lucide/svelte/icons/info';
  import User from '@lucide/svelte/icons/user';
  import Pencil from '@lucide/svelte/icons/pencil';
  import X from '@lucide/svelte/icons/x';
  import MessageSquare from '@lucide/svelte/icons/message-square';
  import AlertCircle from '@lucide/svelte/icons/alert-circle';
  import CheckCircle from '@lucide/svelte/icons/check-circle';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import {
    accounts,
    currentAccount,
    loadAccounts,
    createLabel as createMailboxLabel,
    updateLabel as updateMailboxLabel,
    deleteLabel as deleteMailboxLabel,
    switchAccount,
    signOut as mailboxSignOut,
    syncProgress,
    layoutMode,
    setLayoutMode,
  } from '../stores/mailboxActions';
  import {
    settingsLabels,
    attachmentReminder,
    profileName,
    loadProfileName,
    setProfileName,
    fetchSettings,
    effectiveTheme,
    getEffectiveSettingValue,
    setSettingValue,
    isSettingOverrideEnabled,
    setSettingOverrideEnabled,
    localSettingsVersion,
    getSettingDefinition,
    SETTING_SCOPES,
    fetchLabels as fetchSettingsLabels,
    settingsActions,
  } from '../stores/settingsStore';
  import { mailboxStore } from '../stores/mailboxStore';
  const { folders: foldersStore } = mailboxStore.state;
  const { loadFolders } = mailboxStore.actions;
  import { validateLabelName } from '../utils/label-validation.ts';
  import { config } from '../config.js';
  import { getFonts, loadFont, getFontFamily } from '../utils/font-loader.js';
  import { LABEL_PALETTE, pickLabelColor as pickLabelColorFromPalette } from '../utils/labels.js';
  import FeedbackModal from './FeedbackModal.svelte';
  import LabelModal from './components/LabelModal.svelte';

  interface ToastApi {
    show?: (message: string, type?: string) => void;
  }

  interface Props {
    navigate?: (path: string) => void;
    storageUsed?: Readable<number> | number;
    storageTotal?: Readable<number> | number;
    localUsage?: Readable<number> | number;
    localQuota?: Readable<number> | number;
    syncPending?: Readable<number> | number;
    indexCount?: Readable<number> | number;
    indexSize?: Readable<number> | number;
    bodyIndexingEnabled?: Readable<boolean> | boolean;
    rebuildIndex?: () => Promise<void>;
    toggleBodyIndexing?: (enabled: boolean) => void;
    toasts?: ToastApi | null;
    applyTheme?: (theme: string) => void;
    applyFont?: (family: string) => void;
  }

  let {
    navigate = () => {},
    storageUsed,
    storageTotal,
    localUsage,
    localQuota,
    syncPending,
    indexCount,
    indexSize,
    bodyIndexingEnabled,
    rebuildIndex = async () => {},
    toggleBodyIndexing = () => {},
    toasts = null,
    applyTheme = () => {},
    applyFont = () => {},
  }: Props = $props();

  const asStore = <T>(value: Readable<T> | T | undefined): Readable<T> =>
    value && typeof (value as Readable<T>).subscribe === 'function'
      ? value as Readable<T>
      : readable((value ?? 0) as T);

  const storageUsedStore = asStore(storageUsed);
  const storageTotalStore = asStore(storageTotal);
  const localUsageStore = asStore(localUsage);
  const localQuotaStore = asStore(localQuota);
  const syncPendingStore = asStore(syncPending);
  const syncProgressStore = asStore(syncProgress);
  const indexCountStore = asStore(indexCount);
  const indexSizeStore = asStore(indexSize);
  const bodyIndexingStore = asStore(bodyIndexingEnabled);
  const layoutModeStore = asStore(layoutMode);

  let apiKey = $state('');
  let theme = $state('system');
  let layoutModeChoice = $state('full');
  let section = $state('general');
  let composePlainDefault = $state(false);
  let attachmentReminderEnabled = $state(false);
  let messagesPerPage = $state(20);
  let archiveFolder = $state('');
  let sentFolder = $state('');
  let draftsFolder = $state('');
  let availableFolders = $state<string[]>([]);
  let aliasEmail = $state('');
  let activeEmail = $state('');
  let bodyIndexingLocal = $state(true);
  let rebuildingIndex = $state(false);
  let rebuildConfirmVisible = $state(false);
  let pgpKeys = $state<{ name: string; value: string }[]>([]);
  let keyFormVisible = $state(false);
  let editingKeyName = $state('');
  let editingKeyValue = $state('');
  let blockRemoteImages = $state(false);
  let blockTrackingPixels = $state(true);
  let fontChoice = $state('system');
  let fontLoading = $state(false);
  let availableFonts = $state<{ key: string; name: string; family: string }[]>([]);
  let currentFontFamily = $state('system-ui, -apple-system, sans-serif');
  let editingIndex = $state(-1);
  let error = $state('');
  let success = $state('');
  let alertClearTimer: ReturnType<typeof setTimeout> | undefined;
  let databaseVersion = $state(CURRENT_SCHEMA_VERSION);
  let databaseRecordCount = $state(0);
  let shortcutsList = $state<{ label: string; key?: string; keys?: string[]; originalKey?: string }[]>([]);
  const isMac = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

  const buildAvailableFolders = (list: { path?: string; name?: string; fullName?: string; fullname?: string }[] = []) => {
    const seen = new Set<string>();
    const mapped: string[] = [];
    (list || []).forEach((folder) => {
      const path = folder?.path || folder?.name || folder?.fullName || folder?.fullname;
      if (!path || seen.has(path)) return;
      seen.add(path);
      mapped.push(path);
    });
    return mapped;
  };

  let cacheStats = $state<Record<string, unknown> | null>(null);
  let storageInfo = $state<Record<string, unknown> | null>(null);
  let loadingCacheStats = $state(false);
  let resettingStorage = $state(false);
  let debugPerfEnabled = $state(false);
  let profileNameValue = $state('');
  let lastProfileAccount = '';
  let editingProfileName = $state(false);
  let hybridOverrides = $state<Record<string, boolean>>({});
  const hybridSettingIds = ['theme', 'layout_mode', 'messages_per_page', 'compose_plain_default'];

  const commitProfileName = () => {
    editingProfileName = false;
    const trimmed = (profileNameValue || '').trim();
    if (trimmed !== profileNameValue) {
      profileNameValue = trimmed;
    }
    setProfileName(trimmed, $currentAccount);
  };

  const handleProfileNameFocus = () => {
    editingProfileName = true;
  };

  const handleProfileNameKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      (event.currentTarget as HTMLElement).blur();
    }
  };

  const getAccountId = () => activeEmail || getAliasEmail() || Local.get('email') || 'default';

  const isHybridSetting = (id: string) => getSettingDefinition(id)?.scope === SETTING_SCOPES.HYBRID;

  const getScopeMeta = (id: string) => {
    const def = getSettingDefinition(id);
    if (!def) return { label: 'Unclassified', variant: 'device' };
    if (def.scope === SETTING_SCOPES.ACCOUNT) {
      return { label: 'Synced', variant: 'account' };
    }
    if (def.scope === SETTING_SCOPES.DEVICE) {
      return { label: 'Device only', variant: 'device' };
    }
    const isOverridden = Boolean(hybridOverrides?.[id]);
    return isOverridden
      ? { label: 'Device override', variant: 'device' }
      : { label: 'Synced default', variant: 'account' };
  };

  const getScopeTooltip = (id: string) => {
    const def = getSettingDefinition(id);
    if (!def) return 'Scope not classified yet.';
    if (def.scope === SETTING_SCOPES.ACCOUNT) {
      return 'Synced: stored with your account and available on your other devices.';
    }
    if (def.scope === SETTING_SCOPES.DEVICE) {
      return 'Device only: stored on this device and not synced.';
    }
    if (def.scope === SETTING_SCOPES.HYBRID) {
      return hybridOverrides?.[id]
        ? 'Device override: this device uses a local value instead of the synced default.'
        : 'Synced default: saved with your account unless you override it on this device.';
    }
    return 'Scope not classified yet.';
  };

  const refreshHybridOverrides = () => {
    const acct = getAccountId();
    hybridOverrides = hybridSettingIds.reduce((acc, id) => {
      acc[id] = isSettingOverrideEnabled(id, acct);
      return acc;
    }, {} as Record<string, boolean>);
  };

  const getSettingStateValue = (id: string) => {
    switch (id) {
      case 'theme':
        return theme;
      case 'layout_mode':
        return layoutModeChoice;
      case 'messages_per_page':
        return messagesPerPage;
      case 'compose_plain_default':
        return composePlainDefault;
      default:
        return undefined;
    }
  };

  const applySettingStateValue = (id: string, value: unknown) => {
    switch (id) {
      case 'theme':
        theme = (value as string) || 'system';
        applyTheme?.(theme);
        break;
      case 'layout_mode':
        layoutModeChoice = (value as string) || 'full';
        break;
      case 'messages_per_page':
        messagesPerPage = Number.parseInt(value as string, 10) || 20;
        break;
      case 'compose_plain_default':
        composePlainDefault = Boolean(value);
        break;
      default:
        break;
    }
  };

  const toggleSettingOverride = (id: string) => {
    const acct = getAccountId();
    const next = !hybridOverrides?.[id];
    const currentValue = getSettingStateValue(id);
    setSettingOverrideEnabled(id, next, { account: acct, value: currentValue });
    hybridOverrides = { ...hybridOverrides, [id]: next };
    if (!next) {
      const effective = getEffectiveSettingValue(id, { account: acct });
      applySettingStateValue(id, effective);
    }
  };
  const settingsLabelsStore = asStore(settingsLabels);
  let labelsLoading = $state(false);
  let labelsDeleting = $state('');
  const labelPalette = LABEL_PALETTE;
  let labelPaletteIndex = 0;
  let labelModalVisible = $state(false);
  let labelModalSaving = $state(false);
  let labelModalError = $state('');
  let labelModalMode = $state<'create' | 'edit'>('create');
  let labelModalKeyword = $state('');
  let labelModalName = $state('');
  let labelModalColor = $state('');

  let storageUsedValue = $state(0);
  let storageTotalValue = $state(0);
  let localUsageValue = $state(0);
  let localQuotaValue = $state(0);
  let syncPendingValue = $state(0);
  let syncProgressValue = $state<Record<string, unknown>>({});
  let indexCountValue = $state(0);
  let indexSizeValue = $state(0);

  interface SearchHealth {
    healthy: boolean;
    messagesCount: number;
    indexCount: number;
    divergence: number;
    needsRebuild: boolean;
  }

  let searchHealth = $state<SearchHealth>({ healthy: true, messagesCount: 0, indexCount: 0, divergence: 0, needsRebuild: false });
  let checkingHealth = $state(false);
  let rebuildingFromCache = $state(false);
  let lastHealthCheck = $state<Date | null>(null);

  interface SavedSearch {
    name: string;
    query: string;
  }

  let savedSearches = $state<SavedSearch[]>([]);
  let newSavedSearchName = $state('');
  let newSavedSearchQuery = $state('');
  let savingSearch = $state(false);
  let deletingSearch = $state('');
  let showOperators = $state(false);
  let showAdvancedCache = $state(false);
  const operatorHelp = [
    { label: 'from:alice', note: 'Filter sender' },
    { label: 'to:bob', note: 'Filter recipient (to/cc/bcc)' },
    { label: 'subject:invoice', note: 'Subject contains' },
    { label: 'has:attachment', note: 'Only messages with attachments' },
    { label: 'is:unread', note: 'Unread only (is:read also works)' },
    { label: 'label:work', note: 'Filter by label' },
    { label: 'in:all', note: 'Search across folders' },
    { label: 'before:2024-01-01', note: 'Date filters (after/on supported)' },
    { label: 'size:>5MB', note: 'Size filters (>, <, >=, <=)' },
    { label: '"exact phrase"', note: 'Quotes for phrase search' },
    { label: '(from:alice AND has:attachment)', note: 'Use AND/OR/NOT and parentheses' },
  ];

  let feedbackModalOpen = $state(false);

  const sectionIds = new Set(['general', 'appearance', 'privacy', 'folders', 'search', 'advanced', 'shortcuts', 'help']);

  const formatStorageValue = (bytes = 0) => {
    if (!bytes) return '0 GB';
    const gb = bytes / 1024 / 1024 / 1024;
    if (gb >= 1) {
      const rounded = gb >= 10 ? Math.round(gb) : Math.round(gb * 10) / 10;
      return `${rounded} GB`;
    }
    const mb = bytes / 1024 / 1024;
    return `${Math.round(mb)} MB`;
  };

  const storagePercentValue = () => {
    if (!storageTotalValue) return 0;
    return Math.min(100, Math.round((storageUsedValue / storageTotalValue) * 100));
  };

  let subscriptions: Unsubscriber[] = [];

  onMount(() => {
    loadFromStorage();
    loadShortcuts();
    loadDatabaseInfo();

    const hash = window.location.hash?.slice(1) || '';
    if (hash === 'security' || hash === 'accounts') {
      section = 'privacy';
    } else if (sectionIds.has(hash)) {
      section = hash;
    }

    subscriptions = [
      currentAccount.subscribe((v: string) => {
        activeEmail = v || '';
        aliasEmail = activeEmail || getAliasEmail();
        loadLabelsList();
        loadFromStorage();
        loadFolders().catch(() => {});
        if (v && v !== lastProfileAccount) {
          lastProfileAccount = v;
          loadProfileName(v);
        }
      }),
      profileName.subscribe((name: string) => {
        if (!editingProfileName) {
          profileNameValue = name || '';
        }
      }),
      foldersStore.subscribe((list: unknown[]) => {
        availableFolders = buildAvailableFolders(list as { path?: string; name?: string; fullName?: string; fullname?: string }[]);
      }),
      effectiveTheme.subscribe((v: string) => {
        theme = v || 'system';
        applyTheme?.(theme);
      }),
      localSettingsVersion.subscribe(() => {
        refreshHybridOverrides();
      }),
      searchStore.state.savedSearches.subscribe((list: unknown[]) => {
        savedSearches = (list || []) as SavedSearch[];
      }),
      storageUsedStore.subscribe((v: number) => (storageUsedValue = v || 0)),
      storageTotalStore.subscribe((v: number) => (storageTotalValue = v || 0)),
      localUsageStore.subscribe((v: number) => (localUsageValue = v || 0)),
      localQuotaStore.subscribe((v: number) => (localQuotaValue = v || 0)),
      syncPendingStore.subscribe((v: number) => (syncPendingValue = v || 0)),
      syncProgressStore.subscribe((v: Record<string, unknown>) => (syncProgressValue = v || {})),
      indexCountStore.subscribe((v: number) => (indexCountValue = v || 0)),
      indexSizeStore.subscribe((v: number) => (indexSizeValue = v || 0)),
      bodyIndexingStore.subscribe((v: boolean) => (bodyIndexingLocal = !!v)),
      layoutModeStore.subscribe((v: string) => (layoutModeChoice = v || 'full')),
      healthStore.subscribe((v: SearchHealth) => (searchHealth = v || searchHealth)),
      attachmentReminder.subscribe((v: boolean) => (attachmentReminderEnabled = !!v)),
    ];
  });

  onDestroy(() => {
    subscriptions.forEach((fn) => fn?.());
  });

  const loadFromStorage = async () => {
    error = '';
    success = '';
    await fetchSettings();
    const currentAcct = getAccountId();
    apiKey = Local.get('api_key') || '';
    theme = getEffectiveSettingValue('theme', { account: currentAcct }) || 'system';
    layoutModeChoice = getEffectiveSettingValue('layout_mode', { account: currentAcct }) || 'full';
    composePlainDefault = Boolean(
      getEffectiveSettingValue('compose_plain_default', { account: currentAcct }),
    );
    messagesPerPage = Number.parseInt(
      getEffectiveSettingValue('messages_per_page', { account: currentAcct }) || '20',
      10,
    );
    archiveFolder = getEffectiveSettingValue('archive_folder', { account: currentAcct }) || '';
    sentFolder = getEffectiveSettingValue('sent_folder', { account: currentAcct }) || '';
    draftsFolder = getEffectiveSettingValue('drafts_folder', { account: currentAcct }) || '';
    bodyIndexingLocal = Boolean(
      getEffectiveSettingValue('search_body_indexing', { account: currentAcct }),
    );
    aliasEmail = getAliasEmail();
    debugPerfEnabled = Local.get('debug_perf') === '1';

    try {
      const pgpKey = `pgp_keys_${currentAcct}`;
      const storedKeys = Local.get(pgpKey);
      pgpKeys = storedKeys ? JSON.parse(storedKeys) : [];
    } catch {
      pgpKeys = [];
    }
    blockRemoteImages = Boolean(
      getEffectiveSettingValue('block_remote_images', { account: currentAcct }),
    );
    blockTrackingPixels = Boolean(
      getEffectiveSettingValue('block_tracking_pixels', { account: currentAcct }),
    );

    fontChoice = getEffectiveSettingValue('font', { account: currentAcct }) || 'system';
    currentFontFamily = getFontFamily(fontChoice);
    availableFonts = getFonts();

    if (fontChoice !== 'system') {
      fontLoading = true;
      loadFont(fontChoice)
        .then((family: string) => {
          currentFontFamily = family;
          applyFont(family);
        })
        .catch((err: Error) => {
          console.error('Failed to load saved font:', err);
          fontChoice = 'system';
        })
        .finally(() => {
          fontLoading = false;
        });
    }

    keyFormVisible = false;
    editingKeyName = '';
    editingKeyValue = '';
    editingIndex = -1;
    section = section || 'general';
    refreshHybridOverrides();

    await loadAccounts();
    try {
      await searchStore.actions.ensureInitialized();
      await searchStore.actions.refreshSavedSearches();
    } catch (err) {
      console.warn('Failed to init search store', err);
    }
    await loadLabelsList();
  };

  const getAliasEmail = () => {
    const aliasAuth = Local.get('alias_auth') || '';
    if (aliasAuth.includes(':')) return aliasAuth.split(':')[0];
    return Local.get('email') || aliasAuth || '';
  };

  const clearAlerts = () => {
    error = '';
    success = '';
    if (alertClearTimer) {
      clearTimeout(alertClearTimer);
      alertClearTimer = undefined;
    }
  };

  const setSuccess = (message: string) => {
    clearAlerts();
    success = message;
    alertClearTimer = setTimeout(() => {
      success = '';
    }, 4000);
  };

  const saveSavedSearch = async () => {
    clearAlerts();
    if (!newSavedSearchName.trim() || !newSavedSearchQuery.trim()) {
      setError('Please enter both a name and query.');
      return;
    }
    savingSearch = true;
    try {
      await searchStore.actions.saveSearch(newSavedSearchName.trim(), newSavedSearchQuery.trim());
      await searchStore.actions.refreshSavedSearches();
      newSavedSearchName = '';
      newSavedSearchQuery = '';
      setSuccess('Saved search added.');
    } catch (err) {
      setError((err as Error)?.message || 'Failed to save search.');
    } finally {
      savingSearch = false;
    }
  };

  const deleteSavedSearch = async (name: string) => {
    if (!name) return;
    deletingSearch = name;
    try {
      await searchStore.actions.deleteSavedSearch(name);
      await searchStore.actions.refreshSavedSearches();
      setSuccess('Saved search deleted.');
    } catch (err) {
      setError((err as Error)?.message || 'Failed to delete saved search.');
    } finally {
      deletingSearch = '';
    }
  };

  const setError = (message: string) => {
    clearAlerts();
    error = message;
    alertClearTimer = setTimeout(() => {
      error = '';
    }, 5000);
  };

  interface LabelItem {
    keyword?: string;
    id?: string;
    name?: string;
    color?: string;
  }

  const getLabelKey = (label: LabelItem | null) => label?.keyword || label?.id || label?.name;
  const pickLabelColor = () => {
    const color = pickLabelColorFromPalette(labelPaletteIndex, labelPalette);
    labelPaletteIndex += 1;
    return color;
  };

  const labelsList = $derived(($settingsLabelsStore || []).filter((label: unknown) => getLabelKey(label as LabelItem)));

  const loadLabelsList = async () => {
    labelsLoading = true;
    try {
      await fetchSettingsLabels(true);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load labels.');
    } finally {
      labelsLoading = false;
    }
  };

  const openCreateLabelModal = () => {
    labelModalMode = 'create';
    labelModalKeyword = '';
    labelModalName = '';
    labelModalColor = pickLabelColor();
    labelModalError = '';
    labelModalVisible = true;
  };

  const openEditLabelModal = (label: LabelItem) => {
    const key = getLabelKey(label);
    if (!key) return;
    labelModalMode = 'edit';
    labelModalKeyword = key;
    labelModalName = label?.name || key;
    labelModalColor = label?.color || '';
    labelModalError = '';
    labelModalVisible = true;
  };

  const closeLabelModal = () => {
    labelModalVisible = false;
    labelModalError = '';
  };

  const clearLabelModalError = () => {
    if (labelModalError) labelModalError = '';
  };

  const saveLabelModal = async () => {
    const name = (labelModalName || '').trim();
    const validation = validateLabelName(name);
    if (!validation.ok) {
      labelModalError = validation.error;
      return;
    }
    labelModalSaving = true;
    labelModalError = '';
    try {
      if (labelModalMode === 'edit') {
        const res = await updateMailboxLabel(labelModalKeyword, {
          name: validation.value,
          color: (labelModalColor || '').trim() || undefined,
        });
        if (!res?.success) {
          labelModalError = res?.error || 'Failed to update label.';
          return;
        }
      } else {
        const res = await createMailboxLabel(
          validation.value,
          (labelModalColor || '').trim() || undefined,
        );
        if (!res?.success) {
          labelModalError = res?.error || 'Failed to create label.';
          return;
        }
      }
      closeLabelModal();
    } catch (err) {
      labelModalError = (err as Error)?.message || 'Unable to save label.';
    } finally {
      labelModalSaving = false;
    }
  };

  const deleteLabel = async (label: LabelItem) => {
    const key = getLabelKey(label);
    if (!key) return;
    const labelName = label?.name || key;
    if (!confirm(`Delete label "${labelName}"?`)) return;
    labelsDeleting = key;
    try {
      const res = await deleteMailboxLabel(key);
      if (!res?.success) {
        setError(res?.error || 'Failed to delete label.');
        return;
      }
    } catch (err) {
      setError((err as Error)?.message || 'Failed to delete label.');
    } finally {
      labelsDeleting = '';
    }
  };

  const loadDatabaseInfo = async () => {
    try {
      const info = await getDatabaseInfo();
      if (info) {
        databaseVersion = info.version ?? CURRENT_SCHEMA_VERSION;
        const totalRecords = Object.values(info.counts || {}).reduce((sum: number, count) => sum + (count as number), 0);
        databaseRecordCount = totalRecords;
      }
    } catch (err) {
      console.warn('Failed to load database info:', err);
    }
  };

  const togglePerfLogging = () => {
    debugPerfEnabled = !debugPerfEnabled;
    Local.set('debug_perf', debugPerfEnabled ? '1' : '0');
    if (debugPerfEnabled) {
      initPerfObservers();
    }
    toasts?.show?.(
      debugPerfEnabled ? 'Performance tracing enabled' : 'Performance tracing disabled',
      'info',
    );
  };

  const saveTheme = async () => {
    try {
      await setSettingValue('theme', theme, { account: getAccountId() });
      applyTheme?.(theme);
      toasts?.show?.('Theme updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save theme', 'error');
    }
  };

  const saveLayoutMode = async () => {
    try {
      await setLayoutMode?.(layoutModeChoice);
      toasts?.show?.('Layout updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save layout', 'error');
    }
  };

  const saveFont = async () => {
    fontLoading = true;
    try {
      const currentAcct = activeEmail || getAliasEmail() || Local.get('email') || '';
      const family = await loadFont(fontChoice);
      currentFontFamily = family;
      await setSettingValue('font', fontChoice, { account: currentAcct });
      applyFont(family);
      toasts?.show?.('Font updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to load font', 'error');
      fontChoice = 'system';
      currentFontFamily = getFontFamily('system');
      applyFont(currentFontFamily);
    } finally {
      fontLoading = false;
    }
  };

  const saveComposePlainDefault = async () => {
    try {
      await setSettingValue('compose_plain_default', composePlainDefault, {
        account: getAccountId(),
      });
      toasts?.show?.('Composer default updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save composer default', 'error');
    }
  };

  const saveAttachmentReminder = async () => {
    try {
      await settingsActions.setAttachmentReminder(attachmentReminderEnabled);
      toasts?.show?.(
        attachmentReminderEnabled
          ? 'Attachment reminder enabled'
          : 'Attachment reminder disabled',
        'success'
      );
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save attachment reminder setting', 'error');
    }
  };

  const toggleBlockRemoteImages = () => {
    try {
      setSettingValue('block_remote_images', blockRemoteImages, { account: getAccountId() });
      toasts?.show?.(
        blockRemoteImages
          ? 'Remote images will be blocked for privacy'
          : 'Remote images will load automatically',
        'success'
      );
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to update image blocking setting', 'error');
    }
  };

  const toggleBlockTrackingPixels = () => {
    try {
      setSettingValue('block_tracking_pixels', blockTrackingPixels, { account: getAccountId() });
      toasts?.show?.(
        blockTrackingPixels
          ? 'Tracking pixels will be blocked'
          : 'Tracking pixels will load (not recommended)',
        'success'
      );
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to update tracking pixel setting', 'error');
    }
  };

  const saveMessagesPerPage = async () => {
    try {
      await setSettingValue('messages_per_page', messagesPerPage, {
        account: getAccountId(),
      });
      toasts?.show?.('Messages per page updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save messages per page', 'error');
    }
  };

  const saveArchiveFolder = async () => {
    try {
      await setSettingValue('archive_folder', archiveFolder || null, { account: getAccountId() });
      toasts?.show?.('Archive folder updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save archive folder', 'error');
    }
  };

  const saveSentFolder = async () => {
    try {
      await setSettingValue('sent_folder', sentFolder || null, { account: getAccountId() });
      toasts?.show?.('Sent folder updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save sent folder', 'error');
    }
  };

  const saveDraftsFolder = async () => {
    try {
      await setSettingValue('drafts_folder', draftsFolder || null, { account: getAccountId() });
      toasts?.show?.('Drafts folder updated', 'success');
    } catch (err) {
      toasts?.show?.((err as Error)?.message || 'Failed to save drafts folder', 'error');
    }
  };

  const resetSectionChanges = () => {
    const currentSection = section;
    loadFromStorage();
    section = currentSection || 'general';
  };

  const openNewKey = () => {
    keyFormVisible = true;
    editingIndex = -1;
    editingKeyName = '';
    editingKeyValue = '';
  };

  const editKey = (key: { name: string; value: string }) => {
    const idx = pgpKeys.indexOf(key);
    if (idx === -1) return;
    keyFormVisible = true;
    editingIndex = idx;
    editingKeyName = key.name || '';
    editingKeyValue = key.value || '';
  };

  const removeKey = (key: { name: string; value: string }) => {
    pgpKeys = pgpKeys.filter((k) => k !== key);
    const currentAcct = activeEmail || getAliasEmail() || Local.get('email') || '';
    Local.set(`pgp_keys_${currentAcct}`, JSON.stringify(pgpKeys));
    refreshSyncWorkerPgpKeys();
    clearPgpKeyCache();
    invalidatePgpCachedBodies(currentAcct);
  };

  const cancelKeyForm = () => {
    keyFormVisible = false;
    editingIndex = -1;
    editingKeyName = '';
    editingKeyValue = '';
  };

  const saveKey = () => {
    const name = (editingKeyName || '').trim();
    const value = (editingKeyValue || '').trim();
    if (!name || !value) {
      setError('Please provide a name and key.');
      return;
    }
    const keys = [...pgpKeys];
    if (editingIndex >= 0) {
      keys[editingIndex] = { name, value };
    } else {
      keys.push({ name, value });
    }
    pgpKeys = keys;
    const currentAcct = activeEmail || getAliasEmail() || Local.get('email') || '';
    Local.set(`pgp_keys_${currentAcct}`, JSON.stringify(pgpKeys));
    refreshSyncWorkerPgpKeys();
    clearPgpKeyCache();
    invalidatePgpCachedBodies(currentAcct);
    cancelKeyForm();
    setSuccess('Encryption key saved locally.');
  };

  const clearData = () => {
    Local.clear();
    navigate?.('/') ?? (window.location.href = '/');
  };

  const signOut = async () => {
    await mailboxSignOut();
  };

  const loadCacheStatistics = async () => {
    loadingCacheStats = true;
    try {
      const [stats, storage] = await Promise.all([
        cacheManager.getCacheStatistics(),
        cacheManager.getStorageInfo(),
      ]);
      cacheStats = stats;
      storageInfo = storage;
    } catch (err) {
      console.error('Failed to load cache statistics:', err);
      setError('Failed to load cache statistics');
    } finally {
      loadingCacheStats = false;
    }
  };

  const openRebuildConfirm = () => {
    clearAlerts();
    rebuildConfirmVisible = true;
  };

  const closeRebuildConfirm = () => {
    rebuildConfirmVisible = false;
  };

  const confirmRebuildIndex = async () => {
    if (rebuildingIndex) return;
    rebuildingIndex = true;
    try {
      await rebuildIndex();
      setSuccess('Search index rebuilt.');
      toasts?.show?.('Search index rebuilt', 'success');
    } catch (err) {
      setError((err as Error)?.message || 'Failed to rebuild index.');
      toasts?.show?.((err as Error)?.message || 'Failed to rebuild index.', 'error');
    } finally {
      rebuildingIndex = false;
      closeRebuildConfirm();
    }
  };

  const runHealthCheck = async () => {
    if (checkingHealth) return;
    checkingHealth = true;
    clearAlerts();
    try {
      await checkHealth();
      lastHealthCheck = new Date();
      toasts?.show?.('Health check complete', 'success');
    } catch (err) {
      setError((err as Error)?.message || 'Failed to check index health');
    } finally {
      checkingHealth = false;
    }
  };

  const runRebuildFromCache = async () => {
    if (rebuildingFromCache) return;
    rebuildingFromCache = true;
    clearAlerts();
    try {
      await rebuildFromCache();
      lastHealthCheck = new Date();
      setSuccess('Index rebuilt from cache');
      toasts?.show?.('Index rebuilt from cache', 'success');
    } catch (err) {
      setError((err as Error)?.message || 'Failed to rebuild from cache');
      toasts?.show?.((err as Error)?.message || 'Failed to rebuild from cache', 'error');
    } finally {
      rebuildingFromCache = false;
    }
  };

  const toggleBodyIndexingOption = async () => {
    const newValue = !bodyIndexingLocal;
    bodyIndexingLocal = newValue;
    toggleBodyIndexing?.(newValue);
    setSuccess(
      newValue
        ? 'Body indexing enabled. Rebuild your search index to apply this change.'
        : 'Body indexing disabled.',
    );
  };

  const formatKey = (key: string | string[] | undefined) => {
    if (!key) return '';
    try {
      return keyboardShortcuts.formatKey(key);
    } catch {
      if (Array.isArray(key)) return key.join(' + ');
      return String(key || '');
    }
  };

  const loadShortcuts = () => {
    shortcutsList = keyboardShortcuts.getShortcutsList();
  };

  const resetShortcuts = () => {
    clearAlerts();
    try {
      keyboardShortcuts.resetToDefaults();
      loadShortcuts();
      setSuccess('Keyboard shortcuts reset to defaults.');
      toasts?.show?.('Keyboard shortcuts reset to defaults', 'success');
    } catch (err) {
      setError((err as Error)?.message || 'Failed to reset shortcuts.');
      toasts?.show?.((err as Error)?.message || 'Failed to reset shortcuts.', 'error');
    }
  };

  let clearingCache = $state(false);
  const clearCacheAndReload = async () => {
    clearAlerts();
    if (clearingCache) return;

    clearingCache = true;
    try {
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.map((name) => caches.delete(name)));
      }

      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        if (registration) {
          await registration.update();
        }
      }

      setSuccess('Cache cleared. Reloading...');
      toasts?.show?.('Cache cleared. Reloading...', 'success');
      setTimeout(() => {
        window.location.reload();
      }, 500);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to clear cache.');
      toasts?.show?.((err as Error)?.message || 'Failed to clear cache.', 'error');
      clearingCache = false;
    }
  };

  const forceResetStorage = async () => {
    clearAlerts();
    const confirmed = window.confirm(
      'Reset the service worker and clear ALL local data (local storage + IndexedDB)? This will log you out and cannot be undone.',
    );
    if (!confirmed || resettingStorage) return;

    resettingStorage = true;
    try {
      try {
        await closeDatabase();
      } catch {
        /* ignore */
      }
      try {
        terminateDbWorker();
      } catch {
        /* ignore */
      }
      await unregisterServiceWorker();
      await forceDeleteAllDatabases();
      // Set a flag for the fallback-recovery.js to delete IndexedDB on next page load
      // (the database may still be blocked by open connections on this page)
      localStorage.setItem('webmail_pending_idb_cleanup', '1');
      // Clear ALL localStorage (not just webmail_ prefixed keys)
      localStorage.clear();
      localStorage.setItem('webmail_pending_idb_cleanup', '1');
      sessionStorage.clear();
      // Also deactivate demo mode (clears fe_demo_mode key)
      deactivateDemoMode();
      setSuccess('Service worker reset and local data cleared. Redirecting to login...');
      toasts?.show?.('Service worker reset and local data cleared. Redirecting to login...', 'success');
      setTimeout(() => {
        navigate?.('/') ?? (window.location.href = '/');
      }, 1000);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to force reset storage.');
      toasts?.show?.((err as Error)?.message || 'Failed to force reset storage.', 'error');
    } finally {
      resettingStorage = false;
    }
  };

  const sections = [
    { id: 'general', label: 'General' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'privacy', label: 'Privacy & Security' },
    { id: 'folders', label: 'Folders & Labels' },
    { id: 'search', label: 'Search' },
    { id: 'advanced', label: 'Advanced' },
    { id: 'shortcuts', label: 'Keyboard Shortcuts' },
    { id: 'help', label: 'About & Help' },
  ];
</script>

<div class="flex h-14 items-center gap-3 px-4">
  <Button variant="ghost" size="icon" onclick={() => window.history.back()} aria-label="Back">
    <ChevronLeft class="h-5 w-5" />
  </Button>
  <div class="flex flex-col">
    <h1 class="text-lg font-semibold">Settings</h1>
    <span class="text-xs text-muted-foreground">{aliasEmail}</span>
  </div>
</div>

{#if error}
  <Alert.Root variant="destructive" class="mx-4 mt-4">
    <AlertCircle class="h-4 w-4" />
    <Alert.Description>{error}</Alert.Description>
  </Alert.Root>
{/if}
{#if success}
  <Alert.Root class="mx-4 mt-4 border-green-500 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100">
    <CheckCircle class="h-4 w-4" />
    <Alert.Description>{success}</Alert.Description>
  </Alert.Root>
{/if}

<div class="flex flex-col md:flex-row h-[calc(100vh-3.5rem)]">
  <!-- Sidebar -->
  <aside class="hidden w-56 shrink-0 border-r border-border p-4 md:block">
    <nav class="flex flex-col gap-1">
      {#each sections as sec}
        <button
          type="button"
          class="px-3 py-2 text-left text-sm font-medium transition-colors {section === sec.id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
          onclick={() => {
            section = sec.id;
            history.replaceState(null, '', `#${sec.id}`);
            if (sec.id === 'folders') loadLabelsList();
            if (sec.id === 'advanced') loadCacheStatistics();
          }}
        >
          {sec.label}
        </button>
      {/each}
    </nav>
  </aside>

  <!-- Mobile Section Selector -->
  <div class="w-full md:hidden">
    <div class="border-b border-border p-4">
      <select
        class="w-full border border-input bg-background px-3 py-2 text-sm"
        bind:value={section}
        onchange={() => {
          history.replaceState(null, '', `#${section}`);
          if (section === 'folders') loadLabelsList();
          if (section === 'advanced') loadCacheStatistics();
        }}
      >
        {#each sections.filter(s => s.id !== 'shortcuts') as sec}
          <option value={sec.id}>{sec.label}</option>
        {/each}
      </select>
    </div>
  </div>

  <!-- Content -->
  <div class="flex-1 overflow-y-auto p-4 md:p-6">
    <div class="mx-auto max-w-4xl space-y-6">
      {#if section === 'general'}
        <Card.Root>
          <Card.Header>
            <Card.Title class="flex items-center gap-2">
              Your accounts
              <Tooltip.Provider>
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Info class="h-4 w-4 text-muted-foreground" />
                  </Tooltip.Trigger>
                  <Tooltip.Content>
                    Accounts are stored on this device only and are not synced.
                  </Tooltip.Content>
                </Tooltip.Root>
              </Tooltip.Provider>
            </Card.Title>
            <Card.Description>Manage linked mailboxes and identities.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-3">
            {#each $accounts as account}
              <div class="flex items-center justify-between border border-border p-3 {account.email === $currentAccount ? 'bg-primary/5' : ''}">
                <div class="flex items-center gap-3">
                  <User class="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div class="font-medium">{account.email}</div>
                    <div class="text-xs text-muted-foreground">
                      {account.email === $currentAccount ? 'Active account' : `Added ${new Date(account.addedAt).toLocaleDateString()}`}
                    </div>
                  </div>
                </div>
                {#if account.email === $currentAccount}
                  <Button variant="destructive" size="sm" onclick={signOut}>Sign out</Button>
                {:else}
                  <Button variant="ghost" size="sm" onclick={() => switchAccount(account)}>Switch to</Button>
                {/if}
              </div>
            {/each}
            <Button variant="outline" class="mt-4" onclick={() => navigate?.('/?add_account=true')}>
              <Plus class="mr-2 h-4 w-4" />
              Add account
            </Button>
          </Card.Content>
        </Card.Root>

        {#if storageTotalValue > 0}
          <Card.Root>
            <Card.Header>
              <Card.Title>Storage</Card.Title>
            </Card.Header>
            <Card.Content>
              <div class="space-y-2">
                <div class="flex justify-between text-sm">
                  <span>Storage</span>
                  <span>{storagePercentValue()}%</span>
                </div>
                <div class="h-2 w-full overflow-hidden bg-secondary">
                  <div class="h-full bg-primary transition-all" style="width: {storagePercentValue()}%"></div>
                </div>
                <div class="text-xs text-muted-foreground">
                  {formatStorageValue(storageUsedValue)} of {formatStorageValue(storageTotalValue)}
                </div>
              </div>
              <Button variant="outline" class="mt-4" onclick={() => window.open('https://forwardemail.net/my-account/billing', '_blank')}>
                Increase storage
              </Button>
            </Card.Content>
          </Card.Root>
        {/if}
      {/if}

      {#if section === 'appearance'}
        <Card.Root>
          <Card.Header>
            <Card.Title>Theme</Card.Title>
          </Card.Header>
          <Card.Content class="space-y-3">
            <div class="flex flex-wrap gap-4">
              <label class="flex items-center gap-2">
                <input type="radio" name="theme" value="system" bind:group={theme} onchange={saveTheme} class="accent-primary" />
                <span>Auto (follow system)</span>
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="theme" value="light" bind:group={theme} onchange={saveTheme} class="accent-primary" />
                <span>Light</span>
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="theme" value="dark" bind:group={theme} onchange={saveTheme} class="accent-primary" />
                <span>Dark</span>
              </label>
            </div>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Layout</Card.Title>
          </Card.Header>
          <Card.Content class="space-y-3">
            <div class="flex flex-col gap-2">
              <label class="flex items-center gap-2">
                <input type="radio" name="layout" value="full" bind:group={layoutModeChoice} onchange={saveLayoutMode} class="accent-primary" />
                <span>Full Screen (Recommended)</span>
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="layout" value="classic" bind:group={layoutModeChoice} onchange={saveLayoutMode} class="accent-primary" />
                <span>Classic View (vertical split)</span>
              </label>
            </div>
            <p class="text-sm text-muted-foreground">
              Full Screen: compact layout with full-screen reader; Classic: side-by-side message list and reader.
            </p>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Composer defaults</Card.Title>
          </Card.Header>
          <Card.Content class="space-y-4">
            <label class="flex items-center gap-3">
              <Checkbox bind:checked={composePlainDefault} onCheckedChange={saveComposePlainDefault} />
              <span>Use plain text by default</span>
            </label>
            <p class="text-sm text-muted-foreground">
              We'll remember this for new messages. You can still switch formats while composing.
            </p>
            <label class="flex items-center gap-3">
              <Checkbox bind:checked={attachmentReminderEnabled} onCheckedChange={saveAttachmentReminder} />
              <span>Remind me about attachments</span>
            </label>
            <p class="text-sm text-muted-foreground">
              Get a reminder if you mention attachments but forget to add them.
            </p>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Messages per page</Card.Title>
          </Card.Header>
          <Card.Content class="space-y-3">
            <div class="flex flex-wrap gap-4">
              <label class="flex items-center gap-2">
                <input type="radio" name="perpage" value={20} bind:group={messagesPerPage} onchange={saveMessagesPerPage} class="accent-primary" />
                <span>20 messages</span>
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="perpage" value={50} bind:group={messagesPerPage} onchange={saveMessagesPerPage} class="accent-primary" />
                <span>50 messages</span>
              </label>
              <label class="flex items-center gap-2">
                <input type="radio" name="perpage" value={100} bind:group={messagesPerPage} onchange={saveMessagesPerPage} class="accent-primary" />
                <span>100 messages</span>
              </label>
            </div>
            <p class="text-sm text-muted-foreground">
              Number of conversations to show per page. Higher values may impact performance.
            </p>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Font</Card.Title>
            <Card.Description>Choose a custom font for better readability. System default is fastest.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div class="space-y-2">
              <Label for="font-select">Typeface</Label>
              <select
                id="font-select"
                class="w-full border border-input bg-background px-3 py-2 text-sm"
                bind:value={fontChoice}
                onchange={saveFont}
                style="font-family: {currentFontFamily}"
              >
                {#each availableFonts as font}
                  <option value={font.key} style="font-family: {font.family}">{font.name}</option>
                {/each}
              </select>
            </div>
            {#if fontLoading}
              <p class="text-sm text-primary">Loading font...</p>
            {/if}
            {#if fontChoice !== 'system'}
              <div class="border border-border p-3" style="font-family: {currentFontFamily}">
                The quick brown fox jumps over the lazy dog.
                <strong>Bold text</strong> and regular text for email reading.
                <br />
                <span class="text-sm text-muted-foreground">Numbers: 0123456789 | Symbols: @#$%&*</span>
              </div>
            {/if}
          </Card.Content>
        </Card.Root>
      {/if}

      {#if section === 'privacy'}
        <!-- Default Email App (mailto handler) -->
        <MailtoSettings />

        <!-- App Lock section - above PGP encryption -->
        <AppLockSettings />

        <Card.Root>
          <Card.Header>
            <Card.Title>PGP encryption</Card.Title>
            <Card.Description>Signed in as <strong>{aliasEmail}</strong></Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted-foreground">PGP encryption keys</span>
              <Button variant="ghost" size="sm" onclick={openNewKey}>Add key</Button>
            </div>
            <div class="space-y-2">
              {#if pgpKeys.length === 0}
                <p class="text-sm text-muted-foreground">No keys added yet.</p>
              {/if}
              {#each pgpKeys as key, index (index)}
                <div class="flex items-center justify-between border border-border p-2">
                  <span class="font-medium">{key.name || 'Key'}</span>
                  <div class="flex gap-1">
                    <Button variant="ghost" size="icon" onclick={() => editKey(key)} aria-label="Edit">
                      <Pencil class="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onclick={() => removeKey(key)} aria-label="Remove">
                      <X class="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              {/each}
            </div>
            {#if keyFormVisible}
              <div class="space-y-3 border border-border p-4">
                <Input type="text" placeholder="Key name (e.g., Personal)" bind:value={editingKeyName} />
                <Textarea rows={6} placeholder="PGP private key (ASCII armor)" bind:value={editingKeyValue} />
                <div class="flex gap-2">
                  <Button variant="ghost" onclick={cancelKeyForm}>Cancel</Button>
                  <Button onclick={saveKey}>Save key</Button>
                </div>
                <p class="text-xs text-muted-foreground">
                  Stored locally only. Used to decrypt PGP-encrypted messages.
                </p>
              </div>
            {/if}
            <Button variant="ghost" onclick={clearData}>Clear saved data</Button>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Privacy</Card.Title>
            <Card.Description>Control how external content is handled in emails.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <label class="flex items-center gap-3">
              <Checkbox bind:checked={blockRemoteImages} onCheckedChange={toggleBlockRemoteImages} />
              <span>Block all external images by default</span>
            </label>
            <p class="text-sm text-muted-foreground">
              Blocks all external images from loading. You can still load images for individual emails.
            </p>
            <label class="flex items-center gap-3">
              <Checkbox bind:checked={blockTrackingPixels} onCheckedChange={toggleBlockTrackingPixels} />
              <span>Block tracking pixels</span>
            </label>
            <p class="text-sm text-muted-foreground">
              Blocks tiny invisible images used to track email opens.
            </p>
          </Card.Content>
        </Card.Root>
      {/if}

      {#if section === 'folders'}
        <Card.Root>
          <Card.Header>
            <Card.Title>Special Folders</Card.Title>
            <Card.Description>Configure which folders to use for archiving, sending, and drafting messages.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div class="space-y-2">
              <Label for="archive-folder">Archive folder</Label>
              <select id="archive-folder" class="w-full border border-input bg-background px-3 py-2 text-sm" bind:value={archiveFolder} onchange={saveArchiveFolder}>
                <option value="">Auto-detect (Archive)</option>
                {#each availableFolders as folder}
                  <option value={folder}>{folder}</option>
                {/each}
              </select>
            </div>
            <div class="space-y-2">
              <Label for="sent-folder">Sent folder</Label>
              <select id="sent-folder" class="w-full border border-input bg-background px-3 py-2 text-sm" bind:value={sentFolder} onchange={saveSentFolder}>
                <option value="">Auto-detect (Sent)</option>
                {#each availableFolders as folder}
                  <option value={folder}>{folder}</option>
                {/each}
              </select>
            </div>
            <div class="space-y-2">
              <Label for="drafts-folder">Drafts folder</Label>
              <select id="drafts-folder" class="w-full border border-input bg-background px-3 py-2 text-sm" bind:value={draftsFolder} onchange={saveDraftsFolder}>
                <option value="">Auto-detect (Drafts)</option>
                {#each availableFolders as folder}
                  <option value={folder}>{folder}</option>
                {/each}
              </select>
            </div>
            <p class="text-sm text-muted-foreground">
              Leave as "Auto-detect" to automatically find folders by standard names.
            </p>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Labels</Card.Title>
            <Card.Description>Manage labels for this account.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div class="flex items-center justify-between">
              <span class="text-sm text-muted-foreground">Your labels</span>
              <Button variant="ghost" size="sm" onclick={openCreateLabelModal}>Add label</Button>
            </div>
            <div class="space-y-2">
              {#if labelsLoading}
                <p class="text-sm text-muted-foreground">Loading labels...</p>
              {:else if labelsList && labelsList.length}
                {#each labelsList as label (getLabelKey(label))}
                  <div class="flex items-center justify-between border border-border p-2">
                    <div class="flex items-center gap-3">
                      <div class="h-4 w-4" style="background: {label.color || '#9ca3af'}"></div>
                      <div>
                        <div class="font-medium">{label.name || getLabelKey(label)}</div>
                        <div class="text-xs text-muted-foreground">
                          Keyword: <code class="bg-muted px-1">{getLabelKey(label)}</code>
                        </div>
                      </div>
                    </div>
                    <div class="flex gap-1">
                      <Button variant="ghost" size="icon" onclick={() => openEditLabelModal(label)} aria-label="Edit">
                        <Pencil class="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onclick={() => deleteLabel(label)} disabled={labelsDeleting === getLabelKey(label)} aria-label="Remove">
                        <X class="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                {/each}
              {:else}
                <p class="text-sm text-muted-foreground">No labels yet.</p>
              {/if}
            </div>
          </Card.Content>
        </Card.Root>
      {/if}

      {#if section === 'search'}
        <Card.Root>
          <Card.Header>
            <Card.Title>Search Indexing</Card.Title>
            <Card.Description>Control how your mailbox content is indexed for search.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <label class="flex items-center gap-3">
              <Checkbox checked={bodyIndexingLocal} onCheckedChange={toggleBodyIndexingOption} />
              <span>Index message bodies</span>
            </label>
            <p class="text-sm text-muted-foreground">
              When enabled, message content is indexed for full-text search.
            </p>
            <div class="bg-muted p-3 text-sm">
              <div>Indexed messages: {indexCountValue || 0}</div>
              <div>Index size: {Math.round(indexSizeValue / 1024 / 1024) || 0} MB</div>
            </div>
            <div class="flex gap-2">
              <Button variant="outline" onclick={openRebuildConfirm} disabled={rebuildingIndex}>
                Rebuild search index
              </Button>
              <Button variant="ghost" onclick={resetSectionChanges}>Reset</Button>
            </div>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Index health</Card.Title>
            <Card.Description>Monitor the health of your search index.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div class="p-3 {searchHealth.healthy ? 'bg-green-50 dark:bg-green-950' : 'bg-yellow-50 dark:bg-yellow-950'}">
              <div class="flex items-center gap-2 font-semibold {searchHealth.healthy ? 'text-green-600' : 'text-yellow-600'}">
                {#if searchHealth.healthy}
                  <CheckCircle class="h-4 w-4" />
                  Healthy
                {:else}
                  <AlertTriangle class="h-4 w-4" />
                  {searchHealth.needsRebuild ? 'Needs Rebuild' : 'Partial'}
                {/if}
              </div>
              <div class="mt-2 text-sm text-muted-foreground">
                <div>Messages in cache: {searchHealth.messagesCount || 0}</div>
                <div>Messages indexed: {searchHealth.indexCount || 0}</div>
                {#if searchHealth.divergence > 0}
                  <div>Missing from index: {searchHealth.divergence}</div>
                {/if}
                {#if lastHealthCheck}
                  <div>Last checked: {lastHealthCheck.toLocaleTimeString()}</div>
                {/if}
              </div>
            </div>
            <div class="flex gap-2">
              <Button variant="outline" onclick={runHealthCheck} disabled={checkingHealth}>
                {checkingHealth ? 'Checking...' : 'Check health'}
              </Button>
              {#if searchHealth.needsRebuild || searchHealth.divergence > 0}
                <Button variant="outline" onclick={runRebuildFromCache} disabled={rebuildingFromCache}>
                  {rebuildingFromCache ? 'Rebuilding...' : 'Rebuild from cache'}
                </Button>
              {/if}
            </div>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Saved searches</Card.Title>
            <Card.Description>Quickly re-run your frequent queries.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div class="space-y-3">
              <div class="space-y-2">
                <Label for="search-name">Name</Label>
                <Input id="search-name" placeholder="e.g. Invoices with attachments" bind:value={newSavedSearchName} />
              </div>
              <div class="space-y-2">
                <Label for="search-query">Query</Label>
                <Input id="search-query" placeholder="e.g. subject:invoice has:attachment" bind:value={newSavedSearchQuery} />
              </div>
              <div class="flex gap-2">
                <Button variant="outline" onclick={saveSavedSearch} disabled={savingSearch}>
                  {savingSearch ? 'Saving...' : 'Save search'}
                </Button>
                <Button variant="ghost" onclick={() => { newSavedSearchName = ''; newSavedSearchQuery = ''; }}>Clear</Button>
              </div>
            </div>
            {#if savedSearches && savedSearches.length}
              <div class="space-y-2">
                {#each savedSearches as saved}
                  <div class="flex items-center justify-between border border-border p-2">
                    <div>
                      <div class="font-medium">{saved.name}</div>
                      <div class="text-xs text-muted-foreground">{saved.query}</div>
                    </div>
                    <Button variant="ghost" size="sm" onclick={() => deleteSavedSearch(saved.name)} disabled={deletingSearch === saved.name}>
                      {deletingSearch === saved.name ? '...' : 'Delete'}
                    </Button>
                  </div>
                {/each}
              </div>
            {:else}
              <p class="text-sm text-muted-foreground">No saved searches yet.</p>
            {/if}
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <div class="flex items-center justify-between">
              <Card.Title>Search operators</Card.Title>
              <Button variant="ghost" size="sm" onclick={() => (showOperators = !showOperators)}>
                {showOperators ? 'Hide' : 'Show'}
              </Button>
            </div>
            <Card.Description>Quick reference for advanced search syntax.</Card.Description>
          </Card.Header>
          {#if showOperators}
            <Card.Content>
              <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {#each operatorHelp as op}
                  <div class="border border-border bg-muted/50 p-2">
                    <code class="rounded bg-muted px-1 text-sm">{op.label}</code>
                    <div class="mt-1 text-xs text-muted-foreground">{op.note}</div>
                  </div>
                {/each}
              </div>
            </Card.Content>
          {/if}
        </Card.Root>
      {/if}

      {#if section === 'advanced'}
        <Card.Root>
          <Card.Header>
            <Card.Title>Database Information</Card.Title>
            <Card.Description>View technical details about your local database.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-2 text-sm">
            <div><strong>Database Version:</strong> {databaseVersion || '—'}</div>
            <div><strong>Total Records:</strong> {databaseRecordCount || 0}</div>
            <div><strong>Queued Actions:</strong> {syncPendingValue || 0}</div>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Storage Usage</Card.Title>
            <Card.Description>Monitor local storage quota and usage.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            {#if loadingCacheStats}
              <p class="text-sm text-muted-foreground">Loading statistics...</p>
            {:else if storageInfo}
              <div class="space-y-2 text-sm">
                <div><strong>Total Usage:</strong> {storageInfo.usageFormatted || '—'} / {storageInfo.quotaFormatted || '—'} ({(storageInfo.percentage as number)?.toFixed(1) || 0}%)</div>
                <div><strong>Available:</strong> {storageInfo.availableFormatted || '—'}</div>
              </div>
              <div class="h-2 w-full overflow-hidden bg-secondary">
                <div class="h-full bg-primary transition-all" style="width: {(storageInfo.percentage as number) || 0}%"></div>
              </div>
              {#if (storageInfo.percentage as number) > 90}
                <Alert.Root variant="destructive">
                  <AlertTriangle class="h-4 w-4" />
                  <Alert.Description>Storage almost full! Consider clearing cache.</Alert.Description>
                </Alert.Root>
              {/if}
            {:else}
              <p class="text-sm text-muted-foreground">Unable to load storage information</p>
            {/if}
            <Button variant="outline" onclick={loadCacheStatistics} disabled={loadingCacheStats}>
              {loadingCacheStats ? 'Loading...' : 'Refresh Statistics'}
            </Button>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Performance Tracing</Card.Title>
            <Card.Description>Enable detailed performance logging for debugging.</Card.Description>
          </Card.Header>
          <Card.Content>
            <label class="flex items-center gap-3">
              <Checkbox checked={debugPerfEnabled} onCheckedChange={togglePerfLogging} />
              <span>Enable performance logs</span>
            </label>
            <p class="mt-2 text-sm text-muted-foreground">
              When enabled, console shows [perf] entries for request and message load stages.
            </p>
          </Card.Content>
        </Card.Root>

        <Card.Root class="border-destructive">
          <Card.Header>
            <Card.Title class="text-destructive">Danger Zone</Card.Title>
            <Card.Description>Use these options if you're experiencing issues with the app.</Card.Description>
          </Card.Header>
          <Card.Content class="space-y-4">
            <div>
              <Button variant="outline" onclick={clearCacheAndReload} disabled={clearingCache}>
                {clearingCache ? 'Clearing...' : 'Clear Cache & Reload'}
              </Button>
              <p class="mt-1 text-xs text-muted-foreground">
                Clears cached app files and reloads. You'll stay logged in.
              </p>
            </div>
            <div>
              <Button variant="destructive" onclick={forceResetStorage} disabled={resettingStorage}>
                {resettingStorage ? 'Resetting...' : 'Complete Reset'}
              </Button>
              <p class="mt-1 text-xs text-muted-foreground">
                <strong>WARNING:</strong> Clears all local data and logs you out.
              </p>
            </div>
          </Card.Content>
        </Card.Root>
      {/if}

      {#if section === 'shortcuts'}
        <Card.Root class="hidden md:block">
          <Card.Header>
            <Card.Title>Keyboard shortcuts</Card.Title>
            <Card.Description>Customize or review the shortcuts available throughout the app.</Card.Description>
          </Card.Header>
          <Card.Content>
            <div class="max-h-96 overflow-y-auto border border-border">
              <div class="sticky top-0 grid grid-cols-[1fr_auto] gap-4 border-b border-border bg-muted p-3 font-semibold">
                <span>Action</span>
                <span>Shortcut</span>
              </div>
              {#each shortcutsList as shortcut}
                <div class="grid grid-cols-[1fr_auto] gap-4 border-b border-border p-3 last:border-b-0">
                  <span>{shortcut.label}</span>
                  <code class="bg-muted px-2 py-1 text-sm">
                    {formatKey(shortcut.key || shortcut.keys || shortcut.originalKey) || '—'}
                  </code>
                </div>
              {/each}
            </div>
          </Card.Content>
        </Card.Root>
      {/if}

      {#if section === 'help'}
        <Card.Root>
          <Card.Header>
            <Card.Title>Send Feedback</Card.Title>
            <Card.Description>Report bugs, request features, or ask questions.</Card.Description>
          </Card.Header>
          <Card.Content>
            <Button onclick={() => feedbackModalOpen = true}>
              <MessageSquare class="mr-2 h-4 w-4" />
              Send Feedback
            </Button>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Documentation & Resources</Card.Title>
            <Card.Description>Learn more about features and how to use the webmail client.</Card.Description>
          </Card.Header>
          <Card.Content>
            <ul class="list-inside list-disc space-y-1 text-sm">
              <li><a href="https://forwardemail.net/faq" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">FAQ</a></li>
              <li><a href="https://forwardemail.net/guides" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">Guides</a></li>
              <li><a href="https://forwardemail.net/help" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">Help & Support</a></li>
              <li><a href="https://forwardemail.net/email-api" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">Email API Documentation</a></li>
            </ul>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Community & Contact</Card.Title>
            <Card.Description>Connect with us and the community.</Card.Description>
          </Card.Header>
          <Card.Content>
            <ul class="list-inside list-disc space-y-1 text-sm">
              <li><a href="https://github.com/forwardemail" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">GitHub</a></li>
              <li><a href="https://matrix.to/#/#forward-email:matrix.org" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">Matrix Chat</a></li>
              <li><a href="https://x.com/fwdemail" target="_blank" rel="noopener noreferrer" class="text-sky-500 hover:text-sky-400 hover:underline">X (Twitter)</a></li>
            </ul>
          </Card.Content>
        </Card.Root>

        <Card.Root>
          <Card.Header>
            <Card.Title>Version Information</Card.Title>
          </Card.Header>
          <Card.Content class="text-sm">
            <div><strong>App Version:</strong> {import.meta.env.VITE_PKG_VERSION || '0.0.0'}</div>
            <div><strong>Database Schema:</strong> v{databaseVersion}</div>
          </Card.Content>
        </Card.Root>
      {/if}
    </div>
  </div>
</div>

<LabelModal
  visible={labelModalVisible}
  mode={labelModalMode}
  keyword={labelModalKeyword}
  bind:name={labelModalName}
  bind:color={labelModalColor}
  palette={labelPalette}
  error={labelModalError}
  saving={labelModalSaving}
  onClose={closeLabelModal}
  onSave={saveLabelModal}
  onClearError={clearLabelModalError}
/>

<Dialog.Root bind:open={rebuildConfirmVisible}>
  <Dialog.Content class="sm:max-w-md">
    <Dialog.Header>
      <Dialog.Title>Rebuild index?</Dialog.Title>
      <Dialog.Description>
        This can take several minutes depending on mailbox size.
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" onclick={closeRebuildConfirm}>Cancel</Button>
      <Button onclick={confirmRebuildIndex} disabled={rebuildingIndex}>Rebuild</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

{#if feedbackModalOpen}
  <FeedbackModal onClose={() => feedbackModalOpen = false} />
{/if}
