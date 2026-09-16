/**
 * Turns a hovered email link into something safe to show in the reader's
 * status bar.
 *
 * The href comes from untrusted email HTML. Nothing here is ever rendered as
 * markup; callers set the returned strings with textContent. The job is to
 * make the real destination legible: the registrable host stands out, any
 * credentials are stripped, internationalized hosts stay in their punycode
 * form because the decoded form is the attack, and when the link's own text
 * names a different host than the href, that is called out.
 */

export type LinkPreviewKind = 'http' | 'mailto' | 'tel' | 'unsupported';

export interface LinkPreview {
  kind: LinkPreviewKind;
  /** Full text to show, credentials stripped, possibly middle-truncated. */
  display: string;
  /** Text before the host (scheme and separators). Empty for non-http. */
  prefix: string;
  /** Hostname exactly as the URL parser reports it (punycode for IDN). */
  host: string;
  /** Text after the host: port, path, query, fragment. */
  suffix: string;
  /** Host uses punycode (xn--), so it may read differently when decoded. */
  isIdn: boolean;
  /** The visible link text names a host that differs from the href's host. */
  mismatch: { textHost: string } | null;
}

export const LINK_PREVIEW_MAX_LENGTH = 140;

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** Extract the host named by visible link text, if the text looks like a URL or domain. */
export function hostFromLinkText(text: string | null | undefined): string | null {
  const trimmed = String(text ?? '')
    .trim()
    .replace(/^[<([\s]+|[>)\]\s.,;:!?]+$/g, '');
  if (!trimmed || /\s/.test(trimmed)) return null;
  // An email address as link text names a mailbox, not a destination host.
  if (trimmed.includes('@')) return null;
  // Text that already carries a scheme (mailto:, tel:, https:) is parsed as
  // written; anything else is treated as a bare domain or path.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  const candidate = hasScheme ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  // Require a dotted name or an IPv4 literal so plain words like "here" or
  // "login" are not treated as hosts.
  const isDottedName = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host);
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return isDottedName || isIpv4 ? host : null;
}

const stripWww = (host: string): string => host.replace(/^www\./, '');

/** Shorten a long URL in the middle so the host and the tail of the path stay visible. */
export function truncateMiddle(value: string, max = LINK_PREVIEW_MAX_LENGTH): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function describeLinkTarget(href: string, linkText?: string | null): LinkPreview {
  const empty: LinkPreview = {
    kind: 'unsupported',
    display: '',
    prefix: '',
    host: '',
    suffix: '',
    isIdn: false,
    mismatch: null,
  };

  let url: URL;
  try {
    url = new URL(String(href ?? ''));
  } catch {
    return empty;
  }
  if (!SUPPORTED_SCHEMES.has(url.protocol)) return empty;

  if (url.protocol === 'mailto:' || url.protocol === 'tel:') {
    const display = truncateMiddle(url.href);
    return {
      ...empty,
      kind: url.protocol === 'mailto:' ? 'mailto' : 'tel',
      display,
    };
  }

  // Drop user:pass@ so a crafted link cannot dress up its host with a fake one.
  url.username = '';
  url.password = '';

  const host = url.hostname;
  const prefix = `${url.protocol}//`;
  const port = url.port ? `:${url.port}` : '';
  const suffixFull = `${port}${url.pathname}${url.search}${url.hash}`;
  const full = `${prefix}${host}${suffixFull}`;
  const display = truncateMiddle(full);

  // Keep the split consistent with the possibly-truncated display: the
  // prefix and host always fit inside the head portion for realistic hosts,
  // so only the suffix is affected by truncation.
  const suffix = display.slice(prefix.length + host.length);

  const isIdn = host.split('.').some((label) => label.startsWith('xn--'));

  const textHost = hostFromLinkText(linkText);
  const mismatch =
    textHost && stripWww(textHost) !== stripWww(host.toLowerCase()) ? { textHost } : null;

  return { kind: 'http', display, prefix, host, suffix, isIdn, mismatch };
}
