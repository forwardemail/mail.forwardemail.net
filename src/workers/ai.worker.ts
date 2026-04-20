/**
 * Dedicated AI Worker
 *
 * Orchestrates provider adapters off the main thread. Holds decrypted API keys
 * in worker-scope memory only for the duration of an in-flight request, then
 * discards them — keys are passed in per request from the main thread and are
 * not persisted across requests.
 *
 * Phase 1 smoke-test scope: Anthropic provider only, no tool execution loop,
 * no MessageChannel to db.worker. Those arrive in Sub-milestones E and F.
 *
 * Message protocol:
 *   Main → Worker:
 *     { id, action: 'chat',     payload: { providerConfig, apiKey, options } }
 *     { id, action: 'cancel',   payload: { requestId } }
 *     { id, action: 'validate', payload: { providerConfig, apiKey } }
 *   Worker → Main:
 *     { id, action: 'event', event: StreamEvent }   // streamed, many per chat
 *     { id, ok: true, result }                       // single response (cancel, validate)
 *     { id, ok: false, error }                       // error (any action)
 *     { id, done: true }                             // stream terminator
 */

import { AnthropicWebProvider } from '../ai/providers/anthropic-web';
import type { ChatOptions, Provider, StreamEvent } from '../ai/providers/types';
import { AIError, userMessageFor } from '../ai/errors';

interface ProviderConfigLite {
  id: string;
  kind: 'anthropic' | 'openai_compat' | 'local_gguf' | 'hosted_fe';
  endpoint?: string;
  model?: string;
}

interface ChatPayload {
  providerConfig: ProviderConfigLite;
  apiKey: string;
  options: Omit<ChatOptions, 'abort_signal'>;
}

interface CancelPayload {
  requestId: number;
}

interface ValidatePayload {
  providerConfig: ProviderConfigLite;
  apiKey: string;
}

interface IncomingMessage {
  id: number;
  action: 'chat' | 'cancel' | 'validate';
  payload: ChatPayload | CancelPayload | ValidatePayload;
}

const inFlight = new Map<number, AbortController>();

const instantiateProvider = (config: ProviderConfigLite, apiKey: string): Provider => {
  switch (config.kind) {
    case 'anthropic':
      return new AnthropicWebProvider({
        id: config.id,
        apiKey,
        endpoint: config.endpoint,
        defaultModel: config.model,
      });
    case 'openai_compat':
    case 'local_gguf':
    case 'hosted_fe':
      throw new AIError('unknown', `Provider kind ${config.kind} not implemented in smoke test`);
  }
};

const postEvent = (id: number, event: StreamEvent): void => {
  self.postMessage({ id, action: 'event', event });
};

const postError = (id: number, err: unknown): void => {
  if (err instanceof AIError) {
    self.postMessage({
      id,
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        retryable: err.retryable,
        user_message: userMessageFor(err),
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  self.postMessage({
    id,
    ok: false,
    error: { code: 'unknown', message, retryable: false, user_message: message },
  });
};

const runChat = async (id: number, payload: ChatPayload): Promise<void> => {
  const controller = new AbortController();
  inFlight.set(id, controller);

  try {
    const provider = instantiateProvider(payload.providerConfig, payload.apiKey);
    const options: ChatOptions = { ...payload.options, abort_signal: controller.signal };

    for await (const event of provider.chat(options)) {
      postEvent(id, event);
      if (event.type === 'done' || event.type === 'error') break;
    }

    self.postMessage({ id, done: true });
  } catch (err) {
    postError(id, err);
  } finally {
    inFlight.delete(id);
  }
};

const runCancel = (id: number, payload: CancelPayload): void => {
  const controller = inFlight.get(payload.requestId);
  const found = Boolean(controller);
  if (controller) controller.abort();
  self.postMessage({ id, ok: true, result: { cancelled: found } });
};

const runValidate = async (id: number, payload: ValidatePayload): Promise<void> => {
  try {
    const provider = instantiateProvider(payload.providerConfig, payload.apiKey);
    const result = await provider.validateConnection();
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    postError(id, err);
  }
};

self.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const msg = event.data;
  if (!msg || typeof msg.id !== 'number') return;

  switch (msg.action) {
    case 'chat':
      void runChat(msg.id, msg.payload as ChatPayload);
      return;
    case 'cancel':
      runCancel(msg.id, msg.payload as CancelPayload);
      return;
    case 'validate':
      void runValidate(msg.id, msg.payload as ValidatePayload);
      return;
    default:
      self.postMessage({
        id: msg.id,
        ok: false,
        error: {
          code: 'unknown',
          message: `Unknown action: ${String(msg.action)}`,
          retryable: false,
          user_message: 'Unknown AI worker action',
        },
      });
  }
});
