/**
 * Attaching files in the terminal.
 *
 * File fields. TermDOM draws an <input type="file"> but has no file chooser
 * behind it, so the compose window's Attach button (which clicks its hidden
 * file input) did nothing. Here a click on any file input opens the
 * system's file dialog (file-picker.ts) or, where there is none (SSH, no
 * display), a one-line prompt at the bottom of the screen:
 *
 *   File to attach: ~/Documents/rep_
 *   Tab Complete   Enter Attach   Esc Cancel
 *
 * The chosen files are read from disk and handed to the input as its files,
 * with the input and change events a browser sends, so the app's own code
 * reads them as it does on the web.
 *
 * Drag and drop. A terminal turns a file dropped on its window into its
 * path, pasted as text. A paste in the compose window that is nothing but
 * paths, at least one of which exists, attaches those files instead of
 * inserting the text. The To, Cc, Bcc and Subject fields are left alone:
 * text pasted there is meant as text. A path that should go into the
 * message as text can be typed. Folders, missing files and files that
 * would take the message past the size limit are skipped, and the bottom
 * row says why.
 *
 * Ctrl+O in the compose window opens the file dialog too.
 */
import { File } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {
  completePath,
  currentPathContext,
  parseDroppedPaths,
  type PathContext,
} from './file-paths';
import {
  pickWithSystemDialog,
  type PickerEnvironment,
  type PickerRequest,
  type RunningPick,
} from './file-picker';
import { tr } from './i18n';
import type { AnyRecord } from './types';

/**
 * The Forward Email server takes messages up to 50 MB
 * (SMTP_MESSAGE_MAX_SIZE), and attachments travel base64-encoded, a third
 * larger than the files. Files that add up to more than this cannot be
 * sent. The web client sets no limit of its own; reading a file far past
 * this into memory (twice, as bytes and as base64) would also strain the
 * terminal client.
 */
export const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENT_BYTES = Math.floor((MAX_MESSAGE_BYTES * 3) / 4);

const COMPOSE = '[data-testid="compose-modal"]';
const PROMPT_ID = 'fe-terminal-attach';
// Set on the root element while a system file dialog is open (hints.ts).
export const PICKING_ATTRIBUTE = 'data-fe-picking';

const MIME_TYPES: Record<string, string> = {
  '7z': 'application/x-7z-compressed',
  aac: 'audio/aac',
  avi: 'video/x-msvideo',
  avif: 'image/avif',
  bmp: 'image/bmp',
  bz2: 'application/x-bzip2',
  css: 'text/css',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  eml: 'message/rfc822',
  epub: 'application/epub+zip',
  flac: 'audio/flac',
  gif: 'image/gif',
  gz: 'application/gzip',
  heic: 'image/heic',
  heif: 'image/heif',
  htm: 'text/html',
  html: 'text/html',
  ico: 'image/vnd.microsoft.icon',
  ics: 'text/calendar',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  js: 'text/javascript',
  json: 'application/json',
  key: 'application/vnd.apple.keynote',
  log: 'text/plain',
  m4a: 'audio/mp4',
  md: 'text/markdown',
  mjs: 'text/javascript',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  mpeg: 'video/mpeg',
  numbers: 'application/vnd.apple.numbers',
  odp: 'application/vnd.oasis.opendocument.presentation',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odt: 'application/vnd.oasis.opendocument.text',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  opus: 'audio/opus',
  pages: 'application/vnd.apple.pages',
  pdf: 'application/pdf',
  png: 'image/png',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  rar: 'application/vnd.rar',
  rtf: 'application/rtf',
  svg: 'image/svg+xml',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  ts: 'text/plain',
  txt: 'text/plain',
  vcf: 'text/vcard',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'video/webm',
  webp: 'image/webp',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  zip: 'application/zip',
};

/**
 * The type a browser gives a picked file, from its extension; '' when
 * unknown, which the app sends as application/octet-stream.
 */
export function mimeTypeOf(name: string): string {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME_TYPES[ext] ?? '';
}

/** A size as the compose window writes it: 512 B, 12 KB, 1.5 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

export interface ReadFiles {
  files: File[];
  /** What was skipped and why, one line each. */
  problems: string[];
}

/**
 * Reads files from disk as File objects, skipping folders, missing and
 * unreadable files, a file larger than `limit` on its own, and files that
 * would take the message (`already` bytes of attachments, plus the files
 * read here) over `limit`.
 */
