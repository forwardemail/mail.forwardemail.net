/**
 * AI Worker Client
 *
 * Main-thread shim over `src/workers/ai.worker.ts`. Streaming chat requests
 * use callbacks rather than a single-promise return; cancel and validate are
 * single-shot request/response.
 *
 * Keys are read from the keystore on the main thread (see
 * `src/ai/keystore-web.ts`) and passed in per request. The worker discards
 * them when the request terminates.
 */

import AIWorker from '../workers/ai.worker.ts?worker';
import { getDbWorker, initializeDatabase } from './db.js';

export class AIWorkerClient {
  constructor() {
    this.worker = new AIWorker();
    this.counter = 0;
    // id → { kind: 'chat' | 'oneshot', ... }
    this.pending = new Map();
    this.dbConnected = false;
    this.dbConnectionPromise = null;

    this.worker.onmessage = (event) => this.handleMessage(event.data || {});
    this.worker.onerror = (event) => {
      const message = event?.message || 'AI worker crashed';
      console.error('[AIWorkerClient] Worker error:', message);
      for (const entry of this.pending.values()) {
        if (entry.kind === 'chat') {
          entry.onError?.({ code: 'unknown', message, retryable: false });
          entry.onDone?.();
        } else {
          entry.reject(new Error(message));
        }
      }
      this.pending.clear();
    };

    // Kick off db.worker connection immediately; tools can't run without it.
    this.dbConnectionPromise = this.connectToDbWorker().catch((err) => {
      console.warn('[AIWorkerClient] db connection failed (tools disabled):', err);
    });
  }

  async connectToDbWorker() {
    let dbWorker = getDbWorker();
    if (!dbWorker) {
      await initializeDatabase();
      dbWorker = getDbWorker();
    }
    if (!dbWorker) {
      throw new Error('db.worker not available after initialization');
    }
    const channel = new MessageChannel();
    dbWorker.postMessage({ type: 'connectPort', workerId: 'ai' }, [channel.port1]);
    await this.sendOneShot('connectDbPort', {}, [channel.port2]);
    this.dbConnected = true;
  }

  async ensureDbConnected() {
    if (this.dbConnected) return;
    if (this.dbConnectionPromise) await this.dbConnectionPromise;
  }

  handleMessage(msg) {
    const { id } = msg;
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (!entry) return;

    if (entry.kind === 'chat') {
      if (msg.action === 'event') {
        const event = msg.event;
        if (!event) return;
        if (event.type === 'token') entry.onToken?.(event.text);
        else if (event.type === 'tool_call') entry.onToolCall?.(event);
        else if (event.type === 'tool_call_delta') entry.onToolCallDelta?.(event);
        else if (event.type === 'tool_start') entry.onToolStart?.(event);
        else if (event.type === 'tool_result') entry.onToolResult?.(event);
        else if (event.type === 'done') entry.onDone?.({ finish_reason: event.finish_reason });
        else if (event.type === 'error') entry.onError?.(event);
      } else if (msg.done) {
        this.pending.delete(id);
        entry.resolve?.();
      } else if (msg.ok === false) {
        entry.onError?.(msg.error || { code: 'unknown', message: 'Unknown error' });
        this.pending.delete(id);
        entry.resolve?.();
      }
      return;
    }

    // Single-response action (cancel, validate, connectDbPort).
    this.pending.delete(id);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(msg.error || { code: 'unknown', message: 'Unknown error' });
  }

  /**
   * Start a streaming chat request.
   *
   * @param {object} params
   * @param {object} params.providerConfig - { id, kind, endpoint?, model? }
   * @param {string} params.apiKey - decrypted key; discarded when request ends
   * @param {object} params.options - ChatOptions minus abort_signal
   * @param {object} [callbacks]
   * @param {(text: string) => void} [callbacks.onToken]
   * @param {(evt: object) => void} [callbacks.onToolCall]
   * @param {(evt: object) => void} [callbacks.onToolCallDelta]
   * @param {(evt: {finish_reason: string}) => void} [callbacks.onDone]
   * @param {(err: object) => void} [callbacks.onError]
   * @returns {{ requestId: number, finished: Promise<void>, cancel: () => Promise<void> }}
   */
  chat({ providerConfig, apiKey, options, context }, callbacks = {}) {
    const id = ++this.counter;
    const finished = new Promise((resolve) => {
      this.pending.set(id, {
        kind: 'chat',
        resolve,
        onToken: callbacks.onToken,
        onToolCall: callbacks.onToolCall,
        onToolCallDelta: callbacks.onToolCallDelta,
        onToolStart: callbacks.onToolStart,
        onToolResult: callbacks.onToolResult,
        onDone: callbacks.onDone,
        onError: callbacks.onError,
      });
    });
    // Ensure db is connected before sending the chat so tool calls land after
    // the handshake. ensureDbConnected resolves instantly once connected.
    this.ensureDbConnected()
      .catch(() => {
        /* tools will degrade; chat still works for non-tool turns */
      })
      .finally(() => {
        this.worker.postMessage({
          id,
          action: 'chat',
          payload: { providerConfig, apiKey, options, context },
        });
      });
    return { requestId: id, finished, cancel: () => this.cancel(id) };
  }

  cancel(requestId) {
    return this.sendOneShot('cancel', { requestId });
  }

  validate({ providerConfig, apiKey }) {
    return this.sendOneShot('validate', { providerConfig, apiKey });
  }

  sendOneShot(action, payload, transfer = []) {
    const id = ++this.counter;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { kind: 'oneshot', resolve, reject });
    });
    this.worker.postMessage({ id, action, payload }, transfer);
    return promise;
  }

  terminate() {
    try {
      this.worker?.terminate?.();
    } catch {
      /* noop */
    }
    this.pending.clear();
  }
}

let singleton = null;

export const getAIWorkerClient = () => {
  if (!singleton) singleton = new AIWorkerClient();
  return singleton;
};

export const terminateAIWorkerClient = () => {
  if (singleton) {
    singleton.terminate();
    singleton = null;
  }
};
