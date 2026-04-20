/**
 * Provider Host Allowlist (web only)
 *
 * Decision #2 in the implementation plan: web diverges from desktop. The web
 * app runs under a static CSP meta tag that cannot be widened at runtime, so
 * we commit to a fixed allowlist of provider hosts. If a user wants a
 * provider not on this list, they should use the desktop app (which proxies
 * all HTTPS through Rust `reqwest` and keeps the webview CSP locked).
 *
 * Local-only mode additionally allows loopback. Any other host must be
 * rejected by the egress guard regardless of CSP.
 */

import type { ProviderKind } from './types';

export interface AllowlistEntry {
  /** Provider kind for matching against configured providers. */
  kind: ProviderKind;
  /** Display name shown in Settings → AI. */
  label: string;
  /** Hostnames this entry authorizes. All must resolve to HTTPS. */
  hosts: string[];
  /** Documentation URL, surfaced in the provider setup form. */
  docs?: string;
}

/**
 * Hardcoded list of provider hosts the web CSP whitelists when AI is
 * configured. Hosts here are added to `connect-src` via the meta tag
 * build step. Update this list with care — every addition widens the CSP
 * surface for every web user, AI or not.
 */
export const WEB_PROVIDER_ALLOWLIST: readonly AllowlistEntry[] = Object.freeze([
  Object.freeze({
    kind: 'anthropic' as const,
    label: 'Anthropic Claude',
    hosts: ['api.anthropic.com'],
    docs: 'https://docs.anthropic.com/',
  }),
  Object.freeze({
    kind: 'openai_compat' as const,
    label: 'OpenAI',
    hosts: ['api.openai.com'],
    docs: 'https://platform.openai.com/docs/',
  }),
  Object.freeze({
    kind: 'openai_compat' as const,
    label: 'OpenRouter',
    hosts: ['openrouter.ai'],
    docs: 'https://openrouter.ai/docs',
  }),
  Object.freeze({
    kind: 'openai_compat' as const,
    label: 'Groq',
    hosts: ['api.groq.com'],
    docs: 'https://console.groq.com/docs/',
  }),
]);

/** Loopback hosts allowed only when `local-only` mode is on. */
export const LOOPBACK_HOSTS: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '::1']);

const allowedHostSet: ReadonlySet<string> = new Set(
  WEB_PROVIDER_ALLOWLIST.flatMap((e) => e.hosts).map((h) => h.toLowerCase()),
);

const loopbackHostSet: ReadonlySet<string> = new Set(LOOPBACK_HOSTS.map((h) => h.toLowerCase()));

export interface HostCheckOptions {
  /** When true, loopback hosts are allowed and every other non-allowlisted host is rejected. */
  localOnly?: boolean;
}

export interface HostCheckResult {
  ok: boolean;
  reason?: 'not_allowlisted' | 'egress_blocked_by_local_only' | 'invalid_url' | 'non_https';
}

const isLoopbackHost = (host: string): boolean => {
  const lower = host.toLowerCase();
  if (loopbackHostSet.has(lower)) return true;
  // IPv4 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(lower)) return true;
  return false;
};

/**
 * Validate a URL against the allowlist. Used by `ai.worker` before issuing any
 * outbound fetch. This is the CSP's backstop — CSP blocks the browser-level
 * request, this check prevents us from even forming it.
 */
export const checkHostAllowed = (
  rawUrl: string,
  options: HostCheckOptions = {},
): HostCheckResult => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  const host = url.hostname.toLowerCase();
  const loopback = isLoopbackHost(host);

  if (options.localOnly) {
    return loopback ? { ok: true } : { ok: false, reason: 'egress_blocked_by_local_only' };
  }

  if (url.protocol !== 'https:' && !loopback) {
    return { ok: false, reason: 'non_https' };
  }

  if (loopback || allowedHostSet.has(host)) return { ok: true };
  return { ok: false, reason: 'not_allowlisted' };
};

/** CSP `connect-src` fragment for provider hosts. Used by the build step. */
export const buildConnectSrcFragment = (): string =>
  WEB_PROVIDER_ALLOWLIST.flatMap((e) => e.hosts)
    .map((h) => `https://${h}`)
    .join(' ');
