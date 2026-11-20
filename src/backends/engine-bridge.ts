/**
 * Calling the Rust mail engine (src-tauri/src/mail), and what it answers
 * when something goes wrong. The modules that use the engine (IMAP, SMTP,
 * OAuth) all go through here.
 */

import { isTauriDesktop } from '../utils/platform.js';

/**
 * kind: auth, tls, timeout, network, closed, local, rate, server, input,
 * missing, handle, forbidden, disabled, and from a send: rejected, recipient, busy,
 * unsupported, unconfirmed
 */
export class MailEngineError extends Error {
  readonly kind: string;
  /** Set for the kinds the rest of the app already tells apart by HTTP status. */
  readonly status?: number;
  /** Which recipient the server refused, counted from 0. */
  readonly recipient?: number;
  /** The message was handed over and the answer never came. Not safe to resend. */
  readonly isClientTimeout?: boolean;
  constructor(kind: string, message: string, recipient?: number) {
    super(message || 'The mail server request failed');
    this.name = 'MailEngineError';
    this.kind = kind;
    if (typeof recipient === 'number') this.recipient = recipient;
    if (kind === 'auth') this.status = 401;
    if (kind === 'missing') this.status = 404;
    // The server will say the same thing again, so nothing retries these.
    if (['rejected', 'recipient', 'input', 'unsupported'].includes(kind)) this.status = 422;
    if (kind === 'rate' || kind === 'busy') this.status = 429;
    if (kind === 'unconfirmed') this.isClientTimeout = true;
  }
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let invokeOverride: Invoke | null = null;

/** Test seam: stand in for the Rust engine. */
export function setMailEngineForTests(invoke: Invoke | null): void {
  invokeOverride = invoke;
  resetHooks.forEach((reset) => reset());
}

const resetHooks: Array<() => void> = [];
/** Lets the other engine modules drop their handles when a test swaps the engine. */
export function onMailEngineReset(reset: () => void): void {
  resetHooks.push(reset);
}

export const mailEngineAvailable = (): boolean =>
  Boolean(invokeOverride) || Boolean(isTauriDesktop);

let enabled: Promise<boolean> | null = null;
onMailEngineReset(() => {
  enabled = null;
});

/**
 * Whether this build of the app has the engine switched on. A release build
 * has it off until custom servers are released, and then every engine command
 * is refused, so nothing that leads to one is offered.
 */
export function mailEngineEnabled(): Promise<boolean> {
  if (!mailEngineAvailable()) return Promise.resolve(false);
  enabled ??= invokeEngine<unknown>('mail_enabled', {}).then(
    (answer) => answer === true,
    () => false,
  );
  return enabled;
}

export async function invokeEngine<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  try {
    if (invokeOverride) return (await invokeOverride(cmd, args)) as T;
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<T>(cmd, args);
  } catch (err) {
    if (err instanceof MailEngineError) throw err;
    const e = err as { kind?: unknown; message?: unknown; recipient?: unknown } | string | null;
    if (e && typeof e === 'object' && typeof e.kind === 'string') {
      throw new MailEngineError(
        e.kind,
        String(e.message ?? ''),
        typeof e.recipient === 'number' ? e.recipient : undefined,
      );
    }
    throw new MailEngineError('engine', typeof e === 'string' ? e : String(e?.message ?? e));
  }
}
