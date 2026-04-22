/**
 * Dedicated AI Worker
 *
 * Orchestrates provider adapters off the main thread. Holds decrypted API keys
 * in worker-scope memory only for the duration of an in-flight request, then
 * discards them — keys are passed in per request from the main thread and are
 * not persisted across requests.
 *
 * Phase 1 scope:
 * - Single provider kind (Anthropic) for now; openai_compat/local_gguf stubs
 *   throw "not implemented" so the switch exhaustiveness is preserved.
 * - Multi-turn tool-execution loop: when the model emits `tool_call` events
 *   and finishes with `finish_reason === 'tool_calls'`, the worker executes
 *   each tool (scope-enforced), appends `tool_result` messages, and re-invokes
 *   `provider.chat()`. Loop caps at MAX_TURNS to prevent runaway agent
 *   behavior.
 * - MessageChannel to `db.worker` for tool execution (tools read Dexie
 *   through the shared `dbClient`).
 *
 * Message protocol:
 *   Main → Worker:
 *     { id, action: 'chat',     payload: { providerConfig, apiKey, options, context } }
 *     { id, action: 'cancel',   payload: { requestId } }
 *     { id, action: 'validate', payload: { providerConfig, apiKey } }
 *     { id, action: 'connectDbPort' } + transferred MessagePort
 *   Worker → Main:
 *     { id, action: 'event', event: StreamEvent }   // streamed, many per chat
 *     { id, ok: true, result }                       // single response
 *     { id, ok: false, error }                       // error
 *     { id, done: true }                             // stream terminator
 */

import { AnthropicWebProvider } from '../ai/providers/anthropic-web';
import type {
  ChatMessage,
  ChatOptions,
  Provider,
  StreamEvent,
  ToolCall,
} from '../ai/providers/types';
import { AIError, retryDelayMs, userMessageFor } from '../ai/errors';

const MAX_RETRIES = 3;
import type { ContextScope } from '../ai/context/scope';
import { getAllowedTools, executeTool, hasTools } from '../ai/tools/registry';
import { connectToDbWorker } from '../utils/db-worker-client.js';

const MAX_TURNS = 10;

interface ProviderConfigLite {
  id: string;
  kind: 'anthropic' | 'openai_compat' | 'local_gguf' | 'hosted_fe';
  endpoint?: string;
  model?: string;
}

interface ChatPayload {
  providerConfig: ProviderConfigLite;
  apiKey: string;
  options: Omit<ChatOptions, 'abort_signal' | 'tools'>;
  context: ContextScope;
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
  action: 'chat' | 'cancel' | 'validate' | 'connectDbPort';
  payload?: ChatPayload | CancelPayload | ValidatePayload;
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
      throw new AIError('unknown', `Provider kind ${config.kind} not implemented in Phase 1`);
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

/**
 * Collect the assistant turn from the stream. Emits every StreamEvent up to
 * the caller via `postEvent`, and returns the assembled assistant text and
 * any tool_calls the model requested.
 */
async function consumeTurn(
  id: number,
  provider: Provider,
  options: ChatOptions,
): Promise<{
  text: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}> {
  let text = '';
  const toolCalls: ToolCall[] = [];
  let finishReason: 'stop' | 'tool_calls' | 'length' | 'error' = 'stop';

  for await (const event of provider.chat(options)) {
    postEvent(id, event);

    if (event.type === 'token') {
      text += event.text;
    } else if (event.type === 'tool_call') {
      toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments });
    } else if (event.type === 'done') {
      finishReason = event.finish_reason;
      break;
    } else if (event.type === 'error') {
      finishReason = 'error';
      break;
    }
  }

  return { text, toolCalls, finishReason };
}

/**
 * Retry wrapper around consumeTurn. Retries only when the provider throws
 * an AIError with `retryable: true` (rate_limited, network_error,
 * model_unavailable). Uses the `retry_after_ms` hint from the provider
 * when present (Anthropic's `retry-after` header → AIError details), else
 * exponential backoff. Does NOT retry when the stream returned a `done`
 * or `error` event normally — those are model-level outcomes the caller
 * handles.
 */
async function consumeTurnWithRetry(
  id: number,
  provider: Provider,
  options: ChatOptions,
): Promise<{
  text: string;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}> {
  let attempt = 0;
  while (true) {
    try {
      return await consumeTurn(id, provider, options);
    } catch (err) {
      if (options.abort_signal.aborted) throw err;
      if (!(err instanceof AIError) || !err.retryable || attempt >= MAX_RETRIES) throw err;
      const delay = retryDelayMs(err, attempt) ?? 500;
      postEvent(id, {
        type: 'error',
        code: err.code,
        message: `${err.message} — retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${MAX_RETRIES})`,
        retryable: true,
      });
      await waitWithAbort(delay, options.abort_signal);
      attempt += 1;
    }
  }
}

const waitWithAbort = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new AIError('cancelled', 'Request cancelled'));
      },
      { once: true },
    );
  });

const runChat = async (id: number, payload: ChatPayload): Promise<void> => {
  const controller = new AbortController();
  inFlight.set(id, controller);

  try {
    const provider = instantiateProvider(payload.providerConfig, payload.apiKey);
    const scope = payload.context;
    const tools = getAllowedTools(scope);
    const messages: ChatMessage[] = [...payload.options.messages];

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      if (controller.signal.aborted) break;

      const turnResult = await consumeTurnWithRetry(id, provider, {
        ...payload.options,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        abort_signal: controller.signal,
      });

      // Append the assistant's message to the running history.
      messages.push({
        role: 'assistant',
        content: turnResult.text,
        tool_calls: turnResult.toolCalls.length > 0 ? turnResult.toolCalls : undefined,
      });

      // End of conversation unless the model requested tool execution.
      if (turnResult.finishReason !== 'tool_calls' || turnResult.toolCalls.length === 0) {
        break;
      }

      // Execute tool calls in parallel (same turn is bounded already by MAX_TURNS).
      await Promise.all(
        turnResult.toolCalls.map(async (call) => {
          if (controller.signal.aborted) return;
          let args: unknown = {};
          try {
            args = call.arguments ? JSON.parse(call.arguments) : {};
          } catch {
            args = { _raw: call.arguments };
          }
          postEvent(id, { type: 'tool_start', id: call.id, name: call.name, args });

          const outcome = await executeTool(call.name, call.arguments, {
            scope,
            abort_signal: controller.signal,
          });

          postEvent(id, {
            type: 'tool_result',
            id: call.id,
            name: call.name,
            ok: outcome.ok,
            summary: outcome.ok ? outcome.result.summary : outcome.summary,
          });

          const content = outcome.ok
            ? JSON.stringify(outcome.result.data)
            : JSON.stringify({ error: outcome.summary });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content,
          });
        }),
      );
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

  // MessageChannel handshake to db.worker — tools use dbClient through this.
  if (msg.action === 'connectDbPort') {
    const ports = (event as MessageEvent & { ports?: MessagePort[] }).ports;
    if (ports && ports[0]) {
      connectToDbWorker(ports[0]);
      self.postMessage({ id: msg.id, ok: true, result: { connected: true } });
    } else {
      self.postMessage({
        id: msg.id,
        ok: false,
        error: {
          code: 'unknown',
          message: 'no port transferred',
          retryable: false,
          user_message: 'init failed',
        },
      });
    }
    return;
  }

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

// Unused import safeguard — keep `hasTools` reachable so tree-shaking doesn't
// drop it; it's re-exported for tests/UI that want to ask the worker layer
// whether tools are offered under a given scope without instantiating a chat.
export const __hasToolsForScope = hasTools;
