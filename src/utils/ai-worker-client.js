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

import AIWorker from '../workers/ai.worker.ts?worker&inline';

export class AIWorkerClient {
  constructor() {
    this.worker = new AIWorker();
    this.counter = 0;
    // id → { kind: 'chat' | 'oneshot', ... }
    this.pending = new Map();

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

    // Single-response action (cancel, validate).
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
  chat({ providerConfig, apiKey, options }, callbacks = {}) {
    const id = ++this.counter;
    const finished = new Promise((resolve) => {
      this.pending.set(id, {
        kind: 'chat',
        resolve,
        onToken: callbacks.onToken,
        onToolCall: callbacks.onToolCall,
        onToolCallDelta: callbacks.onToolCallDelta,
        onDone: callbacks.onDone,
        onError: callbacks.onError,
      });
    });
    this.worker.postMessage({
      id,
      action: 'chat',
      payload: { providerConfig, apiKey, options },
    });
    return { requestId: id, finished, cancel: () => this.cancel(id) };
  }

  cancel(requestId) {
    return this.sendOneShot('cancel', { requestId });
  }

  validate({ providerConfig, apiKey }) {
    return this.sendOneShot('validate', { providerConfig, apiKey });
  }

  sendOneShot(action, payload) {
    const id = ++this.counter;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { kind: 'oneshot', resolve, reject });
    });
    this.worker.postMessage({ id, action, payload });
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
