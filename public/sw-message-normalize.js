/* GENERATED FILE — do not edit by hand.
 * Source:  src/workers/sw-normalize-entry.ts -> src/utils/sync-helpers.ts (normalizeMessageForCache)
 * Rebuild: pnpm run gen:sw-normalize  (also runs automatically in prebuild)
 *
 * Loaded via importScripts (workbox.config.cjs) BEFORE sw-sync.js; defines the
 * global self.normalizeMessageRecord(raw, folder, account). storage.js/Dexie are
 * stubbed out of this bundle. Parity with the canonical normalizer is enforced
 * by tests/unit/message-normalize-contract.test.ts.
 */
var __swNormalize = function(exports) {
  "use strict";
  const Local = { get: () => null, set: () => {
  }, remove: () => {
  } };
  const normalizeCharset = (value = "") => {
    const lower = String(value || "").trim().toLowerCase();
    if (!lower) return "utf-8";
    if (lower === "utf8") return "utf-8";
    if (lower === "us-ascii") return "utf-8";
    if (lower === "latin1") return "iso-8859-1";
    return lower;
  };
  const decodeBytes = (bytes, charset) => {
    if (!bytes || !bytes.length) return "";
    const normalized = normalizeCharset(charset);
    const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    if (typeof TextDecoder === "function") {
      try {
        return new TextDecoder(normalized).decode(view);
      } catch {
      }
    }
    return String.fromCharCode(...view);
  };
  const decodeQEncoded = (input, charset) => {
    const cleaned = String(input || "").replace(/_/g, " ");
    const bytes = [];
    for (let i = 0; i < cleaned.length; i += 1) {
      const ch = cleaned[i];
      if (ch === "=" && i + 2 < cleaned.length) {
        const hex = cleaned.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      bytes.push(ch.charCodeAt(0));
    }
    return decodeBytes(bytes, charset);
  };
  const decodeBEncoded = (input, charset) => {
    const cleaned = String(input || "").replace(/\s+/g, "");
    try {
      const binary = atob(cleaned);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      return decodeBytes(bytes, charset);
    } catch {
      return input;
    }
  };
  function decodeMimeHeader(value = "") {
    if (!value || typeof value !== "string") return value || "";
    const encodedWord = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
    return value.replace(encodedWord, (match, charset, encoding, text) => {
      if (!text) return match;
      const decoded = encoding.toLowerCase() === "q" ? decodeQEncoded(text, charset) : decodeBEncoded(text, charset);
      if (decoded === "" || decoded == null) return match;
      return decoded;
    });
  }
  const decodeDisplayText = (value) => {
    if (typeof value !== "string") return "";
    return decodeMimeHeader(value).trim();
  };
  const splitAddressString = (str) => {
    const parts = [];
    let current = "";
    let inQuotes = false;
    let inAngle = 0;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ch === '"' && str[i - 1] !== "\\") {
        inQuotes = !inQuotes;
        current += ch;
      } else if (!inQuotes && ch === "<") {
        inAngle++;
        current += ch;
      } else if (!inQuotes && ch === ">" && inAngle > 0) {
        inAngle--;
        current += ch;
      } else if (!inQuotes && inAngle === 0 && ch === ",") {
        const trimmed2 = current.trim();
        if (trimmed2) parts.push(trimmed2);
        current = "";
      } else {
        current += ch;
      }
    }
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    return parts;
  };
  const recipientsToList = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(Boolean);
    if (typeof value === "string" && value.includes(",")) {
      return splitAddressString(value).filter(Boolean);
    }
    return [value].filter(Boolean);
  };
  const extractAddressList = (msg, field) => {
    if (!msg) return [];
    const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const findHeaderValue = (headers, headerField2) => {
      if (!headers) return "";
      if (typeof headers === "string") {
        const match = headers.match(
          new RegExp(`^${escapeRegExp(headerField2)}:\\s*([^\\r\\n]*(?:\\r?\\n[\\t ].*)*)`, "im")
        );
        if (!match) return "";
        return match[1].replace(/\r?\n[\t ]+/g, " ").trim();
      }
      if (typeof headers === "object") {
        if (headers[headerField2]) return headers[headerField2];
        const lower = headerField2.toLowerCase();
        if (headers[lower]) return headers[lower];
        const matchKey = Object.keys(headers).find((key) => key.toLowerCase() === lower);
        return matchKey ? headers[matchKey] : "";
      }
      return "";
    };
    const findHeaderLineValue = (lines, headerField2) => {
      if (!Array.isArray(lines)) return "";
      const lower = headerField2.toLowerCase();
      const matched = lines.find((line) => {
        const key = String(line?.key || "").toLowerCase();
        if (key) return key === lower;
        const lineText = String(line?.line || "").toLowerCase();
        return lineText.startsWith(`${lower}:`);
      });
      if (!matched?.line) return "";
      return String(matched.line).replace(new RegExp(`^${escapeRegExp(headerField2)}:\\s*`, "i"), "").trim();
    };
    const normalizeHeaderValue = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) return value;
      if (typeof value === "object" && value !== null) {
        const obj = value;
        if (Array.isArray(obj.value) && obj.value.length) return obj.value;
        if (obj.text || obj.Text) return [obj.text || obj.Text];
        if (obj.name || obj.Name || obj.address || obj.Address || obj.email || obj.Email || obj.Display) {
          return [obj];
        }
        if (typeof obj.value === "string" && obj.value.trim()) return [obj.value];
      }
      return recipientsToList(value);
    };
    const nmVal = msg?.nodemailer?.[field];
    if (nmVal) {
      if (Array.isArray(nmVal.value) && nmVal.value.length) {
        return nmVal.value;
      }
      if (typeof nmVal.text === "string" && nmVal.text.trim()) {
        return [nmVal.text];
      }
      const normalized = normalizeHeaderValue(nmVal);
      if (normalized.length) return normalized;
    }
    const headerField = field === "replyTo" || field === "reply_to" ? "reply-to" : field;
    const headerValue = findHeaderValue(msg?.nodemailer?.headers, headerField) || findHeaderValue(msg?.headers, headerField) || findHeaderValue(msg?.header, headerField);
    if (headerValue) {
      const normalized = normalizeHeaderValue(headerValue);
      if (normalized.length) return normalized;
    }
    const headerLineValue = findHeaderLineValue(msg?.nodemailer?.headerLines, headerField) || findHeaderLineValue(msg?.headerLines, headerField);
    if (headerLineValue) {
      const normalized = normalizeHeaderValue(headerLineValue);
      if (normalized.length) return normalized;
    }
    const rawHeaderValue = findHeaderValue(msg?.raw, headerField);
    if (rawHeaderValue) {
      const normalized = normalizeHeaderValue(rawHeaderValue);
      if (normalized.length) return normalized;
    }
    const env = msg?.nodemailer?.envelope;
    if (env) {
      if (field === "from" && env.from) return [env.from];
      if ((field === "to" || field === "recipients") && Array.isArray(env.to)) return env.to;
    }
    const bareEnv = msg?.envelope;
    if (bareEnv) {
      if (field === "from" && bareEnv.from) return [bareEnv.from];
      if ((field === "to" || field === "recipients") && Array.isArray(bareEnv.to)) return bareEnv.to;
    }
    const altField = field ? `${field[0].toUpperCase()}${field.slice(1)}` : field;
    const upperField = field ? field.toUpperCase() : field;
    const snakeField = field === "replyTo" ? "reply_to" : void 0;
    const directValue = msg?.[field] ?? (altField ? msg?.[altField] : void 0) ?? (upperField ? msg?.[upperField] : void 0) ?? (snakeField ? msg?.[snakeField] : void 0);
    if (directValue) return normalizeHeaderValue(directValue);
    const alt = msg?.[`${field}_address`];
    if (Array.isArray(alt)) return alt;
    if (alt) return recipientsToList(alt);
    if (msg?.[field]) return recipientsToList(msg[field]);
    if (field === "from") {
      const senderHeader = findHeaderValue(msg?.nodemailer?.headers, "sender") || findHeaderValue(msg?.headers, "sender") || findHeaderValue(msg?.header, "sender") || findHeaderLineValue(msg?.nodemailer?.headerLines, "sender") || findHeaderLineValue(msg?.headerLines, "sender") || findHeaderValue(msg?.raw, "sender");
      if (senderHeader) {
        const normalized = normalizeHeaderValue(senderHeader);
        if (normalized.length) return normalized;
      }
      const senderField = msg?.sender ?? msg?.Sender;
      if (senderField) {
        const normalized = normalizeHeaderValue(senderField);
        if (normalized.length) return normalized;
      }
    }
    return [];
  };
  const toDisplayAddress = (addr) => {
    if (!addr) return "";
    if (typeof addr === "string") return decodeDisplayText(addr);
    if (Array.isArray(addr)) {
      if (addr[0]) return toDisplayAddress(addr[0]);
      return "";
    }
    const obj = addr;
    if (Array.isArray(obj.value) && obj.value[0])
      return toDisplayAddress(obj.value[0]);
    const name = decodeDisplayText(obj.name || obj.Name || obj.display || obj.Display || "");
    const address = obj.address || obj.Address || obj.email || obj.Email || "";
    if (name && address) {
      return `${name} <${address}>`;
    }
    if (name) return name;
    if (address) return address;
    if (typeof obj.value === "string") return decodeDisplayText(obj.value);
    return decodeDisplayText(
      obj.address || obj.email || (typeof obj.value === "string" ? obj.value : "") || obj.text || ""
    );
  };
  const displayAddresses = (list) => (list || []).map((addr) => toDisplayAddress(addr)).filter(Boolean);
  const RESERVED_FLAGS = new Set(
    [
      "NonJunk",
      "Junk",
      "NotJunk",
      "$NotJunk",
      "$MDNSent",
      "\\Seen",
      "\\Flagged",
      "\\Answered",
      "\\Draft",
      "\\Drafts",
      "\\Trash",
      "\\Junk",
      "\\Sent",
      "\\Inbox",
      "\\Archive",
      "$Forwarded"
    ].map((f) => f.toLowerCase())
  );
  const HIDDEN_PATTERNS = [
    /^\$label\d+$/i,
    /^\$maillabel\d+$/i,
    /^\$mailflagbit\d+$/i,
    /^\d+$/i,
    /^calendar$/i,
    /^purge_issue$/i,
    /^purge-issue$/i,
    /^purge issue$/i,
    /^enterprise$/i,
    /^webmail$/i,
    /^notjunk$/i,
    /^\$notjunk$/i,
    // Structural keyword-object keys that leak through when IMAP returns
    // `keywords: { data: true, type: true, ... }` rather than a label list.
    /^data$/i,
    /^type$/i,
    /^content$/i,
    /^size$/i,
    /^flags$/i,
    /^uid$/i,
    /^id$/i
  ];
  function isHiddenLabel(flag) {
    const key = String(flag ?? "").trim();
    if (!key) return true;
    if (/^\[\s*\]$/.test(key)) return true;
    const lower = key.toLowerCase();
    if (RESERVED_FLAGS.has(lower)) return true;
    if (key.startsWith("\\") || key.startsWith("$")) return true;
    return HIDDEN_PATTERNS.some((re) => re.test(key));
  }
  function decodeLabelBuffer(value) {
    if (!value || typeof value !== "object" || value.type !== "Buffer" || !Array.isArray(value.data)) {
      return null;
    }
    const data = value.data;
    try {
      const bytes = Uint8Array.from(data, (b) => Number(b) & 255);
      const decoder = new TextDecoder();
      const open = bytes.indexOf(91);
      const close = bytes.lastIndexOf(93);
      if (open !== -1 && close > open) {
        const parsed = JSON.parse(decoder.decode(bytes.subarray(open, close + 1)));
        if (Array.isArray(parsed)) {
          return parsed.map((l) => String(l ?? "").trim()).filter(Boolean);
        }
      }
      const tokens = decoder.decode(bytes).match(/"([^"\\]+)"/g);
      if (tokens) return tokens.map((t) => t.slice(1, -1).trim()).filter(Boolean);
    } catch {
    }
    return [];
  }
  function stripHtmlToPlaintext(html, maxLen = 160) {
    if (!html) return "";
    const cleaned = String(html).replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<br\s*\/?>/gi, " ").replace(/<\/?(p|div|li|tr|td|th|h[1-6]|blockquote|pre)[^>]*>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#039;/gi, "'").replace(/&[#\w]+;/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
  }
  const accountKey = (account) => account || Local.get("email") || "default";
  const isDebugFromField = () => {
    try {
      return Local.get("debug_perf") === "1" || Local.get("debug_from_field") === "1";
    } catch {
      return false;
    }
  };
  function deriveFromFallback(raw) {
    const headers = raw.nodemailer?.headers || raw.nodemailer?.Headers || {};
    const probeHeader = (name) => {
      const lower = name.toLowerCase();
      const direct = headers[name] || headers[lower];
      if (typeof direct === "string" && direct.trim()) return direct.trim();
      const matchKey = Object.keys(headers).find((key) => key.toLowerCase() === lower);
      if (matchKey && typeof headers[matchKey] === "string") return headers[matchKey].trim();
      return "";
    };
    const returnPath = probeHeader("Return-Path");
    if (returnPath) {
      const stripped = returnPath.replace(/^<|>$/g, "").trim();
      if (stripped) return stripped;
    }
    const envFrom = raw.nodemailer?.envelope?.from || raw.envelope?.from;
    if (typeof envFrom === "string" && envFrom.trim()) return envFrom.trim();
    const messageId = raw.message_id || raw.MessageId || raw["Message-ID"] || headers["message-id"] || headers["Message-ID"] || "";
    if (typeof messageId === "string") {
      const match = messageId.match(/@([^>\s]+)/);
      if (match?.[1]) return `<unknown@${match[1].trim()}>`;
    }
    return "";
  }
  function extractFromField(raw) {
    const parsedList = extractAddressList(raw, "from");
    const parsedDisplay = displayAddresses(parsedList).join(", ");
    if (parsedDisplay) {
      return parsedDisplay;
    }
    const fromVal = raw.From || raw.from || raw.nodemailer?.from;
    let primary = "";
    if (!fromVal) {
      const senderDisplay = toDisplayAddress(raw.sender);
      primary = senderDisplay || (typeof raw.sender === "string" ? raw.sender : "");
    } else if (Array.isArray(fromVal)) {
      primary = displayAddresses(fromVal).join(", ");
    } else if (typeof fromVal === "object" && Array.isArray(fromVal.value)) {
      primary = displayAddresses(fromVal.value).join(", ");
    }
    if (!primary) {
      primary = toDisplayAddress(fromVal) || "";
    }
    if (primary) return primary;
    const fallback = deriveFromFallback(raw);
    if (fallback) return fallback;
    if (isDebugFromField()) {
      console.warn("[sync-helpers] extractFromField: no from derivable", {
        id: raw.id || raw.Id || raw.uid || raw.Uid,
        keys: Object.keys(raw || {}),
        nodemailerKeys: raw.nodemailer ? Object.keys(raw.nodemailer) : null,
        headerKeys: raw.nodemailer?.headers ? Object.keys(raw.nodemailer.headers) : null
      });
    }
    return "";
  }
  function extractRecipientsField(raw, field = "to") {
    const parsedList = extractAddressList(raw, field);
    const parsedDisplay = displayAddresses(parsedList).join(", ");
    if (parsedDisplay) {
      return parsedDisplay;
    }
    const fieldVal = raw[field] || raw[field.charAt(0).toUpperCase() + field.slice(1)] || raw.nodemailer?.[field];
    if (!fieldVal) {
      return "";
    }
    if (typeof fieldVal === "string") {
      return toDisplayAddress(fieldVal);
    }
    if (Array.isArray(fieldVal)) {
      return displayAddresses(fieldVal).join(", ");
    }
    if (typeof fieldVal === "object") {
      if (fieldVal.text) {
        return toDisplayAddress(fieldVal.text);
      }
      if (Array.isArray(fieldVal.value)) {
        return displayAddresses(fieldVal.value).join(", ");
      }
    }
    return toDisplayAddress(fieldVal) || "";
  }
  function normalizeMessageForCache(raw = {}, folder, account = accountKey()) {
    const flags = Array.isArray(raw.flags) ? raw.flags : [];
    const nodemailerHeaders = raw.nodemailer?.headers || raw.nodemailer?.Headers || {};
    const headerMessageId = raw.header_message_id || raw.headerMessageId || nodemailerHeaders["message-id"] || nodemailerHeaders["Message-ID"] || null;
    const inReplyToHeader = raw.in_reply_to || raw.inReplyTo || raw["In-Reply-To"] || nodemailerHeaders["in-reply-to"] || nodemailerHeaders["In-Reply-To"] || null;
    const referencesHeader = raw.references || raw.References || nodemailerHeaders.references || nodemailerHeaders.References || null;
    const apiId = raw.id || raw.Id;
    const uid = raw.Uid || raw.uid || null;
    const dateVal = raw.internal_date || raw.date || raw.Date || raw.header_date || raw.created_at || raw.received_at;
    const parsedDate = dateVal ? new Date(dateVal) : null;
    const dateMs = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.getTime() : 0;
    const subject = decodeMimeHeader(
      raw.Subject || raw.subject || "(No subject)"
    );
    const rawLabels = raw.labels || raw.label_ids || raw.labelIds || raw.Labels || raw.tags || raw.Tags || raw.LabelIds || raw.keywords || raw.Keywords || raw.keyword || [];
    const normalizeLabel = (label) => {
      const normalized = String(label ?? "").trim();
      if (!normalized || /^\[\s*\]$/.test(normalized)) return "";
      return normalized;
    };
    const bufferLabels = decodeLabelBuffer(rawLabels);
    const extractedLabels = bufferLabels ? bufferLabels.map((l) => normalizeLabel(l)).filter(Boolean) : Array.isArray(rawLabels) ? rawLabels.map((l) => {
      if (typeof l === "string") return normalizeLabel(l);
      if (typeof l === "number") return normalizeLabel(String(l));
      if (l && typeof l === "object") {
        const lObj = l;
        return normalizeLabel(
          lObj.id || lObj.Id || lObj.keyword || lObj.value || lObj.name || lObj.label || ""
        );
      }
      return "";
    }).filter(Boolean) : typeof rawLabels === "string" ? rawLabels.split(",").map((l) => normalizeLabel(l)).filter(Boolean) : rawLabels && typeof rawLabels === "object" ? Object.entries(rawLabels).filter(
      ([, enabled]) => enabled !== false && enabled !== null && enabled !== void 0
    ).map(([label]) => normalizeLabel(label)).filter(Boolean) : [];
    const labels = extractedLabels.filter((l) => !isHiddenLabel(l));
    const isUnreadRaw = Array.isArray(flags) && flags.length ? !flags.includes("\\Seen") : raw.is_unread ?? raw.isUnread ?? raw.IsUnread ?? true;
    const isUnread = typeof isUnreadRaw === "boolean" ? isUnreadRaw : Boolean(isUnreadRaw);
    const toField = extractRecipientsField(raw, "to");
    const ccField = extractRecipientsField(raw, "cc");
    const bccField = extractRecipientsField(raw, "bcc");
    const replyToField = extractRecipientsField(raw, "replyTo");
    return {
      id: apiId || (uid != null ? String(uid) : null) || headerMessageId,
      account,
      folder: raw.folder_path || raw.folder || raw.path || folder || "",
      folder_id: raw.folder_id || raw.folderId || raw.FolderId || null,
      date: dateMs,
      dateMs,
      from: extractFromField(raw),
      to: toField || void 0,
      cc: ccField || void 0,
      bcc: bccField || void 0,
      reply_to: replyToField || null,
      subject,
      snippet: (() => {
        const plain = raw.Plain || raw.snippet || raw.preview || raw.text || raw.nodemailer?.text || "";
        if (plain) return stripHtmlToPlaintext(plain);
        const html = raw.textAsHtml || raw.nodemailer?.textAsHtml || raw.html || raw.nodemailer?.html || "";
        return stripHtmlToPlaintext(html);
      })(),
      flags,
      is_unread: isUnread,
      is_unread_index: isUnread ? 1 : 0,
      is_starred: Boolean(raw.is_flagged) || Boolean(raw.is_starred) || flags.includes("\\Flagged"),
      is_flagged: Boolean(raw.is_flagged) || Boolean(raw.is_starred) || flags.includes("\\Flagged"),
      has_attachment: (() => {
        const fromFlag = Boolean(raw.has_attachment || raw.hasAttachments);
        const fromArray = Array.isArray(raw.attachments) && raw.attachments.length > 0;
        return fromFlag || fromArray;
      })(),
      modseq: raw.modseq || raw.ModSeq || raw.modSeq || null,
      message_id: raw.MessageId || raw.message_id || raw["Message-ID"] || headerMessageId || apiId,
      root_id: raw.root_id || raw.rootId || null,
      thread_id: raw.thread_id || raw.threadId || raw.thread || raw.root_id || null,
      uid: uid || null,
      header_message_id: headerMessageId,
      in_reply_to: inReplyToHeader || null,
      references: referencesHeader || null,
      labels,
      bodyIndexed: false,
      updatedAt: Date.now()
    };
  }
  const target = globalThis;
  target.normalizeMessageRecord = (raw, folder, account) => normalizeMessageForCache(raw, folder, account);
  const swNormalizeLoaded = true;
  exports.swNormalizeLoaded = swNormalizeLoaded;
  Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
  return exports;
}({});
