export function arrayBufferToBase64(uint8Array) {
  const view = uint8Array instanceof Uint8Array ? uint8Array : new Uint8Array(uint8Array || []);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < view.length; i += chunkSize) {
    const chunk = view.subarray(i, Math.min(i + chunkSize, view.length));
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

export function bufferToDataUrl(attachment) {
  try {
    const { content, contentType, mimeType, type } = attachment || {};
    if (!content) return '';
    const mime = contentType || mimeType || type || 'application/octet-stream';
    let base64;
    if (typeof content === 'string') {
      const isB64 = /^[A-Za-z0-9/+]+={0,2}$/.test(content.replace(/\s+/g, ''));
      base64 = isB64 ? content.replace(/\s+/g, '') : btoa(unescape(encodeURIComponent(content)));
    } else if (content instanceof ArrayBuffer) {
      base64 = arrayBufferToBase64(new Uint8Array(content));
    } else if (ArrayBuffer.isView(content)) {
      base64 = arrayBufferToBase64(new Uint8Array(content.buffer || content));
    } else if (content?.data) {
      base64 = arrayBufferToBase64(new Uint8Array(content.data));
    } else if (Array.isArray(content)) {
      base64 = arrayBufferToBase64(new Uint8Array(content));
    } else {
      return '';
    }
    return `data:${mime};base64,${base64}`;
  } catch {
    return '';
  }
}

const normalizeCid = (value = '') => {
  let cid = String(value || '').trim();
  if (!cid) return '';
  cid = cid.replace(/^cid:/i, '');
  if (cid.startsWith('<') && cid.endsWith('>')) {
    cid = cid.slice(1, -1);
  }
  return cid.trim();
};

export function applyInlineAttachments(html, attachments) {
  if (!html || !attachments || attachments.length === 0) return html;
  let updated = html;

  const byCid = new Map();
  const byName = new Map();
  const addCid = (cid, href) => {
    if (!cid || !href || byCid.has(cid)) return;
    byCid.set(cid, href);
  };
  attachments.forEach((att) => {
    const href = att?.href;
    const rawCid = att?.contentId;
    const normalizedCid = normalizeCid(rawCid);
    addCid(rawCid, href);
    addCid(normalizedCid, href);
    if (normalizedCid && normalizedCid.includes('@')) {
      addCid(normalizedCid.split('@')[0], href);
    }
    if (att.name) byName.set(att.name, att.href);
    if (att.filename) byName.set(att.filename, att.href);
  });

  const resolveCid = (cid) => {
    if (!cid) return '';
    const normalized = normalizeCid(cid);
    return byCid.get(normalized) || byCid.get(cid) || '';
  };

  updated = updated.replace(
    /\b(src|background|href|poster|xlink:href)\s*=\s*(["']?)\s*cid:([^"'\s>]+)\s*\2/gi,
    (match, attr, _quote, cid) => {
      const url = resolveCid(cid);
      return url ? `${attr}="${url}"` : match;
    },
  );

  updated = updated.replace(/url\(\s*cid:([^\s)]+)\s*\)/gi, (match, cid) => {
    const url = resolveCid(cid);
    return url ? `url("${url}")` : match;
  });

  updated = updated.replace(/<img([^>]*?)>/gi, (match, attrs) => {
    const hasSrc = /src\s*=/.test(attrs);
    if (hasSrc) return match;
    const altMatch = attrs.match(/alt=["']([^"']+)["']/i);
    if (!altMatch) return match;
    const alt = altMatch[1];
    const url = byName.get(alt);
    if (!url) return match;
    return `<img${attrs} src="${url}">`;
  });

  return updated;
}

export function extractTextContent(html = '') {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const normalizeCharset = (value = '') => {
  const lower = String(value || '')
    .trim()
    .toLowerCase();
  if (!lower) return 'utf-8';
  if (lower === 'utf8') return 'utf-8';
  if (lower === 'us-ascii') return 'utf-8';
  if (lower === 'latin1') return 'iso-8859-1';
  return lower;
};

const decodeBytes = (bytes, charset) => {
  if (!bytes || !bytes.length) return '';
  const normalized = normalizeCharset(charset);
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (typeof TextDecoder === 'function') {
    try {
      return new TextDecoder(normalized).decode(view);
    } catch {
      // fallback below
    }
  }
  return String.fromCharCode(...view);
};

const decodeQEncoded = (input, charset) => {
  const cleaned = String(input || '').replace(/_/g, ' ');
  const bytes = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === '=' && i + 2 < cleaned.length) {
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
  const cleaned = String(input || '').replace(/\s+/g, '');
  try {
    const binary = atob(cleaned);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return decodeBytes(bytes, charset);
  } catch {
    return input;
  }
};

export function decodeMimeHeader(value = '') {
  if (!value || typeof value !== 'string') return value || '';
  const encodedWord = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;
  return value.replace(encodedWord, (_match, charset, encoding, text) => {
    if (encoding.toLowerCase() === 'q') {
      return decodeQEncoded(text, charset);
    }
    return decodeBEncoded(text, charset);
  });
}