export async function readFiles(
  paths: string[],
  { limit = MAX_ATTACHMENT_BYTES, already = 0 }: { limit?: number; already?: number } = {},
): Promise<ReadFiles> {
  const files: File[] = [];
  const problems: string[] = [];
  let total = already;
  for (const file of paths) {
    const name = path.basename(file) || file;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      problems.push(
        code === 'ENOENT' || code === 'ENOTDIR'
          ? tr('terminal.attach.notFound', { name: file })
          : tr('terminal.attach.unreadable', { name }),
      );
      continue;
    }
    if (stat.isDirectory()) {
      problems.push(tr('terminal.attach.folder', { name }));
      continue;
    }
    if (!stat.isFile()) {
      problems.push(tr('terminal.attach.notFile', { name }));
      continue;
    }
    if (stat.size > limit) {
      problems.push(
        tr('terminal.attach.tooLarge', {
          name,
          size: formatSize(stat.size),
          limit: formatSize(limit),
        }),
      );
      continue;
    }
    if (total + stat.size > limit) {
      problems.push(tr('terminal.attach.wouldExceed', { name, limit: formatSize(limit) }));
      continue;
    }
    let data: Buffer;
    try {
      data = await fs.promises.readFile(file);
    } catch {
      problems.push(tr('terminal.attach.unreadable', { name }));
      continue;
    }
    total += data.length;
    files.push(
      new File([data as Uint8Array<ArrayBuffer>], name, {
        type: mimeTypeOf(name),
        lastModified: stat.mtimeMs,
      }),
    );
  }
  return { files, problems };
}

/** A FileList of TermDOM's, holding `files`. */
function fileListOf(win: AnyRecord, files: File[]): AnyRecord {
  const list = Object.create(win.FileList.prototype);
  files.forEach((file, index) => Object.defineProperty(list, index, { value: file }));
  Object.defineProperties(list, {
    length: { value: files.length },
    item: { value: (index: number) => files[index] ?? null },
    [Symbol.iterator]: { value: () => files[Symbol.iterator]() },
  });
  return list;
}

/** Gives a file input its files, as a browser does once the user picks them. */
export function setInputFiles(win: AnyRecord, input: AnyRecord, files: File[]) {
  input.files = fileListOf(win, files);
  input.dispatchEvent(new win.Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
}

function isShown(el: AnyRecord | null): boolean {
  const rect = el?.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.height > 0);
}

const isFileInput = (el: AnyRecord | null) =>
  el?.localName === 'input' && String(el.type).toLowerCase() === 'file';

