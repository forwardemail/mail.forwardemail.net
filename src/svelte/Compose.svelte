<script lang="ts">
  import { tick, onMount, onDestroy } from 'svelte';
  import { writable } from 'svelte/store';
  import { Editor, Node, Extension } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import LinkBase from '@tiptap/extension-link';
  import Placeholder from '@tiptap/extension-placeholder';
  import Highlight from '@tiptap/extension-highlight';
  import Underline from '@tiptap/extension-underline';
  import TextStyle from '@tiptap/extension-text-style';
  import TextAlign from '@tiptap/extension-text-align';
  import Color from '@tiptap/extension-color';
  import FontFamily from '@tiptap/extension-font-family';
  import Image from '@tiptap/extension-image';

  // Custom FontSize extension to add fontSize support to TextStyle
  const FontSize = Extension.create({
    name: 'fontSize',
    addOptions() {
      return {
        types: ['textStyle'],
      };
    },
    addGlobalAttributes() {
      return [
        {
          types: this.options.types,
          attributes: {
            fontSize: {
              default: null,
              parseHTML: (element) => element.style.fontSize?.replace(/['"]+/g, ''),
              renderHTML: (attributes) => {
                if (!attributes.fontSize) {
                  return {};
                }
                return {
                  style: `font-size: ${attributes.fontSize}`,
                };
              },
            },
          },
        },
      ];
    },
    addCommands() {
      return {
        setFontSize:
          (fontSize: string) =>
          ({ chain }) => {
            return chain().setMark('textStyle', { fontSize }).run();
          },
        unsetFontSize:
          () =>
          ({ chain }) => {
            return chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run();
          },
      };
    },
  });

  // Custom Link extension that doesn't extend to new text typed after a link
  const Link = LinkBase.extend({
    inclusive: false,
  });

  import Table from '@tiptap/extension-table';
  import TableRow from '@tiptap/extension-table-row';
  import TableCell from '@tiptap/extension-table-cell';
  import TableHeader from '@tiptap/extension-table-header';
  import { bufferToDataUrl, extractTextContent } from '../utils/mime-utils.js';
  import { Remote } from '../utils/remote';
  import { getContacts, mergeRecentAddresses } from '../utils/contact-cache';
  import { Local } from '../utils/storage';
  import { db } from '../utils/db';
  import { getMessageApiId } from '../utils/sync-helpers';
  import { extractDisplayName, isValidEmail } from '../utils/address.ts';
  import { queueEmail } from '../utils/outbox-service';
  import { saveSentCopy } from '../utils/sent-copy.js';
  import { parseMailto, mailtoToPrefill } from '../utils/mailto';
  import {
    saveDraft,
    getDraft,
    deleteDraft,
    listDrafts,
    createAutosaveTimer,
  } from '../utils/draft-service';
  import { shouldShowAttachmentReminder } from '../utils/attachment-reminder';
  import { attachmentReminder, getEffectiveSettingValue, profileName } from '../stores/settingsStore';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Label } from '$lib/components/ui/label';
  import { Badge } from '$lib/components/ui/badge';
  import * as Dialog from '$lib/components/ui/dialog';
  import * as Alert from '$lib/components/ui/alert';
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
  import * as Tooltip from '$lib/components/ui/tooltip';
  import { Separator } from '$lib/components/ui/separator';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import Send from '@lucide/svelte/icons/send';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Save from '@lucide/svelte/icons/save';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import Minus from '@lucide/svelte/icons/minus';
  import Maximize2 from '@lucide/svelte/icons/maximize-2';
  import Minimize2 from '@lucide/svelte/icons/minimize-2';
  import X from '@lucide/svelte/icons/x';
  import MoreVertical from '@lucide/svelte/icons/more-vertical';
  import Clock from '@lucide/svelte/icons/clock';
  import Link2 from '@lucide/svelte/icons/link-2';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Smile from '@lucide/svelte/icons/smile';
  import Type from '@lucide/svelte/icons/type';
  import Bold from '@lucide/svelte/icons/bold';
  import Italic from '@lucide/svelte/icons/italic';
  import UnderlineIcon from '@lucide/svelte/icons/underline';
  import List from '@lucide/svelte/icons/list';
  import ListOrdered from '@lucide/svelte/icons/list-ordered';
  import Quote from '@lucide/svelte/icons/quote';
  import Code from '@lucide/svelte/icons/code';
  import AlignLeft from '@lucide/svelte/icons/align-left';
  import AlignCenter from '@lucide/svelte/icons/align-center';
  import AlignRight from '@lucide/svelte/icons/align-right';
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle';
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import RemoveFormatting from '@lucide/svelte/icons/remove-formatting';

  interface ToastApi {
    show?: (message: string, type?: string) => void;
  }

  interface ComposeApi {
    open?: (options?: unknown) => void;
    close?: () => void;
    reply?: (options?: unknown) => void;
    forward?: (options?: unknown) => void;
    setContacts?: (list?: unknown[]) => void;
    setToList?: (list?: unknown[]) => void;
    isVisible?: () => boolean;
    isMinimized?: () => boolean;
    saveDraft?: () => void;
    updateReplyBody?: (body?: string, options?: { focusTop?: boolean }) => void;
    visibility?: { subscribe: (fn: (val: boolean) => void) => () => void };
  }

  interface Props {
    toasts?: ToastApi | null;
    registerApi?: (api: ComposeApi) => void;
    onSent?: (result?: unknown) => void;
  }

  let { toasts = null, registerApi = () => {}, onSent = () => {} }: Props = $props();

  let visible = $state(false);
  const visibility = writable(false);
  let expanded = $state(false);
  let minimized = $state(false);
  const minimizedState = writable(false);
  let compact = $state(false);
  const compactState = writable(false);
  let showMobileMenu = $state(false);
  let showScheduleModal = $state(false);
  let showSendDropdown = $state(false);
  let showScheduleConfirm = $state(false);
  let scheduleDate = $state('');
  let scheduleTime = $state('');
  let scheduleMeridiem = $state<'AM' | 'PM'>('AM');
  let showScheduleTimePicker = $state(false);
  let fromAddress = $state('');
  let toInput = $state('');
  let ccInput = $state('');
  let bccInput = $state('');
  let subject = $state('');
  let body = $state('');
  const getPlainTextDefault = () => Boolean(getEffectiveSettingValue('compose_plain_default'));
  let isPlainText = $state(getPlainTextDefault());
  let sending = $state(false);
  let error = $state('');
  let success = $state('');
  let attachments = $state<unknown[]>([]);
  let attachmentError = $state('');
  let attachmentLoading = $state(0);
  let showEmoji = $state(false);
  let showLinkModal = $state(false);
  let linkUrl = $state('');
  let savedLinkSelection = $state<{ from: number; to: number } | null>(null);
  let showAttachmentReminderModal = $state(false);
  let attachmentReminderKeyword = $state('');
  let showDiscardModal = $state(false);
  let showCc = $state(false);
  let showBcc = $state(false);
  let showReplyTo = $state(false);
  let linkInputEl = $state<HTMLInputElement | undefined>();
  let subjectInputEl = $state<HTMLInputElement | undefined>();
  let plainTextInputEl = $state<HTMLTextAreaElement | undefined>();
  let lastFocusedField = $state('to');
  const MAX_MINIMIZED_DRAFTS = 3;
  let minimizedDrafts = $state<unknown[]>([]);
  let activeDraftKey = $state<string | null>(null);
  let minimizedDraftSequence = 0;
  const IMAGE_EXTENSIONS = new Set([
    'apng', 'avif', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'png', 'svg', 'tiff', 'webp',
  ]);

  const getAttachmentName = (att: unknown) => (att as Record<string, unknown>)?.name || (att as Record<string, unknown>)?.filename || 'Attachment';

  const formatAttachmentSize = (bytes = 0) => {
    if (!bytes) return '0 KB';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const isImageAttachment = (att: unknown) => {
    const type = (att as Record<string, unknown>)?.contentType || (att as Record<string, unknown>)?.mimeType || (att as Record<string, unknown>)?.type || '';
    if ((type as string).startsWith('image/')) return true;
    const name = (getAttachmentName(att) as string).toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return ext ? IMAGE_EXTENSIONS.has(ext) : false;
  };

  const getAttachmentPreviewUrl = (att: unknown) => {
    if (!isImageAttachment(att)) return '';
    return bufferToDataUrl(att);
  };

  const getAttachmentBadge = (att: unknown) => {
    if (isImageAttachment(att)) return 'IMG';
    const name = getAttachmentName(att) as string;
    const ext = name.includes('.') ? name.split('.').pop() : '';
    return ext ? ext.slice(0, 4).toUpperCase() : 'FILE';
  };

  const attachmentCards = $derived(attachments.map((att: unknown) => ({
    att,
    name: getAttachmentName(att),
    sizeLabel: formatAttachmentSize((att as { size?: number })?.size || 0),
    isImage: isImageAttachment(att),
    previewUrl: getAttachmentPreviewUrl(att),
    badge: getAttachmentBadge(att),
  })));

  let focusedField = $state('to');
  let contactOptions = $state<unknown[]>([]);
  let editorView = $state<Editor | null>(null);

  const ImageWithSize = Image.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        width: { default: null },
        height: { default: null },
      };
    },
  });

  const encodeRawHtml = (value: string) => {
    if (!value) return '';
    try {
      return btoa(unescape(encodeURIComponent(value)));
    } catch {
      return '';
    }
  };

  const decodeRawHtml = (value: string) => {
    if (!value) return '';
    try {
      return decodeURIComponent(escape(atob(value)));
    } catch {
      return '';
    }
  };

  const RawHtmlQuote = Node.create({
    name: 'rawHtmlQuote',
    priority: 1000,
    group: 'block',
    atom: true,
    selectable: true,
    draggable: false,
    isolating: true,
    addAttributes() {
      return {
        raw: { default: '' },
        variant: { default: 'reply' },
      };
    },
    parseHTML() {
      return [
        {
          tag: 'blockquote[data-raw-html]',
          priority: 1000,
          getAttrs: (dom: HTMLElement) => ({
            raw: dom.getAttribute('data-raw-html') || '',
            variant: dom.getAttribute('data-raw-variant') || 'reply',
          }),
        },
      ];
    },
    renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
      const { raw, variant, ...rest } = HTMLAttributes;
      const classes = ['raw-quote', variant === 'forward' ? 'forward-quote' : 'reply-quote'].filter(Boolean).join(' ');
      return [
        'blockquote',
        { ...rest, class: classes, 'data-raw-html': raw || '', 'data-raw-variant': variant || 'reply' },
      ];
    },
    addNodeView() {
      return ({ node }: { node: { type: unknown; attrs: Record<string, unknown> } }) => {
        let currentNode = node;
        const dom = document.createElement('blockquote');
        const inner = document.createElement('div');
        inner.className = 'raw-quote-inner';
        dom.setAttribute('contenteditable', 'false');
        dom.appendChild(inner);
        const render = () => {
          const variant = currentNode.attrs.variant || 'reply';
          dom.className = ['raw-quote', variant === 'forward' ? 'forward-quote' : 'reply-quote'].filter(Boolean).join(' ');
          dom.setAttribute('data-raw-html', (currentNode.attrs.raw as string) || '');
          dom.setAttribute('data-raw-variant', variant as string);
          try {
            const decoded = decodeRawHtml((currentNode.attrs.raw as string) || '');
            if (decoded && isValidDecodedHtml(decoded)) {
              inner.innerHTML = decoded;
            } else {
              inner.innerHTML = '';
              inner.textContent = extractRawQuoteText((currentNode.attrs.raw as string) || '') || '';
            }
          } catch {
            inner.innerHTML = '';
            inner.textContent = '';
          }
        };
        render();
        return {
          dom,
          update: (updatedNode: { type: unknown; attrs: Record<string, unknown> }) => {
            if (updatedNode.type !== currentNode.type) return false;
            currentNode = updatedNode;
            render();
            return true;
          },
        };
      };
    },
  });

  let editorReady = $state(false);
  let mailtoData = $state<unknown>(null);
  let replyTo = $state('');
  let inReplyTo = $state('');
  let toInputEl = $state<HTMLInputElement | undefined>();
  let ccInputEl = $state<HTMLInputElement | undefined>();
  let bccInputEl = $state<HTMLInputElement | undefined>();
  let replyToInputEl = $state<HTMLInputElement | undefined>();
  let emojiPickerLoaded = $state(false);
  let emojiPickerRef = $state<HTMLElement | undefined>();
  let emojiButtonRef = $state<HTMLElement | undefined>();
  let toList = $state<string[]>([]);
  let ccList = $state<string[]>([]);
  let bccList = $state<string[]>([]);
  let showAddressBook = $state<'to' | 'cc' | 'bcc' | 'replyTo' | null>(null);
  let recipientSuggestions = $state<unknown[]>([]);
  let recipientSuggestionField = $state<string | null>(null);
  let recipientSuggestionQuery = $state('');
  let recipientSuggestionIndex = $state(-1);
  let contactOptionsLoaded = $state(false);
  let contactOptionsLoading = $state(false);
  let contactOptionsLoadPromise: Promise<unknown> | null = null;
  let currentDraftId = $state<string | null>(null);
  let currentDraftServerId = $state<string | null>(null);
  let currentDraftSyncedAt = $state<number | null>(null);
  // Track server message ID when editing a draft from the Drafts folder (not a local draft)
  let sourceMessageId = $state<string | null>(null);
  let lastSavedAt = $state<number | null>(null);
  let autosaveTimer: {
    start: () => void;
    stop: () => void;
    saveNow: () => Promise<unknown>;
    markDirty: () => void;
    resetHash: () => void;
  } | null = null;
  let composeOpenedAt = 0;
  let draftStatus = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
  let draftStatusDetail = $state('');
  let replyBodyLoading = $state(false);
  let replyBodyError = $state<string | null>(null);
  let pendingReplyBody = $state('');
  let replyPrefillData = $state<unknown>(null);
  let showFormatMenu = $state(false);
  let showFormatAdvanced = $state(false);
  let formatMenuRef = $state<HTMLElement | undefined>();
  let formatButtonRef = $state<HTMLElement | undefined>();
  let fontFamily = $state('default');
  let fontSize = $state('16');
  let textColor = $state(typeof document !== 'undefined' && document.documentElement.classList.contains('dark') ? '#e5e7eb' : '#000000');
  let highlightColor = $state('#fef08a');
  let alignment = $state<'left' | 'center' | 'right'>('left');

  const FONT_FAMILIES = [
    { value: 'default', label: 'Default' },
    { value: 'Georgia, serif', label: 'Georgia' },
    { value: '"Times New Roman", serif', label: 'Times' },
    { value: 'Garamond, serif', label: 'Garamond' },
    { value: '"Courier New", monospace', label: 'Courier' },
    { value: 'Monaco, monospace', label: 'Monaco' },
  ];

  const FONT_SIZES = ['12', '14', '16', '18', '20', '24', '32'];

  const scheduleTimeOptions = Array.from({ length: 12 * 4 }, (_, idx) => {
    const hour12 = Math.floor(idx / 4) + 1;
    const minute = (idx % 4) * 15;
    const m = String(minute).padStart(2, '0');
    const h = String(hour12).padStart(2, '0');
    return { display: `${hour12}:${m}`, value: `${h}:${m}` };
  });

  const to24Hour = (hhmm: string, meridiem = 'AM') => {
    if (!hhmm) return '';
    const [hStr, m = '00'] = hhmm.split(':');
    let h = parseInt(hStr, 10);
    if (Number.isNaN(h)) return '';
    if (meridiem === 'PM' && h < 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m.padStart(2, '0')}`;
  };

  const getScheduledTimestamp = () => {
    if (!scheduleDate || !scheduleTime) return null;
    const time24 = to24Hour(scheduleTime, scheduleMeridiem);
    const dateTimeStr = `${scheduleDate}T${time24}:00`;
    const dt = new Date(dateTimeStr);
    return dt.getTime();
  };

  const formatRfc3339 = (value: Date | number) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  };

  const initScheduleDefaults = () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const year = tomorrow.getFullYear();
    const month = String(tomorrow.getMonth() + 1).padStart(2, '0');
    const day = String(tomorrow.getDate()).padStart(2, '0');
    scheduleDate = `${year}-${month}-${day}`;
    scheduleTime = '09:00';
    scheduleMeridiem = 'AM';
  };

  const parseTimeInput = (value: string) => {
    if (!value) return null;
    const cleaned = value.trim().toLowerCase();
    let meridiem: string | null = null;
    let timeStr = cleaned;
    if (cleaned.includes('am')) {
      meridiem = 'AM';
      timeStr = cleaned.replace(/\s*am\s*/i, '');
    } else if (cleaned.includes('pm')) {
      meridiem = 'PM';
      timeStr = cleaned.replace(/\s*pm\s*/i, '');
    }
    const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!match) return null;
    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (!meridiem) {
      if (hour === 0) { meridiem = 'AM'; hour = 12; }
      else if (hour < 12) { meridiem = 'AM'; }
      else if (hour === 12) { meridiem = 'PM'; }
      else { meridiem = 'PM'; hour = hour - 12; }
    } else {
      if (hour === 0) hour = 12;
      if (hour > 12) hour = hour - 12;
    }
    const h = String(hour).padStart(2, '0');
    const m = String(minute).padStart(2, '0');
    return { time: `${h}:${m}`, meridiem };
  };

  const handleTimeInputBlur = () => {
    const parsed = parseTimeInput(scheduleTime);
    if (parsed) {
      scheduleTime = parsed.time;
      scheduleMeridiem = parsed.meridiem as 'AM' | 'PM';
    }
    showScheduleTimePicker = false;
  };

  const validateEmailContent = () => {
    const toRecipients = toList.length ? toList : parseRecipients(toInput);
    const ccRecipients = ccList.length ? ccList : parseRecipients(ccInput);
    const bccRecipients = bccList.length ? bccList : parseRecipients(bccInput);
    if (!toRecipients.length && !ccRecipients.length && !bccRecipients.length) {
      return { valid: false, error: 'Please add at least one recipient.' };
    }
    if (!subject.trim()) {
      return { valid: false, error: 'Please add a subject.' };
    }
    const bodyContent = body.trim();
    const textContent = bodyContent.replace(/<[^>]*>/g, '').trim();
    const rawQuoteText = extractRawQuoteText(bodyContent);
    const combinedText = [textContent, rawQuoteText].filter(Boolean).join(' ').trim();
    if (!combinedText) {
      return { valid: false, error: 'Please add email content.' };
    }
    return { valid: true, error: '' };
  };

  const openScheduleModal = () => {
    const validation = validateEmailContent();
    if (!validation.valid) {
      error = validation.error;
      return;
    }
    error = '';
    initScheduleDefaults();
    showScheduleModal = true;
  };

  const closeScheduleModal = () => {
    showScheduleModal = false;
    showScheduleConfirm = false;
    showScheduleTimePicker = false;
  };

  const getScheduleDisplayInfo = () => {
    const sendAt = getScheduledTimestamp();
    if (!sendAt) return null;
    const scheduledDate = new Date(sendAt);
    const toRecipients = toList.length ? toList : parseRecipients(toInput);
    return {
      date: scheduledDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }),
      time: scheduledDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      recipients: toRecipients.join(', '),
      subject: subject || '(No subject)',
    };
  };

  const proceedToScheduleConfirm = () => {
    const validation = validateEmailContent();
    if (!validation.valid) {
      error = validation.error;
      return;
    }
    const sendAt = getScheduledTimestamp();
    if (!sendAt || sendAt <= Date.now()) {
      error = 'Please select a future date and time.';
      return;
    }
    error = '';
    showScheduleConfirm = true;
  };

  const backToSchedulePicker = () => {
    showScheduleConfirm = false;
  };

  const getTodayDateString = () => {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const normalizeContact = (contact: unknown) => {
    if (!contact) return null;
    if (typeof contact === 'string') {
      const email = contact.trim();
      return email ? { email, name: '' } : null;
    }
    const c = contact as Record<string, unknown>;
    const email = ((c.email || c.address || c.value || c.text || '') as string).trim();
    const name = ((c.name || c.full_name || c.FullName || '') as string).trim();
    return email ? { email, name } : null;
  };

  const normalizeContactList = (list: unknown[]) =>
    Array.isArray(list) ? list.map(normalizeContact).filter(Boolean) : [];

  const splitRecipientTokens = (value: string) => {
    if (!value) return [];
    const segments = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    const results: string[] = [];
    for (const seg of segments) {
      // Angle-bracket format: "Display Name <email>"
      const angleMatch = seg.match(/<([^>]+@[^>]+)>/);
      if (angleMatch) {
        results.push(angleMatch[1].trim());
        continue;
      }
      // Find an email anywhere in the segment
      const emailMatch = seg.match(/([^\s<>]+@[^\s<>]+\.[^\s<>]+)/);
      if (emailMatch) {
        results.push(emailMatch[1].trim());
        continue;
      }
      // No email found — keep raw tokens (space-split) for validation later
      const parts = seg.split(/\s+/).filter(Boolean);
      results.push(...parts);
    }
    return results;
  };

  const handleRecipientDelimitedInput = (field: string, rawValue: string) => {
    if (!rawValue || !/[,\s]/.test(rawValue)) {
      return { handled: false, remaining: rawValue || '' };
    }
    const endsWithDelimiter = /[,\s]$/.test(rawValue);
    const tokens = splitRecipientTokens(rawValue);
    if (!tokens.length) return { handled: false, remaining: '' };
    if (field === 'replyTo') {
      replyTo = tokens[0] || '';
      if (replyTo) markDraftDirty();
      clearRecipientSuggestions();
      subjectInputEl?.focus();
      return { handled: true, remaining: '' };
    }
    const tokensToAdd = endsWithDelimiter ? tokens : tokens.slice(0, -1);
    const remaining = endsWithDelimiter ? '' : tokens[tokens.length - 1] || '';
    if (!tokensToAdd.length) {
      return { handled: false, remaining };
    }
    const listRef = field === 'to' ? toList : field === 'cc' ? ccList : bccList;
    const existing = new Set(listRef);
    tokensToAdd.forEach((token) => existing.add(token));
    const updated = Array.from(existing);
    if (field === 'to') {
      toList = updated;
      toInput = remaining;
    } else if (field === 'cc') {
      ccList = updated;
      ccInput = remaining;
    } else {
      bccList = updated;
      bccInput = remaining;
    }
    markDraftDirty();
    clearRecipientSuggestions();
    return { handled: true, remaining };
  };

  const parseVCardBasics = (content: string) => {
    if (!content) return { emails: [] as string[], name: '' };
    const parsed: { emails: string[]; name?: string } = { emails: [] };
    const rawLines = content.split(/\r?\n/);
    const lines: string[] = [];
    for (const line of rawLines) {
      if (!line) continue;
      if (/^[ \t]/.test(line) && lines.length) {
        lines[lines.length - 1] += line.trimStart();
      } else {
        lines.push(line);
      }
    }
    const unescapeText = (value: string) =>
      value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    for (const line of lines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const keyPart = line.slice(0, colonIndex);
      const value = unescapeText(line.slice(colonIndex + 1));
      const key = keyPart.split(';')[0].toUpperCase();
      if (key === 'FN' && !parsed.name) {
        parsed.name = value;
      } else if (key === 'N' && !parsed.name) {
        const [last, first, additional, prefix, suffix] = value.split(';');
        const parts = [prefix, first, additional, last, suffix].filter(Boolean);
        if (parts.length) parsed.name = parts.join(' ').replace(/\s+/g, ' ').trim();
      } else if (key === 'EMAIL' && value) {
        parsed.emails.push(value);
      }
    }
    return parsed;
  };

  const normalizeContactApiItem = (contact: unknown) => {
    if (!contact) return null;
    const c = contact as Record<string, unknown>;
    const vcard = parseVCardBasics((c.content as string) || '');
    const email = ((c.emails as { value?: string }[])?.[0]?.value) || ((c.Emails as { value?: string }[])?.[0]?.value) || (c.email as string) || (c.address as string) || vcard.emails?.[0] || '';
    const name = (c.full_name || c.name || c.FullName || vcard.name || '') as string;
    const trimmedEmail = (email || '').trim();
    if (!trimmedEmail) return null;
    return { email: trimmedEmail, name: (name || '').trim() };
  };

  const loadContactOptions = async () => {
    if (contactOptionsLoaded) return contactOptions;
    if (contactOptionsLoadPromise) return contactOptionsLoadPromise;
    contactOptionsLoading = true;
    contactOptionsLoadPromise = (async () => {
      try {
        // Use the contact cache — returns IDB-cached contacts instantly,
        // refreshes from API in the background if stale.
        const cached = await getContacts();
        if (cached.length) {
          contactOptions = cached as unknown[];
          contactOptionsLoaded = true;
          return contactOptions;
        }
        // Fallback to direct API call if cache was empty
        const res = await Remote.request('Contacts', { limit: 500 });
        const list = Array.isArray(res) ? res : (res as Record<string, unknown>)?.Result || (res as Record<string, unknown>)?.contacts || [];
        const mapped = (list || []).map(normalizeContactApiItem).filter(Boolean);
        mapped.sort((a, b) => {
          const nameA = ((a as {name?: string; email?: string}).name || (a as {email?: string}).email || '').toLowerCase();
          const nameB = ((b as {name?: string; email?: string}).name || (b as {email?: string}).email || '').toLowerCase();
          return nameA.localeCompare(nameB);
        });
        contactOptions = mapped as unknown[];
        contactOptionsLoaded = true;
        return contactOptions;
      } catch (err) {
        console.warn('[Compose] Failed to load contacts for autocomplete:', err);
        contactOptionsLoaded = true;
        contactOptions = [];
        return contactOptions;
      } finally {
        contactOptionsLoading = false;
        contactOptionsLoadPromise = null;
      }
    })();
    return contactOptionsLoadPromise;
  };

  const getRecipientInputValue = (field: string) => {
    if (field === 'to') return toInput;
    if (field === 'cc') return ccInput;
    if (field === 'bcc') return bccInput;
    if (field === 'replyTo') return replyTo;
    return '';
  };

  const getRecipientList = (field: string) => {
    if (field === 'to') return toList;
    if (field === 'cc') return ccList;
    if (field === 'bcc') return bccList;
    return [];
  };

  const clearRecipientSuggestions = () => {
    recipientSuggestions = [];
    recipientSuggestionField = null;
    recipientSuggestionQuery = '';
    recipientSuggestionIndex = -1;
    showAddressBook = null;
  };

  const updateRecipientSuggestions = (field: string, rawValue?: string) => {
    const query = (rawValue ?? getRecipientInputValue(field) ?? '').trim();
    if (!query) {
      clearRecipientSuggestions();
      return;
    }
    if (!contactOptions.length && !contactOptionsLoaded && !contactOptionsLoading) {
      loadContactOptions().then(() => {
        updateRecipientSuggestions(field, query);
      });
      return;
    }
    const contacts = normalizeContactList(contactOptions);
    if (!contacts.length) {
      clearRecipientSuggestions();
      return;
    }
    const queryLower = query.toLowerCase();
    const existing = new Set(getRecipientList(field).map((entry) => entry.toLowerCase()));
    const seen = new Set<string>();
    recipientSuggestions = contacts
      .filter((contact) => {
        const c = contact as { email: string; name: string };
        const email = (c.email || '').trim();
        if (!email) return false;
        const emailLower = email.toLowerCase();
        if (existing.has(emailLower) || seen.has(emailLower)) return false;
        const nameLower = (c.name || '').toLowerCase();
        const matches = emailLower.includes(queryLower) || nameLower.includes(queryLower);
        if (!matches) return false;
        seen.add(emailLower);
        return true;
      })
      .slice(0, 8);
    if (recipientSuggestionField !== field || recipientSuggestionQuery !== query) {
      recipientSuggestionIndex = -1;
    }
    recipientSuggestionField = field;
    recipientSuggestionQuery = query;
    showAddressBook = field as 'to' | 'cc' | 'bcc' | 'replyTo';
  };

  const hasRecipientSuggestions = (field: string) =>
    recipientSuggestionField === field && showAddressBook === field && recipientSuggestions.length > 0;

  const handleRecipientSuggestionKeydown = (field: string, event: KeyboardEvent) => {
    if (!hasRecipientSuggestions(field)) return true;
    const lastIndex = recipientSuggestions.length - 1;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      recipientSuggestionIndex = recipientSuggestionIndex < lastIndex ? recipientSuggestionIndex + 1 : 0;
      return false;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      recipientSuggestionIndex = recipientSuggestionIndex > 0 ? recipientSuggestionIndex - 1 : lastIndex;
      return false;
    }
    if (event.key === 'Enter' && recipientSuggestionIndex >= 0) {
      event.preventDefault();
      applyRecipientSuggestion(field, recipientSuggestions[recipientSuggestionIndex]);
      return false;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      clearRecipientSuggestions();
      return false;
    }
    return true;
  };

  const applyRecipientSuggestion = (field: string, contact: unknown) => {
    const c = contact as { email: string; name: string };
    const email = c?.email || '';
    if (!email) return;
    if (field === 'to') {
      if (!toList.includes(email)) toList = [...toList, email];
      toInput = '';
    } else if (field === 'cc') {
      if (!ccList.includes(email)) ccList = [...ccList, email];
      ccInput = '';
    } else if (field === 'bcc') {
      if (!bccList.includes(email)) bccList = [...bccList, email];
      bccInput = '';
    } else if (field === 'replyTo') {
      replyTo = email;
    }
    markDraftDirty();
    clearRecipientSuggestions();
  };

  const removeRecipient = (field: string, rec: string) => {
    if (field === 'to') toList = toList.filter((r) => r !== rec);
    else if (field === 'cc') ccList = ccList.filter((r) => r !== rec);
    else if (field === 'bcc') bccList = bccList.filter((r) => r !== rec);
    markDraftDirty();
  };

  const editRecipient = (field: string, rec: string) => {
    removeRecipient(field, rec);
    if (field === 'to') { toInput = rec; toInputEl?.focus(); }
    else if (field === 'cc') { ccInput = rec; ccInputEl?.focus(); }
    else if (field === 'bcc') { bccInput = rec; bccInputEl?.focus(); }
  };

  const parseRecipients = (value: string) =>
    (value || '').split(/[,;]/).map((r) => r.trim()).filter(Boolean);

  const onRecipientFocus = (field: string) => {
    focusedField = field;
    lastFocusedField = field;
    loadContactOptions();
    updateRecipientSuggestions(field);
  };

  const onRecipientInput = (field: string, event: Event) => {
    const target = event.target as HTMLInputElement;
    const rawValue = target?.value || '';
    const result = handleRecipientDelimitedInput(field, rawValue);
    if (!result.handled) {
      updateRecipientSuggestions(field, rawValue);
    }
    markDraftDirty();
  };

  const handleRecipientBlur = (field: string) => {
    setTimeout(() => {
      if (!document.activeElement?.closest('.contact-suggestions')) {
        clearRecipientSuggestions();
      }
      // Get the current input value for this field
      const inputValue = field === 'to' ? toInput : field === 'cc' ? ccInput : bccInput;
      if (inputValue.trim()) {
        const tokens = splitRecipientTokens(inputValue);
        const validTokens: string[] = [];
        const invalidTokens: string[] = [];

        tokens.forEach(token => {
          if (isValidEmail(token)) {
            validTokens.push(token);
          } else {
            invalidTokens.push(token);
          }
        });

        // Add valid tokens to the recipient list
        if (validTokens.length) {
          if (field === 'to') {
            const existing = new Set(toList);
            validTokens.forEach(t => existing.add(t));
            toList = Array.from(existing);
          } else if (field === 'cc') {
            const existing = new Set(ccList);
            validTokens.forEach(t => existing.add(t));
            ccList = Array.from(existing);
          } else if (field === 'bcc') {
            const existing = new Set(bccList);
            validTokens.forEach(t => existing.add(t));
            bccList = Array.from(existing);
          }
          markDraftDirty();
        }

        // Clear the input field
        if (field === 'to') toInput = '';
        else if (field === 'cc') ccInput = '';
        else if (field === 'bcc') bccInput = '';

        // Show warning for invalid tokens
        if (invalidTokens.length) {
          toasts?.show?.(`Invalid email${invalidTokens.length > 1 ? 's' : ''}: ${invalidTokens.join(', ')}`, 'warning');
        }
      }
    }, 150);
  };

  const handleRecipientKeydown = (field: string, event: KeyboardEvent) => {
    if (!handleRecipientSuggestionKeydown(field, event)) return;
    // Convert input to chip on Enter, Tab, Space, or Comma
    if (event.key === 'Enter' || event.key === 'Tab' || event.key === ' ' || event.key === ',') {
      const inputValue = getRecipientInputValue(field).trim().replace(/,$/, ''); // Remove trailing comma
      if (inputValue) {
        event.preventDefault();
        // Validate the email before adding
        if (!isValidEmail(inputValue)) {
          toasts?.show?.(`Invalid email: ${inputValue}`, 'warning');
          return;
        }
        if (field === 'to') {
          if (!toList.includes(inputValue)) toList = [...toList, inputValue];
          toInput = '';
        } else if (field === 'cc') {
          if (!ccList.includes(inputValue)) ccList = [...ccList, inputValue];
          ccInput = '';
        } else if (field === 'bcc') {
          if (!bccList.includes(inputValue)) bccList = [...bccList, inputValue];
          bccInput = '';
        }
        markDraftDirty();
        clearRecipientSuggestions();
      } else if (event.key === 'Tab') {
        // Allow Tab to move focus when input is empty
        return;
      }
    } else if (event.key === 'Backspace' && !getRecipientInputValue(field)) {
      const list = getRecipientList(field);
      if (list.length) {
        const last = list[list.length - 1];
        removeRecipient(field, last);
      }
    }
  };

  const handleReplyToInput = (event: Event) => {
    const target = event.target as HTMLInputElement;
    const rawValue = target?.value || '';
    handleRecipientDelimitedInput('replyTo', rawValue);
    updateRecipientSuggestions('replyTo', rawValue);
    markDraftDirty();
  };

  const handleReplyToKeydown = (event: KeyboardEvent) => {
    if (!handleRecipientSuggestionKeydown('replyTo', event)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      clearRecipientSuggestions();
      subjectInputEl?.focus();
    }
  };

  let draftDirty = false;
  const markDraftDirty = () => {
    draftDirty = true;
    autosaveTimer?.markDirty();
  };

  const draftStatusLabel = $derived.by(() => {
    if (draftStatus === 'saving') return 'Saving...';
    if (draftStatus === 'saved') return 'Saved';
    if (draftStatus === 'error') return 'Save failed';
    return '';
  });

  const setDraftStatusFromDraft = (draft: Record<string, unknown>) => {
    if (draft.serverId) {
      draftStatus = 'saved';
      draftStatusDetail = 'Synced to server';
    } else if (draft.id) {
      draftStatus = 'saved';
      draftStatusDetail = 'Saved locally';
    } else {
      draftStatus = 'idle';
      draftStatusDetail = '';
    }
  };

  const getDraftData = () => ({
    id: currentDraftId || undefined,
    serverId: currentDraftServerId || undefined,
    createdAt: currentDraftSyncedAt || undefined,
    to: [...toList],
    cc: [...ccList],
    bcc: [...bccList],
    replyTo,
    inReplyTo,
    subject,
    body,
    isPlainText,
    attachments: JSON.parse(JSON.stringify(attachments)),
  });

  const hasUnsavedContent = () => {
    return draftDirty || toList.length > 0 || ccList.length > 0 || bccList.length > 0 || subject.trim() !== '' || body.trim() !== '';
  };

  const saveCurrentDraft = async () => {
    draftStatus = 'saving';
    draftStatusDetail = '';
    try {
      const data = getDraftData();
      const saved = await saveDraft(data, { sync: true });
      currentDraftId = saved.id;
      currentDraftServerId = saved.serverId || currentDraftServerId;
      currentDraftSyncedAt = saved.lastSyncedAt || currentDraftSyncedAt;
      lastSavedAt = saved.updatedAt ? new Date(saved.updatedAt).getTime() : Date.now();
      setDraftStatusFromDraft(saved as Record<string, unknown>);
      draftDirty = false;
      toasts?.show?.('Draft saved', 'success');
    } catch (err) {
      draftStatus = 'error';
      const errorMessage = (err as Error)?.message || 'Unknown error';
      draftStatusDetail = errorMessage;
      toasts?.show?.(`Failed to save draft: ${errorMessage}`, 'error');
    }
  };

  const setVisible = (val: boolean) => {
    visible = val;
    visibility.set(val);
  };

  const setCompact = (val: boolean) => {
    compact = val;
    compactState.set(val);
  };

  const setMinimized = (val: boolean) => {
    minimized = val;
    minimizedState.set(val);
  };

  const reset = () => {
    toList = [];
    ccList = [];
    bccList = [];
    toInput = '';
    ccInput = '';
    bccInput = '';
    replyTo = '';
    inReplyTo = '';
    subject = '';
    body = '';
    isPlainText = getPlainTextDefault();
    attachments = [];
    attachmentError = '';
    attachmentLoading = 0;
    error = '';
    success = '';
    sending = false;
    showCc = false;
    showBcc = false;
    showReplyTo = false;
    showEmoji = false;
    showLinkModal = false;
    linkUrl = '';
    showAttachmentReminderModal = false;
    attachmentReminderKeyword = '';
    showMobileMenu = false;
    showScheduleModal = false;
    showScheduleConfirm = false;
    scheduleDate = '';
    scheduleTime = '';
    scheduleMeridiem = 'AM';
    showScheduleTimePicker = false;
    currentDraftId = null;
    currentDraftServerId = null;
    currentDraftSyncedAt = null;
    sourceMessageId = null;
    lastSavedAt = null;
    draftStatus = 'idle';
    draftStatusDetail = '';
    draftDirty = false;
    replyBodyLoading = false;
    replyBodyError = null;
    pendingReplyBody = '';
    replyPrefillData = null;
    expanded = false;
    setMinimized(false);
    setCompact(false);
    showFormatMenu = false;
    showFormatAdvanced = false;
    editorView?.destroy();
    editorView = null;
    editorReady = false;
    clearRecipientSuggestions();
  };

  const isDesktopViewport = () => typeof window !== 'undefined' && window.innerWidth >= 768;

  const minimizeComposer = async () => {
    if (!isDesktopViewport()) return;
    if (minimizedDrafts.length >= MAX_MINIMIZED_DRAFTS) {
      toasts?.show?.(`Maximum ${MAX_MINIMIZED_DRAFTS} minimized drafts allowed.`, 'info');
      return;
    }
    const draftData = getDraftData();
    const draftMeta = {
      currentDraftId,
      currentDraftServerId,
      currentDraftSyncedAt,
      sourceMessageId,
      lastSavedAt,
      draftStatus,
      draftStatusDetail,
    };
    minimizedDrafts = [...minimizedDrafts, { key: activeDraftKey, data: draftData, meta: draftMeta }];
    setVisible(false);
    reset();
  };

  const restoreMinimizedDraft = async (draft: unknown) => {
    const d = draft as { key: string; data: Record<string, unknown>; meta: Record<string, unknown> };
    if (visible && hasUnsavedContent()) {
      toasts?.show?.('Finish the current draft before restoring another.', 'info');
      return;
    }
    minimizedDrafts = minimizedDrafts.filter((md) => (md as { key: string }).key !== d.key);
    reset();
    activeDraftKey = d.key;
    toList = (d.data.to as string[]) || [];
    ccList = (d.data.cc as string[]) || [];
    bccList = (d.data.bcc as string[]) || [];
    replyTo = (d.data.replyTo as string) || '';
    inReplyTo = (d.data.inReplyTo as string) || '';
    subject = (d.data.subject as string) || '';
    body = (d.data.body as string) || '';
    isPlainText = (d.data.isPlainText as boolean) || false;
    attachments = (d.data.attachments as unknown[]) || [];
    currentDraftId = (d.meta.currentDraftId as string) || null;
    currentDraftServerId = (d.meta.currentDraftServerId as string) || null;
    currentDraftSyncedAt = (d.meta.currentDraftSyncedAt as number) || null;
    sourceMessageId = (d.meta.sourceMessageId as string) || null;
    lastSavedAt = (d.meta.lastSavedAt as number) || null;
    draftStatus = (d.meta.draftStatus as 'idle' | 'saving' | 'saved' | 'error') || 'idle';
    draftStatusDetail = (d.meta.draftStatusDetail as string) || '';
    if (ccList.length) showCc = true;
    if (bccList.length) showBcc = true;
    if (replyTo) showReplyTo = true;
    finishOpen(false);
  };

  const discardMinimizedDraft = async (draft: unknown) => {
    const d = draft as { key: string; meta?: { currentDraftId?: string; sourceMessageId?: string; currentDraftServerId?: string } };
    // Delete draft from database if it exists
    if (d.meta?.currentDraftId) {
      try {
        await deleteDraft(d.meta.currentDraftId);
      } catch {
        // Ignore deletion errors
      }
    }
    // Delete source message from server if this draft was opened from the Drafts folder
    await deleteSourceMessage(d.meta?.sourceMessageId || null);
    // Also delete the autosaved server draft if it exists and is different from source
    if (d.meta?.currentDraftServerId && d.meta.currentDraftServerId !== d.meta.sourceMessageId) {
      await deleteSourceMessage(d.meta.currentDraftServerId);
    }
    minimizedDrafts = minimizedDrafts.filter((md) => (md as { key: string }).key !== d.key);
  };

  const getMinimizedTitle = (draft: unknown) => {
    const d = draft as { data: { subject?: string; to?: string[] } };
    if (d.data.subject) return d.data.subject;
    if (d.data.to?.length) return d.data.to[0];
    return 'New message';
  };

  const getMinimizedStatusLabel = (draft: unknown) => {
    const d = draft as { meta: { draftStatus?: string } };
    if (d.meta.draftStatus === 'saved') return 'Saved';
    return '';
  };

  const getMinimizedMeta = (draft: unknown) => {
    const d = draft as { data: { to?: string[] } };
    if (d.data.to?.length && d.data.to.length > 1) {
      return `+${d.data.to.length - 1} more`;
    }
    return '';
  };

  const handleMinimizedKeydown = (event: KeyboardEvent, draft: unknown) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      restoreMinimizedDraft(draft);
    }
  };

  let draggedDraft: unknown = null;
  const handleDragStart = (event: DragEvent, draft: unknown) => {
    draggedDraft = draft;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
    }
  };

  const handleDragEnd = () => {
    draggedDraft = null;
  };

  const handleDragOver = (event: DragEvent) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move';
    }
  };

  const handleDrop = (event: DragEvent, targetDraft: unknown) => {
    event.preventDefault();
    if (!draggedDraft || draggedDraft === targetDraft) return;
    const draggedKey = (draggedDraft as { key: string }).key;
    const targetKey = (targetDraft as { key: string }).key;
    const draggedIndex = minimizedDrafts.findIndex((d) => (d as { key: string }).key === draggedKey);
    const targetIndex = minimizedDrafts.findIndex((d) => (d as { key: string }).key === targetKey);
    if (draggedIndex === -1 || targetIndex === -1) return;
    const newDrafts = [...minimizedDrafts];
    const [removed] = newDrafts.splice(draggedIndex, 1);
    newDrafts.splice(targetIndex, 0, removed);
    minimizedDrafts = newDrafts;
    draggedDraft = null;
  };

  const nextDraftKey = () => {
    minimizedDraftSequence += 1;
    return `draft-${Date.now()}-${minimizedDraftSequence}`;
  };

  const closeComposer = async (skipConfirm = false) => {
    if (!skipConfirm && hasUnsavedContent()) {
      showDiscardModal = true;
      return;
    }
    setVisible(false);
    reset();
  };

  const promptDiscardDraft = () => {
    if (hasUnsavedContent()) {
      showDiscardModal = true;
    } else {
      closeComposer(true);
    }
  };

  const confirmDiscardDraft = async () => {
    autosaveTimer?.stop();
    showDiscardModal = false;
    const msgIdToDelete = sourceMessageId;
    const serverIdToDelete = currentDraftServerId;
    // Delete draft from database if it exists
    if (currentDraftId) {
      try {
        await deleteDraft(currentDraftId);
      } catch {
        // Ignore deletion errors
      }
    }
    // Delete source message from server if this draft was opened from the Drafts folder
    await deleteSourceMessage(msgIdToDelete);
    // Also delete the autosaved server draft if it exists and is different from source
    if (serverIdToDelete && serverIdToDelete !== msgIdToDelete) {
      await deleteSourceMessage(serverIdToDelete);
    }
    setVisible(false);
    reset();
  };

  // Helper to delete source message from server and local cache
  const deleteSourceMessage = async (msgId: string | null) => {
    if (!msgId) return;
    const account = Local.get('email') || 'default';

    // Look up the message from cache to get the proper API ID and folder
    let apiId: string | number | null = msgId;
    let cachedMsg: Record<string, unknown> | null = null;
    try {
      cachedMsg = await db.messages.get([account, msgId]);
      if (cachedMsg) {
        apiId = getMessageApiId(cachedMsg as Parameters<typeof getMessageApiId>[0]) || msgId;
      }
    } catch {
      // Use msgId as fallback
    }

    // Delete from server (404 means already gone — treat as success)
    try {
      await Remote.request(
        'MessageDelete',
        {},
        { method: 'DELETE', pathOverride: `/v1/messages/${encodeURIComponent(String(apiId))}?permanent=1` }
      );
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 404) {
        console.error('[Compose] Failed to delete source message from server:', err);
      }
    }

    // Always clean up local cache regardless of server result
    try {
      // Delete from messages table
      await db.messages.where('[account+id]').equals([account, msgId]).delete();
      // Also try to delete by other potential ID fields
      if (cachedMsg?.message_id && cachedMsg.message_id !== msgId) {
        await db.messages.where('[account+id]').equals([account, cachedMsg.message_id as string]).delete();
      }
      if (cachedMsg?.uid && cachedMsg.uid !== msgId) {
        await db.messages.where('[account+id]').equals([account, String(cachedMsg.uid)]).delete();
      }
      // Delete message bodies
      await db.messageBodies.where('[account+id]').equals([account, msgId]).delete();
      // Delete from search index
      await db.searchIndex.where('[account+key]').equals([account, msgId]).delete();
    } catch (cacheErr) {
      console.error('[Compose] Failed to clean up local cache:', cacheErr);
    }

    // Notify mailbox to refresh UI
    window.dispatchEvent(new CustomEvent('draft-message-deleted', { detail: { messageId: msgId } }));
  };

  const clearComposeInlineHeights = () => {
    // Allow layout to adjust
  };

  const focusEditor = () => {
    if (editorView && !isPlainText) {
      editorView.commands.focus();
    } else if (plainTextInputEl && isPlainText) {
      plainTextInputEl.focus();
    }
  };

  // Convert plain text with formatting patterns to HTML for rich paste
  const plainTextToHtml = (text: string): string => {
    const escapeHtml = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const lines = text.split('\n');
    const parts: string[] = [];
    let inUl = false;
    let inOl = false;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        if (inUl) { parts.push('</ul>'); inUl = false; }
        if (inOl) { parts.push('</ol>'); inOl = false; }
        parts.push('<p></p>');
        continue;
      }

      // Bullet list: -, *, or • followed by space
      const bullet = trimmed.match(/^[-*•]\s+(.*)/);
      if (bullet) {
        if (inOl) { parts.push('</ol>'); inOl = false; }
        if (!inUl) { parts.push('<ul>'); inUl = true; }
        parts.push(`<li>${escapeHtml(bullet[1])}</li>`);
        continue;
      }

      // Ordered list: number followed by . or ) and space
      const ordered = trimmed.match(/^\d+[.)]\s+(.*)/);
      if (ordered) {
        if (inUl) { parts.push('</ul>'); inUl = false; }
        if (!inOl) { parts.push('<ol>'); inOl = true; }
        parts.push(`<li>${escapeHtml(ordered[1])}</li>`);
        continue;
      }

      // Regular line
      if (inUl) { parts.push('</ul>'); inUl = false; }
      if (inOl) { parts.push('</ol>'); inOl = false; }
      parts.push(`<p>${escapeHtml(trimmed)}</p>`);
    }

    if (inUl) parts.push('</ul>');
    if (inOl) parts.push('</ol>');
    return parts.join('');
  };

  const initEditor = (focusToField = false) => {
    if (editorReady) return;
    if (isPlainText) {
      editorReady = true;
      tick().then(() => {
        if (focusToField) {
          toInputEl?.focus();
        } else {
          plainTextInputEl?.focus();
        }
      });
      return;
    }
    const editorEl = document.querySelector('.rich-editor');
    if (!editorEl) {
      setTimeout(() => initEditor(focusToField), 50);
      return;
    }
    editorView = new Editor({
      element: editorEl as HTMLElement,
      extensions: [
        StarterKit,
        Link.configure({
          openOnClick: false,
          autolink: false,
          linkOnPaste: true,
        }),
        Placeholder.configure({ placeholder: 'Write your message...' }),
        Highlight.configure({ multicolor: true }),
        Underline,
        TextStyle,
        FontSize,
        TextAlign.configure({ types: ['heading', 'paragraph', 'listItem'] }),
        Color,
        FontFamily,
        ImageWithSize,
        Table.configure({ resizable: true }),
        TableRow,
        TableCell,
        TableHeader,
        RawHtmlQuote,
      ],
      editorProps: {
        // Clean up pasted HTML from Word/Outlook
        transformPastedHTML(html: string) {
          return html
            // Remove Word conditional comments
            .replace(/<!--\[if[^]*?endif\]-->/gi, '')
            // Remove MSO namespace tags (<o:p>, etc.)
            .replace(/<\/?o:[^>]*>/gi, '')
            // Remove class="Mso*" attributes
            .replace(/\s*class="Mso[^"]*"/gi, '')
            // Remove mso-* CSS properties
            .replace(/mso-[^;:"']+:[^;:"']+;?/gi, '');
        },
        // Convert plain-text-only paste to rich HTML
        handlePaste: (view, event) => {
          const clipboardData = event.clipboardData;
          if (!clipboardData) return false;

          // If HTML is on the clipboard, let TipTap handle it natively
          const html = clipboardData.getData('text/html');
          if (html) return false;

          const text = clipboardData.getData('text/plain');
          if (!text) return false;

          // Convert plain text formatting to HTML and insert
          const converted = plainTextToHtml(text);
          editorView?.commands.insertContent(converted);
          return true;
        },
      },
      content: body || '',
      onUpdate: ({ editor }) => {
        body = editor.getHTML();
        markDraftDirty();
      },
      onFocus: () => {
        lastFocusedField = 'editor';
      },
    });
    editorReady = true;
    tick().then(() => {
      if (focusToField) {
        toInputEl?.focus();
      } else {
        editorView?.commands.focus();
      }
    });
  };

  const togglePlainText = () => {
    if (!isPlainText && editorView) {
      body = editorView.getText();
      editorView.destroy();
      editorView = null;
    }
    isPlainText = !isPlainText;
    editorReady = false;
    tick().then(() => {
      initEditor(false);
    });
    markDraftDirty();
  };

  const isFormatActive = (format: string) => {
    if (!editorView) return false;
    return editorView.isActive(format);
  };

  const setFontFamily = (value: string) => {
    fontFamily = value;
    if (value === 'default') {
      editorView?.chain().focus().unsetFontFamily().run();
    } else {
      editorView?.chain().focus().setFontFamily(value).run();
    }
  };

  const setFontSize = (value: string) => {
    fontSize = value;
    editorView?.chain().focus().setMark('textStyle', { fontSize: `${value}px` }).run();
  };

  const setTextColor = (value: string) => {
    textColor = value;
    editorView?.chain().focus().setColor(value).run();
  };

  const setHighlightColor = (value: string) => {
    highlightColor = value;
    editorView?.chain().focus().setHighlight({ color: value }).run();
  };

  const clearHighlight = () => {
    editorView?.chain().focus().unsetHighlight().run();
  };

  const setAlignment = (value: 'left' | 'center' | 'right') => {
    alignment = value;
    editorView?.chain().focus().setTextAlign(value).run();
  };

  const toggleFormatMenu = () => {
    showFormatMenu = !showFormatMenu;
    if (!showFormatMenu) {
      showFormatAdvanced = false;
    }
  };

  const handleFormatMenuKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      showFormatMenu = false;
      showFormatAdvanced = false;
    }
  };

  const triggerFilePicker = () => {
    const input = document.querySelector('.attach-input') as HTMLInputElement;
    input?.click();
  };

  const triggerImagePicker = () => {
    const input = document.querySelector('.image-input') as HTMLInputElement;
    input?.click();
  };

  const onFilesSelected = async (_: unknown, event: Event) => {
    const target = event.target as HTMLInputElement;
    const files = target?.files;
    if (!files?.length) return;
    attachmentError = '';
    attachmentLoading += files.length;
    try {
      for (const file of files) {
        const reader = new FileReader();
        const content = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        attachments = [...attachments, {
          name: file.name,
          filename: file.name,
          size: file.size,
          contentType: file.type || 'application/octet-stream',
          content,
        }];
      }
      markDraftDirty();
    } catch (err) {
      attachmentError = (err as Error)?.message || 'Failed to read file';
    } finally {
      attachmentLoading -= files.length;
      target.value = '';
    }
  };

  const onImageSelected = async (_: unknown, event: Event) => {
    const target = event.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      attachmentError = 'Please select an image file';
      target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      editorView?.chain().focus().setImage({ src: dataUrl }).run();
      markDraftDirty();
    };
    reader.readAsDataURL(file);
    target.value = '';
  };

  const removeAttachment = (att: unknown) => {
    attachments = attachments.filter((a) => a !== att);
    markDraftDirty();
  };

  const openLinkModal = () => {
    linkUrl = '';
    if (editorView) {
      // Save the current selection before opening modal
      const { from, to } = editorView.state.selection;
      savedLinkSelection = { from, to };
      const attrs = editorView.getAttributes('link');
      linkUrl = attrs.href || '';
    }
    showLinkModal = true;
    tick().then(() => {
      const input = document.getElementById('link-url') as HTMLInputElement;
      input?.focus();
      input?.select();
    });
  };

  const closeLinkModal = () => {
    showLinkModal = false;
    linkUrl = '';
    savedLinkSelection = null;
  };

  const insertLink = () => {
    if (editorView && savedLinkSelection) {
      // Restore the saved selection before applying link
      editorView.chain().focus().setTextSelection(savedLinkSelection).run();
    }
    if (linkUrl.trim()) {
      editorView?.chain().focus().setLink({ href: linkUrl.trim() }).run();
    } else {
      editorView?.chain().focus().unsetLink().run();
    }
    savedLinkSelection = null;
    closeLinkModal();
    markDraftDirty();
  };

  const toggleEmoji = () => {
    showEmoji = !showEmoji;
    if (showEmoji && !emojiPickerLoaded) {
      import('emoji-picker-element').then(() => {
        emojiPickerLoaded = true;
      });
    }
  };

  const bindEmojiPicker = (node: HTMLElement) => {
    // Apply dark class based on current theme
    const updateTheme = () => {
      const isDark = document.documentElement.classList.contains('dark');
      node.classList.toggle('dark', isDark);
      node.classList.toggle('light', !isDark);
    };
    updateTheme();

    // Watch for theme changes
    const observer = new MutationObserver(() => updateTheme());
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    // Position the picker container to stay within viewport
    const positionPicker = () => {
      const container = node.parentElement;
      if (!container) return;

      const pickerWidth = 350; // approximate width of emoji picker
      const buttonRect = emojiButtonRef?.getBoundingClientRect();
      if (!buttonRect) return;

      // Position above the button
      const bottomOffset = window.innerHeight - buttonRect.top + 8;
      container.style.bottom = `${bottomOffset}px`;

      // Ensure picker doesn't go off left edge
      const rightEdge = buttonRect.right;
      const leftPosition = rightEdge - pickerWidth;
      if (leftPosition < 8) {
        // Not enough space on left, align to left edge of viewport with padding
        container.style.left = '8px';
        container.style.right = 'auto';
      } else {
        // Align right edge of picker with right edge of button
        container.style.right = `${window.innerWidth - rightEdge}px`;
        container.style.left = 'auto';
      }
    };

    requestAnimationFrame(positionPicker);

    const handleEmojiClick = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const emoji = detail?.unicode || detail?.emoji?.native || '';
      if (emoji) {
        if (editorView && !isPlainText) {
          editorView.chain().focus().insertContent(emoji).run();
        } else if (plainTextInputEl && isPlainText) {
          const start = plainTextInputEl.selectionStart || 0;
          const end = plainTextInputEl.selectionEnd || 0;
          body = body.slice(0, start) + emoji + body.slice(end);
          tick().then(() => {
            plainTextInputEl?.setSelectionRange(start + emoji.length, start + emoji.length);
          });
        }
        markDraftDirty();
      }
      showEmoji = false;
    };
    node.addEventListener('emoji-click', handleEmojiClick);
    return {
      destroy() {
        observer.disconnect();
        node.removeEventListener('emoji-click', handleEmojiClick);
      },
    };
  };

  const isValidDecodedHtml = (html: string) => {
    if (!html) return false;
    if (typeof DOMParser === 'undefined') return true;
    try {
      if (html.includes('&lt;') || html.includes('&gt;')) return false;
      const doc = new DOMParser().parseFromString(html, 'text/html');
      if (!doc.body) return false;
      if (doc.getElementsByTagName('parsererror').length > 0) return false;
      return true;
    } catch {
      return false;
    }
  };

  const extractRawQuoteText = (value: string) => {
    if (!value) return '';
    const match = value.match(/data-raw-html="([^"]+)"/);
    if (!match) return '';
    try {
      const decoded = decodeRawHtml(match[1]);
      if (typeof DOMParser !== 'undefined') {
        const doc = new DOMParser().parseFromString(decoded, 'text/html');
        return doc.body?.textContent || '';
      }
      return decoded.replace(/<[^>]*>/g, '');
    } catch {
      return '';
    }
  };

  const buildPayload = () => {
    // Convert $state proxy arrays to plain arrays for worker serialization
    const toRecipients = [...(toList.length ? toList : parseRecipients(toInput))];
    const ccRecipients = [...(ccList.length ? ccList : parseRecipients(ccInput))];
    const bccRecipients = [...(bccList.length ? bccList : parseRecipients(bccInput))];
    if (!toRecipients.length && !ccRecipients.length && !bccRecipients.length) {
      error = 'Please add at least one recipient.';
      return null;
    }

    // Validate all email addresses
    const allRecipients = [...toRecipients, ...ccRecipients, ...bccRecipients];
    const invalidEmails = allRecipients.filter(email => !isValidEmail(email));

    if (invalidEmails.length) {
      error = `Invalid email address${invalidEmails.length > 1 ? 'es' : ''}: ${invalidEmails.join(', ')}`;
      return null;
    }

    const email = fromAddress || Local.get('email') || '';
    const name = $profileName;
    const from = name ? `"${name}" <${email}>` : email;
    const payload: Record<string, unknown> = {
      from,
      to: toRecipients,
      subject: subject || '(No subject)',
      save_sent: true,
    };
    if (ccRecipients.length) payload.cc = ccRecipients;
    if (bccRecipients.length) payload.bcc = bccRecipients;
    if (replyTo) payload.reply_to = replyTo;
    if (inReplyTo) payload.in_reply_to = inReplyTo;
    if (isPlainText) {
      payload.text = body;
    } else {
      payload.html = body;
      const textContent = extractTextContent(body);
      if (textContent) payload.text = textContent;
    }
    if (attachments.length) {
      payload.attachments = attachments.map((att) => {
        const a = att as Record<string, unknown>;
        return {
          filename: a.name || a.filename,
          contentType: a.contentType || a.mimeType || 'application/octet-stream',
          content: a.content,
          encoding: 'base64',
        };
      });
      payload.has_attachment = true;
    }
    return payload;
  };

  const saveSentCopyWrapper = async (payload: Record<string, unknown>) => {
    try {
      await saveSentCopy(payload);
    } catch (err) {
      console.warn('[Compose] Failed to save sent copy:', err);
    }
  };

  const sendLater = async () => {
    autosaveTimer?.stop();
    const sendAt = getScheduledTimestamp();
    if (!sendAt) {
      error = 'Invalid schedule time.';
      return;
    }
    const payload = buildPayload();
    if (!payload) return;
    sending = true;
    error = '';
    try {
      await queueEmail(payload, { sendAt });
      const msgIdToDelete = sourceMessageId;
      if (currentDraftId) {
        try {
          await deleteDraft(currentDraftId);
        } catch (err) {
          console.error('[Compose] Failed to delete draft after scheduling:', err);
        }
      }
      // Delete source message from Drafts folder if this was an edited draft
      await deleteSourceMessage(msgIdToDelete);
      const formattedDate = new Date(sendAt).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      toasts?.show?.(`Email scheduled for ${formattedDate}`, 'success');
      closeScheduleModal();
      setVisible(false);
      reset();
      onSent?.({ queued: true, scheduled: true, sendAt });
    } catch (err) {
      console.error('[Compose] Failed to schedule email', err);
      error = 'Failed to schedule message. Please try again.';
      toasts?.show?.(error, 'error');
    } finally {
      sending = false;
    }
  };

  const checkAttachmentReminder = () => {
    let reminderEnabled = false;
    const unsubscribe = attachmentReminder.subscribe((v) => (reminderEnabled = v));
    unsubscribe();
    if (!reminderEnabled) return false;
    const result = shouldShowAttachmentReminder({ subject, body, attachments });
    if (result.shouldRemind) {
      attachmentReminderKeyword = result.keyword || '';
      return true;
    }
    return false;
  };

  const dismissAttachmentReminder = (proceed = false) => {
    showAttachmentReminderModal = false;
    attachmentReminderKeyword = '';
    if (proceed) {
      proceedWithSend();
    }
  };

  const proceedWithSend = async () => {
    autosaveTimer?.stop();
    const payload = buildPayload();
    if (!payload) return;
    sending = true;
    error = '';
    success = '';
    const isOnline = navigator.onLine;
    if (!isOnline) {
      try {
        await queueEmail(payload);
        const msgIdToDelete = sourceMessageId;
        if (currentDraftId) {
          try {
            await deleteDraft(currentDraftId);
          } catch (err) {
            console.error('[Compose] Failed to delete draft after queueing:', err);
            toasts?.show?.('Warning: Failed to delete draft', 'warning');
          }
        }
        // Delete source message from Drafts folder if this was an edited draft
        await deleteSourceMessage(msgIdToDelete);
        toasts?.show?.('Message queued - will send when online', 'info');
        setVisible(false);
        reset();
        onSent?.({ queued: true });
      } catch (err) {
        error = 'Failed to queue message';
        toasts?.show?.(error, 'error');
      } finally {
        sending = false;
      }
      return;
    }
    try {
      await Remote.request('Emails', payload, { method: 'POST' });
      await saveSentCopyWrapper(payload);
      const msgIdToDelete = sourceMessageId;
      if (currentDraftId) {
        try {
          await deleteDraft(currentDraftId);
        } catch (err) {
          console.error('[Compose] Failed to delete draft after send:', err);
          toasts?.show?.('Warning: Failed to delete draft', 'warning');
        }
      }
      // Delete source message from Drafts folder if this was an edited draft
      await deleteSourceMessage(msgIdToDelete);
      success = 'Message sent';
      toasts?.show?.('Message sent', 'success');
      // Cache recipient addresses for offline autocomplete
      mergeRecentAddresses([
        ...toList.map((e) => ({ email: e })),
        ...ccList.map((e) => ({ email: e })),
        ...bccList.map((e) => ({ email: e })),
      ]).catch(() => {});
      setVisible(false);
      reset();
      onSent?.();
    } catch (err) {
      const e = err as { message?: string; status?: number };
      if (e.message?.includes('network') || e.message?.includes('fetch') || e.status === 0) {
        try {
          await queueEmail(payload);
          const msgIdToDelete = sourceMessageId;
          if (currentDraftId) {
            try {
              await deleteDraft(currentDraftId);
            } catch (delErr) {
              console.error('[Compose] Failed to delete draft after network error queue:', delErr);
              toasts?.show?.('Warning: Failed to delete draft', 'warning');
            }
          }
          // Delete source message from Drafts folder if this was an edited draft
          await deleteSourceMessage(msgIdToDelete);
          toasts?.show?.('Network error - message queued for retry', 'warning');
          setVisible(false);
          reset();
          onSent?.({ queued: true });
        } catch (queueErr) {
          error = e?.message || 'Send failed';
          toasts?.show?.(error, 'error');
        }
      } else {
        error = e?.message || 'Send failed';
        toasts?.show?.(error, 'error');
      }
    } finally {
      sending = false;
    }
  };

  const send = async () => {
    if (attachmentLoading > 0) {
      error = 'Please wait for attachments to finish loading.';
      return;
    }
    if (checkAttachmentReminder()) {
      showAttachmentReminderModal = true;
      return;
    }
    await proceedWithSend();
  };

  const finishOpen = (shouldFocusToField = false) => {
    composeOpenedAt = Date.now();
    setVisible(true);
    setTimeout(() => {
      initEditor(shouldFocusToField);
    }, 0);
    tick().then(() => {
      clearComposeInlineHeights();
    });
    autosaveTimer = createAutosaveTimer(getDraftData, {
      onStart: () => {
        draftStatus = 'saving';
        draftStatusDetail = '';
      },
      onSave: (saved: Record<string, unknown>) => {
        currentDraftId = saved.id as string;
        currentDraftServerId = (saved.serverId as string) || currentDraftServerId;
        currentDraftSyncedAt = (saved.lastSyncedAt as number) || currentDraftSyncedAt;
        lastSavedAt = saved.updatedAt ? new Date(saved.updatedAt as number).getTime() : Date.now();
        setDraftStatusFromDraft(saved);
      },
      onError: (err: Error) => {
        draftStatus = 'error';
        const errorMessage = err?.message || 'Unknown error';
        draftStatusDetail = errorMessage;
        toasts?.show?.(`Auto-save failed: ${errorMessage}`, 'error');
      },
    });
    autosaveTimer.start();
  };

  const normalizePrefillList = (value: unknown) => {
    if (!value) return [];
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) {
      return value.map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item === 'object' && item) {
          const i = item as Record<string, unknown>;
          return (i.email || i.address || i.value || '') as string;
        }
        return '';
      }).filter(Boolean);
    }
    return [];
  };

  const open = async (prefill: Record<string, unknown> = {}) => {
    if (prefill?.draftId) {
      if (visible && currentDraftId === prefill.draftId) {
        toasts?.show?.('This draft is already open.', 'info');
        return;
      }
      const minimizedDraft = minimizedDrafts.find(
        (d) => (d as { meta: { currentDraftId: string } })?.meta?.currentDraftId === prefill.draftId
      );
      if (minimizedDraft) {
        await restoreMinimizedDraft(minimizedDraft);
        return;
      }
    }
    if (visible) {
      if (hasUnsavedContent()) {
        toasts?.show?.('Finish the current draft before starting a new one.', 'info');
        return;
      }
    }
    reset();
    activeDraftKey = nextDraftKey();
    let resolvedPrefill = prefill;
    if (prefill?.mailto && typeof prefill.mailto === 'string') {
      const parsedMailto = parseMailto(prefill.mailto);
      mailtoData = parsedMailto;
      resolvedPrefill = { ...mailtoToPrefill(parsedMailto), ...prefill };
    } else {
      mailtoData = prefill.mailto || null;
    }
    if (resolvedPrefill.draftId) {
      try {
        const draft = await getDraft(resolvedPrefill.draftId as string);
        if (draft) {
          currentDraftId = draft.id;
          currentDraftServerId = draft.serverId || null;
          currentDraftSyncedAt = draft.lastSyncedAt || null;
          toList = draft.to || [];
          ccList = draft.cc || [];
          bccList = draft.bcc || [];
          replyTo = draft.replyTo || '';
          inReplyTo = draft.inReplyTo || '';
          subject = draft.subject || '';
          body = draft.body || '';
          isPlainText = draft.isPlainText || false;
          attachments = draft.attachments || [];
          lastSavedAt = draft.updatedAt ? new Date(draft.updatedAt).getTime() : null;
          setDraftStatusFromDraft(draft as Record<string, unknown>);
          activeDraftKey = currentDraftId || activeDraftKey;
        }
      } catch (err) {
        console.error('[Compose] Failed to load draft:', err);
      }
    }
    if (resolvedPrefill.to) {
      const normalizedTo = normalizePrefillList(resolvedPrefill.to);
      toList = normalizedTo.length ? normalizedTo : Array.isArray(resolvedPrefill.to) ? (resolvedPrefill.to as string[]).filter(Boolean) : [resolvedPrefill.to as string];
    }
    if (resolvedPrefill.cc) {
      const normalizedCc = normalizePrefillList(resolvedPrefill.cc);
      ccList = normalizedCc.length ? normalizedCc : Array.isArray(resolvedPrefill.cc) ? (resolvedPrefill.cc as string[]).filter(Boolean) : [resolvedPrefill.cc as string];
    }
    if (resolvedPrefill.bcc) {
      const normalizedBcc = normalizePrefillList(resolvedPrefill.bcc);
      bccList = normalizedBcc.length ? normalizedBcc : Array.isArray(resolvedPrefill.bcc) ? (resolvedPrefill.bcc as string[]).filter(Boolean) : [resolvedPrefill.bcc as string];
    }
    if (resolvedPrefill.replyTo || resolvedPrefill.reply_to) {
      const replyToValue = resolvedPrefill.replyTo || resolvedPrefill.reply_to;
      replyTo = Array.isArray(replyToValue) ? (replyToValue as string[])[0] : (replyToValue as string) || '';
    }
    if (resolvedPrefill.inReplyTo || resolvedPrefill.in_reply_to) {
      const inReplyToValue = resolvedPrefill.inReplyTo || resolvedPrefill.in_reply_to;
      inReplyTo = Array.isArray(inReplyToValue) ? (inReplyToValue as string[])[0] : (inReplyToValue as string) || '';
    }
    if (resolvedPrefill.subject) subject = resolvedPrefill.subject as string;
    if (isPlainText && resolvedPrefill.text) {
      body = resolvedPrefill.text as string;
    } else if (resolvedPrefill.body) {
      body = resolvedPrefill.body as string;
    }
    if (resolvedPrefill.html && editorView) {
      editorView.commands.setContent(resolvedPrefill.html as string);
    } else if (resolvedPrefill.html && !isPlainText) {
      body = resolvedPrefill.html as string;
    }
    if (ccList.length) showCc = true;
    if (bccList.length) showBcc = true;
    if (replyTo) showReplyTo = true;
    // Track source message ID for drafts opened from the Drafts folder
    if (resolvedPrefill.sourceMessageId) {
      sourceMessageId = resolvedPrefill.sourceMessageId as string;
    }
    const shouldFocusToField = toList.length === 0;
    finishOpen(shouldFocusToField);
  };

  const close = () => {
    closeComposer(false);
  };

  // API functions for external use
  const reply = (options: Record<string, unknown> = {}) => open(options);
  const forward = (options: Record<string, unknown> = {}) => open(options);
  const setContacts = (list: unknown[] = []) => { contacts = list as { email: string; name?: string }[]; };
  const setToList = (list: unknown[] = []) => { toList = list as string[]; };
  const isVisible = () => visible;
  const isMinimized = () => minimized;
  const saveDraftFn = () => { saveCurrentDraft(); };
  const updateReplyBody = (newBody?: string, options?: { focusTop?: boolean }) => {
    if (!newBody) return;
    // Set the HTML content in the editor
    if (editorView) {
      editorView.commands.setContent(newBody);
      // Focus at the beginning if requested
      if (options?.focusTop) {
        tick().then(() => {
          editorView?.commands.focus('start');
        });
      }
    } else {
      // If editor not ready, set body and it will be loaded when editor initializes
      body = newBody;
    }
  };

  onMount(() => {
    registerApi?.({
      open,
      close,
      reply,
      forward,
      setContacts,
      setToList,
      isVisible,
      isMinimized,
      saveDraft: saveDraftFn,
      updateReplyBody,
      visibility,
    });
    const handleClickOutside = (event: MouseEvent) => {
      if (showEmoji && emojiPickerRef && !emojiPickerRef.contains(event.target as Node) && emojiButtonRef && !emojiButtonRef.contains(event.target as Node)) {
        showEmoji = false;
      }
      // Format menu stays open until explicitly closed via toggle button
      if (showMobileMenu && !(event.target as HTMLElement)?.closest?.('.mobile-menu')) {
        showMobileMenu = false;
      }
    };
    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
      editorView?.destroy();
      autosaveTimer?.stop?.();
    };
  });

  onDestroy(() => {
    editorView?.destroy();
    autosaveTimer?.stop?.();
  });
</script>

<Tooltip.Provider>
{#if visible && !minimized}
  {#if expanded}
    <div class="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"></div>
  {/if}
  <div
    class="fixed inset-0 z-50 flex flex-col bg-background border border-border shadow-2xl ring-1 ring-black/5 dark:ring-white/10 overflow-hidden transition-all"
    class:md:inset-auto={!expanded}
    class:md:bottom-4={!expanded}
    class:md:right-4={!expanded}
    class:md:left-auto={!expanded}
    class:md:top-auto={!expanded}
    class:w-full={!expanded}
    class:h-full={!expanded}
    class:md:w-[560px]={!expanded && !compact}
    class:md:h-[600px]={!expanded && !compact}
    class:md:w-[650px]={!expanded && compact}
    class:md:h-[700px]={!expanded && compact}
    class:md:top-8={expanded}
    class:md:bottom-8={expanded}
    class:md:left-0={expanded}
    class:md:right-0={expanded}
    class:md:max-w-5xl={expanded}
    class:md:mx-auto={expanded}
    role="dialog"
    aria-modal={!compact}
  >
      <header class="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-muted/30">
        <Button variant="ghost" size="icon" class="md:hidden" onclick={() => closeComposer(true)}>
          <ChevronLeft class="h-5 w-5" />
        </Button>

        <div class="flex items-center gap-2 min-w-0 flex-1">
          <span class="font-semibold truncate">New message</span>
          {#if draftStatusLabel}
            {#if draftStatusDetail}
              <Tooltip.Root>
                <Tooltip.Trigger>
                  <Badge
                    variant={draftStatus === 'error' ? 'destructive' : 'secondary'}
                    class="text-xs shrink-0"
                  >
                    {draftStatusLabel}
                  </Badge>
                </Tooltip.Trigger>
                <Tooltip.Content side="bottom"><p>{draftStatusDetail}</p></Tooltip.Content>
              </Tooltip.Root>
            {:else}
              <Badge
                variant={draftStatus === 'error' ? 'destructive' : 'secondary'}
                class="text-xs shrink-0"
              >
                {draftStatusLabel}
              </Badge>
            {/if}
          {/if}
        </div>

        <div class="flex items-center gap-1">
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Button variant="ghost" size="icon" class="hidden md:flex" onclick={minimizeComposer}>
                <Minus class="h-4 w-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom"><p>Minimize to dock</p></Tooltip.Content>
          </Tooltip.Root>
          {#if expanded}
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button
                  variant="ghost"
                  size="icon"
                  class="hidden md:flex"
                  onclick={() => {
                    if (!isDesktopViewport()) return;
                    expanded = false;
                    setCompact(true);
                  }}
                >
                  <Minimize2 class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content side="bottom"><p>Compact view</p></Tooltip.Content>
            </Tooltip.Root>
          {:else if compact}
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button
                  variant="ghost"
                  size="icon"
                  class="hidden md:flex"
                  onclick={() => {
                    if (!isDesktopViewport()) return;
                    setCompact(false);
                    expanded = true;
                  }}
                >
                  <Maximize2 class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content side="bottom"><p>Expand to fullscreen</p></Tooltip.Content>
            </Tooltip.Root>
          {:else}
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button
                  variant="ghost"
                  size="icon"
                  class="hidden md:flex"
                  onclick={() => {
                    if (!isDesktopViewport()) return;
                    setCompact(false);
                    expanded = true;
                  }}
                >
                  <Maximize2 class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content side="bottom"><p>Expand</p></Tooltip.Content>
            </Tooltip.Root>
          {/if}
          <Tooltip.Root>
            <Tooltip.Trigger>
              <Button variant="ghost" size="icon" class="hidden md:flex" onclick={() => closeComposer()}>
                <X class="h-4 w-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content side="bottom"><p>Close</p></Tooltip.Content>
          </Tooltip.Root>

          <Button variant="ghost" size="icon" class="md:hidden" onclick={triggerFilePicker}>
            <Paperclip class="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" class="md:hidden h-10 w-10" onclick={send} disabled={sending}>
            <Send class="h-6 w-6 text-blue-400" />
          </Button>
          <div class="relative md:hidden">
            <Button variant="ghost" size="icon" class="mobile-menu" onclick={() => showMobileMenu = !showMobileMenu}>
              <MoreVertical class="h-5 w-5" />
            </Button>
            {#if showMobileMenu}
              {@const hasContent = !editorView?.isEmpty || toList.length > 0 || subject.trim().length > 0}
              <div class="absolute right-0 top-full mt-1 min-w-[180px] border border-border bg-popover p-1 shadow-lg z-[100]">
                {#if !isPlainText}
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                    onclick={() => { showMobileMenu = false; openLinkModal(); }}
                  >
                    <Link2 class="h-4 w-4" />
                    Insert link
                  </button>
                  <button
                    type="button"
                    class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
                    onclick={() => { showMobileMenu = false; triggerImagePicker(); }}
                  >
                    <ImageIcon class="h-4 w-4" />
                    Insert image
                  </button>
                  <div class="h-px bg-border my-1"></div>
                {/if}
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
                  disabled={sending}
                  onclick={() => { showMobileMenu = false; openScheduleModal(); }}
                >
                  <Clock class="h-4 w-4" />
                  Schedule send
                </button>
                <div class="h-px bg-border my-1"></div>
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
                  disabled={!hasContent}
                  onclick={async () => { await saveCurrentDraft(); showMobileMenu = false; }}
                >
                  <Save class="h-4 w-4" />
                  Save as draft
                </button>
                <button
                  type="button"
                  class="w-full flex items-center gap-2 px-3 py-2 text-sm text-destructive hover:bg-accent"
                  onclick={() => { showMobileMenu = false; closeComposer(false); }}
                >
                  <Trash2 class="h-4 w-4" />
                  Discard
                </button>
              </div>
            {/if}
          </div>
        </div>
      </header>

      <div class="flex-1 overflow-y-auto p-0 md:p-4 flex flex-col gap-3">
        <div class="space-y-2 shrink-0">
          <div class="relative">
            <div class="flex flex-wrap items-center gap-1.5 min-h-[44px] md:min-h-[38px] px-3 py-2 md:py-1.5 border border-input bg-background transition-colors focus-within:border-primary">
              {#each toList as rec}
                <Badge variant="secondary" class="gap-1 pl-2 pr-1 text-base md:text-sm">
                  <span class="cursor-pointer" onclick={() => editRecipient('to', rec)}>{rec}</span>
                  <button type="button" class="hover:bg-muted-foreground/20 rounded-full p-0.5" onclick={() => removeRecipient('to', rec)}>
                    <X class="h-3.5 w-3.5 md:h-3 md:w-3" />
                  </button>
                </Badge>
              {/each}
              <input
                type="email"
                class="flex-1 min-w-[120px] bg-transparent border-0 outline-none focus:outline-none focus-visible:outline-none text-base md:text-sm placeholder:text-muted-foreground"
                placeholder={toList.length ? '' : 'To'}
                autocomplete="off"
                bind:value={toInput}
                onfocus={() => onRecipientFocus('to')}
                oninput={(e) => onRecipientInput('to', e)}
                onblur={() => handleRecipientBlur('to')}
                onkeydown={(e) => handleRecipientKeydown('to', e)}
                bind:this={toInputEl}
              />
              <div class="flex items-center gap-1 ml-auto">
                {#if !showCc}
                  <button type="button" class="text-sm md:text-xs text-muted-foreground hover:text-foreground" onclick={() => { showCc = true; tick().then(() => ccInputEl?.focus()); }}>Cc</button>
                {/if}
                {#if !showBcc}
                  <button type="button" class="text-sm md:text-xs text-muted-foreground hover:text-foreground" onclick={() => { showBcc = true; tick().then(() => bccInputEl?.focus()); }}>Bcc</button>
                {/if}
              </div>
            </div>
            {#if showAddressBook === 'to' && recipientSuggestions.length}
              <div class="contact-suggestions absolute top-full left-0 right-0 mt-1 border border-border bg-popover shadow-lg z-10 max-h-[200px] overflow-y-auto">
                {#each recipientSuggestions as contact, idx}
                  <button
                    type="button"
                    class="w-full px-3 py-2 text-left text-sm hover:bg-accent flex flex-col"
                    class:bg-accent={recipientSuggestionIndex === idx}
                    onclick={() => applyRecipientSuggestion('to', contact)}
                  >
                    <span>{(contact as { name?: string; email: string }).name || (contact as { email: string }).email}</span>
                    {#if (contact as { name?: string }).name}
                      <span class="text-xs text-muted-foreground">{(contact as { email: string }).email}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          {#if showCc}
            <div class="relative">
              <div class="flex flex-wrap items-center gap-1.5 min-h-[44px] md:min-h-[38px] px-3 py-2 md:py-1.5 border border-input bg-background transition-colors focus-within:border-primary">
                {#each ccList as rec}
                  <Badge variant="secondary" class="gap-1 pl-2 pr-1 text-base md:text-sm">
                    <span class="cursor-pointer" onclick={() => editRecipient('cc', rec)}>{rec}</span>
                    <button type="button" class="hover:bg-muted-foreground/20 rounded-full p-0.5" onclick={() => removeRecipient('cc', rec)}>
                      <X class="h-3.5 w-3.5 md:h-3 md:w-3" />
                    </button>
                  </Badge>
                {/each}
                <input
                  type="email"
                  class="flex-1 min-w-[120px] bg-transparent border-0 outline-none focus:outline-none focus-visible:outline-none text-base md:text-sm placeholder:text-muted-foreground"
                  placeholder={ccList.length ? '' : 'Cc'}
                  autocomplete="off"
                  bind:value={ccInput}
                  onfocus={() => onRecipientFocus('cc')}
                  oninput={(e) => onRecipientInput('cc', e)}
                  onblur={() => handleRecipientBlur('cc')}
                  onkeydown={(e) => handleRecipientKeydown('cc', e)}
                  bind:this={ccInputEl}
                />
              </div>
              {#if showAddressBook === 'cc' && recipientSuggestions.length}
                <div class="contact-suggestions absolute top-full left-0 right-0 mt-1 border border-border bg-popover shadow-lg z-10 max-h-[200px] overflow-y-auto">
                  {#each recipientSuggestions as contact, idx}
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-accent flex flex-col"
                      class:bg-accent={recipientSuggestionIndex === idx}
                      onclick={() => applyRecipientSuggestion('cc', contact)}
                    >
                      <span>{(contact as { name?: string; email: string }).name || (contact as { email: string }).email}</span>
                      {#if (contact as { name?: string }).name}
                        <span class="text-xs text-muted-foreground">{(contact as { email: string }).email}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if showBcc}
            <div class="relative">
              <div class="flex flex-wrap items-center gap-1.5 min-h-[44px] md:min-h-[38px] px-3 py-2 md:py-1.5 border border-input bg-background transition-colors focus-within:border-primary">
                {#each bccList as rec}
                  <Badge variant="secondary" class="gap-1 pl-2 pr-1 text-base md:text-sm">
                    <span class="cursor-pointer" onclick={() => editRecipient('bcc', rec)}>{rec}</span>
                    <button type="button" class="hover:bg-muted-foreground/20 rounded-full p-0.5" onclick={() => removeRecipient('bcc', rec)}>
                      <X class="h-3.5 w-3.5 md:h-3 md:w-3" />
                    </button>
                  </Badge>
                {/each}
                <input
                  type="email"
                  class="flex-1 min-w-[120px] bg-transparent border-0 outline-none focus:outline-none focus-visible:outline-none text-base md:text-sm placeholder:text-muted-foreground"
                  placeholder={bccList.length ? '' : 'Bcc'}
                  autocomplete="off"
                  bind:value={bccInput}
                  onfocus={() => onRecipientFocus('bcc')}
                  oninput={(e) => onRecipientInput('bcc', e)}
                  onblur={() => handleRecipientBlur('bcc')}
                  onkeydown={(e) => handleRecipientKeydown('bcc', e)}
                  bind:this={bccInputEl}
                />
              </div>
              {#if showAddressBook === 'bcc' && recipientSuggestions.length}
                <div class="contact-suggestions absolute top-full left-0 right-0 mt-1 border border-border bg-popover shadow-lg z-10 max-h-[200px] overflow-y-auto">
                  {#each recipientSuggestions as contact, idx}
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-accent flex flex-col"
                      class:bg-accent={recipientSuggestionIndex === idx}
                      onclick={() => applyRecipientSuggestion('bcc', contact)}
                    >
                      <span>{(contact as { name?: string; email: string }).name || (contact as { email: string }).email}</span>
                      {#if (contact as { name?: string }).name}
                        <span class="text-xs text-muted-foreground">{(contact as { email: string }).email}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          <Input
            type="text"
            placeholder="Subject"
            class="bg-background h-11 md:h-9 text-base md:text-sm"
            bind:value={subject}
            oninput={markDraftDirty}
            onfocus={() => (lastFocusedField = 'subject')}
            bind:this={subjectInputEl}
          />
        </div>

        <div class="flex-1 min-h-[200px] flex flex-col" onclick={focusEditor}>
          {#if !isPlainText}
            <div class="rich-editor prose prose-sm dark:prose-invert max-w-none flex-1 flex flex-col"></div>
          {:else}
            <Textarea
              class="flex-1 min-h-[200px] resize-none"
              rows={14}
              placeholder="Message"
              bind:value={body}
              oninput={markDraftDirty}
              onfocus={() => (lastFocusedField = 'editor')}
              bind:this={plainTextInputEl}
            />
          {/if}
        </div>

        <input type="file" multiple class="attach-input hidden" onchange={(e) => onFilesSelected(null, e)} />
        <input type="file" accept="image/*" class="image-input hidden" onchange={(e) => onImageSelected(null, e)} />

        {#if attachments.length}
          <div class="flex flex-wrap gap-2">
            {#each attachmentCards as card}
              <div class="flex items-center gap-2 px-3 py-2 bg-muted">
                {#if card.isImage && card.previewUrl}
                  <img src={card.previewUrl} alt={card.name as string} class="h-8 w-8 object-cover" />
                {:else}
                  <Badge variant="outline" class="text-xs">{card.badge}</Badge>
                {/if}
                <div class="flex flex-col min-w-0">
                  <span class="text-sm truncate max-w-[150px]">{card.name}</span>
                  <span class="text-xs text-muted-foreground">{card.sizeLabel}</span>
                </div>
                <Button variant="ghost" size="icon" class="h-6 w-6" onclick={() => removeAttachment(card.att)}>
                  <X class="h-3 w-3" />
                </Button>
              </div>
            {/each}
          </div>
        {/if}

        {#if attachmentError || error}
          <Alert.Root variant="destructive">
            <AlertTriangle class="h-4 w-4" />
            <Alert.Description>{attachmentError || error}</Alert.Description>
          </Alert.Root>
        {/if}
      </div>

      <footer class="border-t border-border bg-muted/30 p-3">
        {#if !isPlainText}
          <div class="hidden md:flex flex-wrap items-center gap-1 mb-3 p-2 bg-background border border-border shadow-md" bind:this={formatMenuRef}>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" class={isFormatActive('bold') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleBold().run()}>
                  <Bold class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Bold</p></Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" class={isFormatActive('italic') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleItalic().run()}>
                  <Italic class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Italic</p></Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" class={isFormatActive('underline') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleUnderline().run()}>
                  <UnderlineIcon class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Underline</p></Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" onclick={() => editorView?.chain().focus().unsetAllMarks().clearNodes().run()}>
                  <RemoveFormatting class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Clear formatting</p></Tooltip.Content>
            </Tooltip.Root>

            <Separator orientation="vertical" class="h-6 mx-1" />

            <select class="h-8 px-2 text-xs border border-input bg-background" bind:value={fontFamily} onchange={(e) => setFontFamily((e.target as HTMLSelectElement).value)}>
              {#each FONT_FAMILIES as font}
                <option value={font.value}>{font.label}</option>
              {/each}
            </select>
            <select class="h-8 px-2 text-xs border border-input bg-background" bind:value={fontSize} onchange={(e) => setFontSize((e.target as HTMLSelectElement).value)}>
              {#each FONT_SIZES as size}
                <option value={size}>{size}px</option>
              {/each}
            </select>

            <Separator orientation="vertical" class="h-6 mx-1" />

            <Tooltip.Root>
              <Tooltip.Trigger>
                <label class="relative cursor-pointer h-6 w-6 overflow-hidden">
                  <span class="block h-6 w-6 border border-input" style="background: {textColor}"></span>
                  <input type="color" class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" style="min-width: 0; min-height: 0;" bind:value={textColor} oninput={(e) => setTextColor((e.target as HTMLInputElement).value)} />
                </label>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Text color</p></Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <label class="relative cursor-pointer h-6 w-6 overflow-hidden">
                  <span class="block h-6 w-6 border border-input" style="background: {highlightColor}"></span>
                  <input type="color" class="absolute inset-0 opacity-0 cursor-pointer w-full h-full" style="min-width: 0; min-height: 0;" bind:value={highlightColor} oninput={(e) => setHighlightColor((e.target as HTMLInputElement).value)} />
                </label>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Highlight color</p></Tooltip.Content>
            </Tooltip.Root>

            <Separator orientation="vertical" class="h-6 mx-1" />
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" onclick={openLinkModal}>
                  <Link2 class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Insert link</p></Tooltip.Content>
            </Tooltip.Root>

            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" onclick={() => (showFormatAdvanced = !showFormatAdvanced)}>
                  <MoreVertical class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>More formatting</p></Tooltip.Content>
            </Tooltip.Root>

            {#if showFormatAdvanced}
              <div class="flex items-center gap-1 ml-2">
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={alignment === 'left' ? 'bg-accent' : ''} onclick={() => setAlignment('left')}>
                      <AlignLeft class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Align left</p></Tooltip.Content>
                </Tooltip.Root>
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={alignment === 'center' ? 'bg-accent' : ''} onclick={() => setAlignment('center')}>
                      <AlignCenter class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Align center</p></Tooltip.Content>
                </Tooltip.Root>
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={alignment === 'right' ? 'bg-accent' : ''} onclick={() => setAlignment('right')}>
                      <AlignRight class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Align right</p></Tooltip.Content>
                </Tooltip.Root>
                <Separator orientation="vertical" class="h-6 mx-1" />
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={isFormatActive('bulletList') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleBulletList().run()}>
                      <List class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Bullet list</p></Tooltip.Content>
                </Tooltip.Root>
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={isFormatActive('orderedList') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleOrderedList().run()}>
                      <ListOrdered class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Numbered list</p></Tooltip.Content>
                </Tooltip.Root>
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={isFormatActive('blockquote') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleBlockquote().run()}>
                      <Quote class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Quote</p></Tooltip.Content>
                </Tooltip.Root>
                <Tooltip.Root>
                  <Tooltip.Trigger>
                    <Button variant="ghost" size="icon" class={isFormatActive('code') ? 'bg-accent' : ''} onclick={() => editorView?.chain().focus().toggleCode().run()}>
                      <Code class="h-4 w-4" />
                    </Button>
                  </Tooltip.Trigger>
                  <Tooltip.Content><p>Code</p></Tooltip.Content>
                </Tooltip.Root>
              </div>
            {/if}
          </div>
        {/if}

        <div class="hidden md:flex items-center justify-between gap-2">
          <div class="flex items-center gap-1">
            <div class="flex shrink-0">
              <Button onclick={send} disabled={sending} class="rounded-none min-w-[100px]">
                {sending ? 'Sending...' : 'Send'}
              </Button>
              <div class="relative">
                <button
                  type="button"
                  disabled={sending}
                  class="inline-flex items-center justify-center h-9 px-2 rounded-none border-l border-primary-foreground/20 bg-primary text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
                  onclick={() => showSendDropdown = !showSendDropdown}
                >
                  <ChevronDown class="h-4 w-4" />
                </button>
                {#if showSendDropdown}
                  <div class="absolute bottom-full left-0 mb-1 min-w-[160px] border border-border bg-popover p-1 shadow-lg z-[100]">
                    <button
                      type="button"
                      class="w-full flex items-center gap-2 px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50 disabled:pointer-events-none"
                      disabled={sending}
                      onclick={() => { showSendDropdown = false; openScheduleModal(); }}
                    >
                      <Clock class="h-4 w-4" />
                      Schedule send
                    </button>
                  </div>
                {/if}
              </div>
            </div>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" onclick={triggerFilePicker}>
                  <Paperclip class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Attach file</p></Tooltip.Content>
            </Tooltip.Root>
            <div class="relative" bind:this={emojiButtonRef}>
              <Tooltip.Root>
                <Tooltip.Trigger>
                  <Button variant="ghost" size="icon" onclick={toggleEmoji}>
                    <Smile class="h-4 w-4" />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content><p>Insert emoji</p></Tooltip.Content>
              </Tooltip.Root>
              {#if showEmoji}
                <div class="fixed z-[100] shadow-lg overflow-hidden border border-border" bind:this={emojiPickerRef}>
                  <emoji-picker use:bindEmojiPicker></emoji-picker>
                </div>
              {/if}
            </div>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" onclick={triggerImagePicker}>
                  <ImageIcon class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Insert image</p></Tooltip.Content>
            </Tooltip.Root>
            <Tooltip.Root>
              <Tooltip.Trigger>
                <Button variant="ghost" size="icon" onclick={saveCurrentDraft}>
                  <Save class="h-4 w-4" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content><p>Save draft</p></Tooltip.Content>
            </Tooltip.Root>
          </div>

          <Tooltip.Root>
            <Tooltip.Trigger>
              <Button variant="ghost" size="icon" onclick={promptDiscardDraft}>
                <Trash2 class="h-4 w-4" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content><p>Discard draft</p></Tooltip.Content>
          </Tooltip.Root>
        </div>
      </footer>
    </div>

  <Dialog.Root bind:open={showLinkModal}>
    <Dialog.Content class="sm:max-w-[400px]">
      <Dialog.Header>
        <Dialog.Title>Insert Link</Dialog.Title>
      </Dialog.Header>
      <div class="py-4 space-y-4">
        <div class="space-y-2">
          <Label for="link-url">URL</Label>
          <Input
            id="link-url"
            type="url"
            placeholder="https://example.com"
            bind:value={linkUrl}
            onkeydown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                insertLink();
              }
            }}
            bind:this={linkInputEl}
          />
          <p class="text-xs text-muted-foreground">Leave empty to remove link</p>
        </div>
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onclick={closeLinkModal}>Cancel</Button>
        <Button onclick={insertLink}>{linkUrl.trim() ? 'Insert Link' : 'Remove Link'}</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>

  <Dialog.Root bind:open={showAttachmentReminderModal}>
    <Dialog.Content class="sm:max-w-[400px]">
      <Dialog.Header>
        <Dialog.Title>Forgot attachment?</Dialog.Title>
      </Dialog.Header>
      <div class="py-4">
        <p class="mb-2">
          You mentioned "<strong>{attachmentReminderKeyword}</strong>" but didn't attach any files.
        </p>
        <p class="text-muted-foreground text-sm">
          Would you like to add an attachment, or send anyway?
        </p>
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onclick={() => dismissAttachmentReminder(true)}>Send anyway</Button>
        <Button onclick={() => dismissAttachmentReminder(false)}>Add attachment</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>

  <Dialog.Root bind:open={showDiscardModal}>
    <Dialog.Content class="sm:max-w-[400px]">
      <Dialog.Header>
        <Dialog.Title>Discard draft?</Dialog.Title>
      </Dialog.Header>
      <div class="py-4">
        <p class="text-muted-foreground">
          Your message has unsaved changes. Are you sure you want to discard this draft?
        </p>
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onclick={() => (showDiscardModal = false)}>Cancel</Button>
        <Button variant="destructive" onclick={confirmDiscardDraft}>Discard</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>

  <Dialog.Root bind:open={showScheduleModal}>
    <Dialog.Content class="sm:max-w-[400px]">
      <Dialog.Header>
        <Dialog.Title>Schedule send</Dialog.Title>
      </Dialog.Header>
      <div class="py-4 space-y-4">
        <div class="space-y-2">
          <Label for="schedule-date">Date</Label>
          <Input id="schedule-date" type="date" bind:value={scheduleDate} min={getTodayDateString()} />
        </div>
        <div class="space-y-2">
          <Label for="schedule-time">Time</Label>
          <div class="flex gap-2">
            <div class="relative flex-1">
              <Input
                id="schedule-time"
                type="text"
                placeholder="9:00"
                bind:value={scheduleTime}
                onclick={() => (showScheduleTimePicker = true)}
                onblur={handleTimeInputBlur}
              />
              {#if showScheduleTimePicker}
                <div class="absolute top-full left-0 right-0 mt-1 max-h-[200px] overflow-y-auto border border-border bg-popover shadow-lg z-10">
                  {#each scheduleTimeOptions as opt}
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                      onmousedown={(e) => { e.preventDefault(); scheduleTime = opt.value; showScheduleTimePicker = false; }}
                    >
                      {opt.display}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
            <select class="h-9 px-3 border border-input bg-background" bind:value={scheduleMeridiem}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </select>
          </div>
        </div>
        {#if error}
          <Alert.Root variant="destructive">
            <AlertTriangle class="h-4 w-4" />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onclick={closeScheduleModal}>Cancel</Button>
        <Button onclick={proceedToScheduleConfirm} disabled={!scheduleDate || !scheduleTime}>Continue</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>

  <Dialog.Root bind:open={showScheduleConfirm}>
    {@const scheduleInfo = getScheduleDisplayInfo()}
    <Dialog.Content class="sm:max-w-[400px]">
      <Dialog.Header>
        <Dialog.Title>Confirm scheduled send</Dialog.Title>
      </Dialog.Header>
      <div class="py-4 space-y-3">
        <div class="flex justify-between text-sm">
          <span class="text-muted-foreground">To:</span>
          <span class="text-right">{scheduleInfo?.recipients || ''}</span>
        </div>
        <div class="flex justify-between text-sm">
          <span class="text-muted-foreground">Subject:</span>
          <span class="text-right">{scheduleInfo?.subject || ''}</span>
        </div>
        <Separator />
        <div class="flex justify-between text-sm font-medium">
          <span>Send on:</span>
          <span class="text-primary">{scheduleInfo?.date || ''} at {scheduleInfo?.time || ''}</span>
        </div>
        {#if error}
          <Alert.Root variant="destructive">
            <AlertTriangle class="h-4 w-4" />
            <Alert.Description>{error}</Alert.Description>
          </Alert.Root>
        {/if}
      </div>
      <Dialog.Footer>
        <Button variant="ghost" onclick={backToSchedulePicker}>Back</Button>
        <Button onclick={sendLater} disabled={sending}>{sending ? 'Scheduling...' : 'Schedule Send'}</Button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}

{#if minimizedDrafts.length}
  <div class="fixed bottom-4 right-4 z-40 flex flex-col gap-2">
    {#each minimizedDrafts as draft ((draft as { key: string }).key)}
      <button
        type="button"
        class="flex items-center gap-2 px-3 py-2 bg-background border border-border shadow-md hover:bg-accent transition-colors cursor-pointer"
        onclick={() => restoreMinimizedDraft(draft)}
        onkeydown={(e) => handleMinimizedKeydown(e, draft)}
      >
        <div class="flex flex-col items-start min-w-0 flex-1">
          <span class="text-sm font-medium truncate max-w-[180px]">{getMinimizedTitle(draft)}</span>
          <div class="flex items-center gap-2 text-xs text-muted-foreground">
            {#if getMinimizedStatusLabel(draft)}
              <span>{getMinimizedStatusLabel(draft)}</span>
            {/if}
            {#if getMinimizedMeta(draft)}
              <span>{getMinimizedMeta(draft)}</span>
            {/if}
          </div>
        </div>
        {#if (draft as { data: { attachments?: unknown[] } })?.data?.attachments?.length}
          <Paperclip class="h-4 w-4 text-muted-foreground shrink-0" />
        {/if}
        <Button
          variant="ghost"
          size="icon"
          class="h-6 w-6 shrink-0"
          onclick={(e) => { e.stopPropagation(); discardMinimizedDraft(draft); }}
        >
          <Trash2 class="h-3 w-3" />
        </Button>
      </button>
    {/each}
  </div>
{/if}
</Tooltip.Provider>

<style>
  /* TipTap editor styles */
  :global(.rich-editor .ProseMirror) {
    outline: none;
    flex: 1;
    min-height: 200px;
  }

  :global(.rich-editor .ProseMirror p.is-editor-empty:first-child::before) {
    content: attr(data-placeholder);
    float: left;
    color: #9ca3af;
    pointer-events: none;
    height: 0;
    font-weight: 400;
  }

  :global(.rich-editor .ProseMirror blockquote) {
    border-left: 3px solid hsl(var(--border));
    padding-left: 1rem;
    margin-left: 0;
    color: hsl(var(--muted-foreground));
  }

  :global(.rich-editor .ProseMirror pre) {
    background: hsl(var(--muted));
    border-radius: 0.375rem;
    padding: 0.75rem 1rem;
    font-family: monospace;
  }

  :global(.rich-editor .ProseMirror code) {
    background: hsl(var(--muted));
    border-radius: 0.25rem;
    padding: 0.125rem 0.25rem;
    font-family: monospace;
    font-size: 0.875em;
  }

  :global(.rich-editor .ProseMirror img) {
    max-width: 100%;
    height: auto;
  }

  :global(.rich-editor .ProseMirror ul) {
    list-style-type: disc;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }

  :global(.rich-editor .ProseMirror ol) {
    list-style-type: decimal;
    padding-left: 1.5rem;
    margin: 0.5rem 0;
  }

  :global(.rich-editor .ProseMirror li) {
    margin: 0.25rem 0;
  }

  :global(.rich-editor .ProseMirror li p) {
    margin: 0;
  }

  :global(.rich-editor .ProseMirror a) {
    color: hsl(var(--primary));
    text-decoration: underline;
    cursor: pointer;
  }

  :global(.rich-editor .ProseMirror a:hover) {
    text-decoration: underline;
    opacity: 0.8;
  }

  :global(.rich-editor .ProseMirror table) {
    border-collapse: collapse;
    margin: 0;
    overflow: hidden;
    table-layout: fixed;
    width: 100%;
  }

  :global(.rich-editor .ProseMirror th),
  :global(.rich-editor .ProseMirror td) {
    border: 1px solid hsl(var(--border));
    padding: 0.5rem;
    vertical-align: top;
  }

  :global(.rich-editor .ProseMirror th) {
    background: hsl(var(--muted));
    font-weight: 600;
  }

  /* Raw quote styles */
  :global(.raw-quote) {
    border-left: 3px solid hsl(var(--border));
    padding-left: 1rem;
    margin: 1rem 0;
    color: hsl(var(--muted-foreground));
  }

  :global(.raw-quote-inner) {
    font-size: 0.875rem;
  }

  /* Emoji picker styles */
  :global(emoji-picker) {
    --border-size: 1px;
    --border-radius: 0.5rem;
  }

  :global(emoji-picker.light) {
    --background: #ffffff;
    --border-color: #e2e8f0;
    --input-border-color: #cbd5e1;
    --input-font-color: #0f172a;
    --input-placeholder-color: #64748b;
    --category-font-color: #475569;
    --indicator-color: #00aff8;
    --outline-color: #64748b;
    --button-active-background: #e2e8f0;
    --button-hover-background: #f1f5f9;
  }

  :global(emoji-picker.dark) {
    --background: #1e293b;
    --border-color: #334155;
    --input-border-color: #475569;
    --input-font-color: #e2e8f0;
    --input-placeholder-color: #94a3b8;
    --category-font-color: #94a3b8;
    --indicator-color: #00aff8;
    --outline-color: #94a3b8;
    --button-active-background: #475569;
    --button-hover-background: #334155;
  }
</style>