const exists = (file: string) => {
  try {
    fs.statSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether Ctrl+O, the attach key, has been given to one of the app's
 * shortcuts in Settings › Keyboard Shortcuts, which then comes first.
 */
export function attachKeyTaken(): boolean {
  const manager = (globalThis as Record<string, unknown>).__forwardemailShortcuts as
    | { getShortcutsList(): Array<{ originalKey?: string }> }
    | undefined;
  return Boolean(
    manager
      ?.getShortcutsList()
      .some((shortcut) => shortcut.originalKey?.replace(/\s+/g, '') === 'ctrl+o'),
  );
}

export interface AttachmentOptions {
  context?: PathContext;
  /** Process environment for choosing a dialog (SSH, display, override). */
  env?: NodeJS.ProcessEnv;
  /** Where typed relative paths start. */
  cwd?: () => string;
  /** Opens the system's file dialog; file-picker.ts by default. */
  pick?: (request: PickerRequest, environment: PickerEnvironment) => RunningPick;
  /** The most a message's attachments may add up to (tests). */
  limit?: number;
}

// The compose window says how many bytes of attachments its draft holds
// (Compose.svelte), the ones attached here and any it got another way.
const BYTES_ATTRIBUTE = 'data-attachment-bytes';
// How long a delivery waits for the compose window to count the new files.
const COUNT_WAIT_MS = 5000;

export function installAttachments(win: AnyRecord, options: AttachmentOptions = {}) {
  const document = win.document as AnyRecord;
  const context = options.context ?? currentPathContext();
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? (() => process.cwd());
  const pick = options.pick ?? pickWithSystemDialog;
  const limit = options.limit ?? MAX_ATTACHMENT_BYTES;

  const refreshHints = () => win.dispatchEvent(new win.CustomEvent('fe-terminal-hints'));
  // The bottom row says what happened; without it (--no-hints) a toast does.
  const report = (lines: string[], problem: boolean) => {
    if (lines.length === 0) return;
    const text = lines.map((line) => line.replace(/[.\s]+$/, '')).join('. ');
    if (document.getElementById('fe-terminal-hints')) {
      win.dispatchEvent(
        new win.CustomEvent('fe-terminal-notice', { detail: { text, failed: problem } }),
      );
    } else {
      win.dispatchEvent(
        new win.CustomEvent('fe:mail-service-toast', {
          detail: { message: text, type: problem ? 'error' : 'success' },
        }),
      );
    }
  };

  const composeShown = (): AnyRecord | null => {
    const compose = document.querySelector(COMPOSE);
    return compose && isShown(compose) ? compose : null;
  };
  const attachInputOf = (compose: AnyRecord): AnyRecord | null =>
    compose.querySelector('input.attach-input') ??
    compose.querySelector('input[type="file"][multiple]');

  // The attachments already on the draft that `input` belongs to.
  const countedBytes = (input: AnyRecord): string | null =>
    input.closest?.(`[${BYTES_ATTRIBUTE}]`)?.getAttribute(BYTES_ATTRIBUTE) ?? null;
  const waitForCount = async (input: AnyRecord, before: string | null) => {
    const started = Date.now();
    while (countedBytes(input) === before && Date.now() - started < COUNT_WAIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  // Reads `paths` and gives the readable files to `input`. One delivery at
  // a time: each counts the files the one before it attached.
  let deliveries: Promise<void> = Promise.resolve();
  const attachPaths = (input: AnyRecord, paths: string[]) => {
    deliveries = deliveries
      .then(async () => {
        const multiple = input.hasAttribute('multiple');
        const before = countedBytes(input);
        const { files, problems } = await readFiles(multiple ? paths : paths.slice(0, 1), {
          limit,
          already: Number(before) || 0,
        });
        const lines: string[] = [];
        if (files.length > 0 && input.isConnected) {
          setInputFiles(win, input, files);
          lines.push(
            tr('terminal.attach.attached', { names: files.map((f) => f.name).join(', ') }),
          );
        }
        report([...lines, ...problems], problems.length > 0);
        const added = files.reduce((sum, file) => sum + file.size, 0);
        if (input.isConnected && added > 0 && before !== null) await waitForCount(input, before);
      })
      .catch((error) => console.warn('[attach] failed:', error));
    return deliveries;
  };

  // --- The typed path prompt -------------------------------------------

  let prompt: { close(result: string[] | null): void } | null = null;

  const askForPaths = (): Promise<string[] | null> =>
    new Promise((resolve) => {
      const previous = document.activeElement;
      const panel = document.createElement('div');
      panel.id = PROMPT_ID;
      const matches = document.createElement('div');
      matches.className = 'fe-attach-matches';
      matches.hidden = true;
      const row = document.createElement('div');
      row.className = 'fe-attach-row';
      const label = document.createElement('label');
      label.className = 'fe-attach-label';
      label.textContent = tr('terminal.attach.promptLabel');
      const field = document.createElement('input');
      field.type = 'text';
      field.className = 'fe-attach-input';
      field.setAttribute('autocomplete', 'off');
      field.setAttribute('spellcheck', 'false');
      field.setAttribute('aria-label', tr('terminal.attach.promptLabel'));
      row.append(label, field);
      panel.append(matches, row);
      document.documentElement.append(panel);

      let closed = false;
      const close = (result: string[] | null) => {
        if (closed) return;
        closed = true;
        prompt = null;
        panel.remove();
        if (previous?.isConnected && previous !== document.body) previous.focus?.();
        refreshHints();
        resolve(result);
      };
      prompt = { close };
      const read = (text: string) =>
        parseDroppedPaths(text, context, { exists, relativeTo: cwd() });

      // A completion still being looked up when Enter is pressed is
      // applied first, as it would have been a moment later.
      let completing: Promise<void> = Promise.resolve();
      field.addEventListener('keydown', (event: AnyRecord) => {
        const key = String(event.key);
        if (key !== 'Enter' && key !== 'Escape' && key !== 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        if (key === 'Escape') return close(null);
        if (key === 'Enter') {
          void completing.then(() => {
            const value = String(field.value).trim();
            close(value ? (read(value) ?? [value]) : null);
          });
          return;
        }
        if (event.shiftKey) return;
        const typed = String(field.value);
        completing = completing
          .then(() => completePath(typed, { ...context, cwd: cwd() }))
          .then((completion) => {
            // Typing went on meanwhile: that text stays.
            if (closed || String(field.value) !== typed) return;
            field.value = completion.value;
            field.setSelectionRange?.(completion.value.length, completion.value.length);
            matches.textContent = completion.matches.join('  ');
            matches.hidden = completion.matches.length === 0;
          })
          .catch(() => {});
      });
      // The listed completions belong to the text they were made for.
      field.addEventListener('input', () => {
        matches.hidden = true;
      });
      // Files dropped on the prompt are attached at once.
      field.addEventListener('paste', (event: AnyRecord) => {
        const text = String(event.clipboardData?.getData('text/plain') ?? '');
        const paths = parseDroppedPaths(text, context, { exists });
        if (!paths || !paths.some(exists)) return;
        event.preventDefault();
        close(paths);
      });
      // Clicking elsewhere cancels.
      field.addEventListener('blur', () =>
        setTimeout(() => {
          if (document.activeElement !== field) close(null);
        }, 0),
      );
      field.focus();
      refreshHints();
    });

  // --- Choosing files for a file input ---------------------------------

  let picking: RunningPick | null = null;
  let busy = false;

  const choosePaths = async (multiple: boolean): Promise<string[] | null> => {
    const request = { title: tr('terminal.attach.dialogTitle'), multiple };
    picking = pick(request, { ...context, env });
    if (picking.dialog) {
      document.documentElement.setAttribute(PICKING_ATTRIBUTE, '');
      refreshHints();
    }
    let result;
    try {
      result = await picking.result;
    } finally {
      if (picking?.dialog) {
        document.documentElement.removeAttribute(PICKING_ATTRIBUTE);
        refreshHints();
      }
      picking = null;
    }
    if (result.status === 'picked') return result.paths;
    if (result.status === 'cancelled') return null;
    console.info('[attach] no file dialog:', result.reason);
    return askForPaths();
  };

  const chooseFor = async (input: AnyRecord) => {
    if (busy || input.disabled) return;
    busy = true;
    try {
      const paths = await choosePaths(input.hasAttribute('multiple'));
      if (!paths || paths.length === 0) {
        if (input.isConnected) input.dispatchEvent(new win.Event('cancel', { bubbles: true }));
        return;
      }
      await attachPaths(input, paths);
    } catch (error) {
      console.warn('[attach] failed:', error);
    } finally {
      busy = false;
    }
  };

  // A click on a file input, by the user or by the app's own Attach button
  // (input.click()), opens the chooser. So does showPicker().
  win.addEventListener(
    'click',
    (event: AnyRecord) => {
      if (!isFileInput(event.target)) return;
      event.preventDefault();
      void chooseFor(event.target);
    },
    true,
  );
  const inputProto = win.HTMLInputElement?.prototype as AnyRecord | undefined;
  if (inputProto) {
    const showPicker = inputProto.showPicker;
    Object.defineProperty(inputProto, 'showPicker', {
      configurable: true,
      writable: true,
      value(this: AnyRecord) {
        if (isFileInput(this)) return void chooseFor(this);
        return showPicker?.call(this);
      },
    });
  }

  // --- Keys --------------------------------------------------------------

  win.addEventListener(
    'keydown',
    (event: AnyRecord) => {
      // Esc while the system dialog is open closes it, as Cancel would.
      if (event.key === 'Escape' && picking) {
        event.preventDefault();
        event.stopImmediatePropagation();
        picking.cancel();
        return;
      }
      if (
        String(event.key).toLowerCase() !== 'o' ||
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      const compose = composeShown();
      const input = compose && attachInputOf(compose);
      if (!input || attachKeyTaken() || prompt) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void chooseFor(input);
    },
    true,
  );

  // --- Drag and drop -----------------------------------------------------

  win.addEventListener(
    'paste',
    (event: AnyRecord) => {
      const compose = composeShown();
      if (!compose) return;
      const target = event.target as AnyRecord | null;
      const onPage = target === document.body || target === document.documentElement;
      if (!onPage && !compose.contains(target)) return;
      // To, Cc, Bcc and Subject take what is pasted as text.
      if (target?.localName === 'input') return;
      const text = String(event.clipboardData?.getData('text/plain') ?? '');
      const paths = parseDroppedPaths(text, context, { exists });
      if (!paths || !paths.some(exists)) return;
      const input = attachInputOf(compose);
      if (!input) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void attachPaths(input, paths);
    },
    true,
  );
}
