/**
 * Anthropic Provider — web adapter
 *
 * POSTs to `https://api.anthropic.com/v1/messages` with SSE streaming.
 * Translates the shared `ChatOptions` → Anthropic request format and parses
 * Anthropic SSE events → shared `StreamEvent`s.
 *
 * The CSP `connect-src` must include `https://api.anthropic.com` (see
 * `src/ai/providers/allowlist.ts`). The `anthropic-dangerous-direct-browser-access`
 * header is required when calling directly from a browser origin — the Tauri
 * webview counts as a browser origin.
 *
 * References:
 * - https://docs.anthropic.com/en/api/messages
 * - https://docs.anthropic.com/en/api/messages-streaming
 */

import type {
  ChatMessage,
  ChatOptions,
  ContentBlock,
  Provider,
  ProviderCapabilities,
  StreamEvent,
  ToolDef,
} from './types';
import { AIError, type AIErrorCode } from '../errors';

const DEFAULT_ENDPOINT = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

export interface AnthropicWebProviderOptions {
  id: string;
  apiKey: string;
  endpoint?: string;
  defaultModel?: string;
  /** Max context window for capability advertising. Defaults to Sonnet 4.6's 200k. */
  maxContext?: number;
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  tools?: AnthropicTool[];
  stream: true;
  temperature?: number;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: unknown;
}

export class AnthropicWebProvider implements Provider {
  readonly id: string;
  readonly kind = 'anthropic' as const;
  readonly capabilities: ProviderCapabilities;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly defaultModel: string;

  constructor(options: AnthropicWebProviderOptions) {
    this.id = options.id;
    this.apiKey = options.apiKey;
    this.endpoint = (options.endpoint ?? DEFAULT_ENDPOINT).replace(/\/$/, '');
    this.defaultModel = options.defaultModel ?? 'claude-sonnet-4-6';
    this.capabilities = {
      tools: true,
      streaming: true,
      vision: true,
      max_context: options.maxContext ?? 200_000,
    };
  }

  async *chat(options: ChatOptions): AsyncIterable<StreamEvent> {
    const body = this.buildRequestBody(options);
    const url = `${this.endpoint}/v1/messages`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
          accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: options.abort_signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new AIError('cancelled', 'Request cancelled', { provider_id: this.id });
      }
      throw new AIError('network_error', fetchErrorMessage(err), { provider_id: this.id });
    }

    if (!response.ok) {
      const { code, message, retryAfterMs } = await errorFromResponse(response);
      throw new AIError(code, message, {
        provider_id: this.id,
        raw_code: response.status,
        retry_after_ms: retryAfterMs,
      });
    }

    if (!response.body) {
      throw new AIError('network_error', 'Response body missing', { provider_id: this.id });
    }

    yield* parseSseStream(response.body, options.abort_signal, this.id);
  }

  async validateConnection(): Promise<{ ok: boolean; error?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const events: StreamEvent[] = [];
      for await (const event of this.chat({
        model: this.defaultModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        abort_signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === 'done' || event.type === 'error') break;
      }
      const ok = events.some((e) => e.type === 'token' || e.type === 'done');
      return ok ? { ok: true } : { ok: false, error: 'no tokens received' };
    } catch (err) {
      const message = err instanceof AIError ? err.message : String(err);
      return { ok: false, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildRequestBody(options: ChatOptions): AnthropicRequestBody {
    const { system, messages } = splitSystemMessage(options.messages);

    const body: AnthropicRequestBody = {
      model: options.model || this.defaultModel,
      max_tokens: options.max_tokens ?? DEFAULT_MAX_TOKENS,
      messages: messages.map(toAnthropicMessage),
      stream: true,
    };

    if (system) body.system = system;
    if (typeof options.temperature === 'number') body.temperature = options.temperature;
    if (options.tools && options.tools.length > 0) body.tools = options.tools.map(toAnthropicTool);

    return body;
  }
}

// ---------------------------------------------------------------------------
// Message translation
// ---------------------------------------------------------------------------

const splitSystemMessage = (
  messages: ChatMessage[],
): { system: string | undefined; messages: ChatMessage[] } => {
  const systems: string[] = [];
  const rest: ChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      systems.push(typeof m.content === 'string' ? m.content : contentBlocksToText(m.content));
    } else {
      rest.push(m);
    }
  }
  return { system: systems.length ? systems.join('\n\n') : undefined, messages: rest };
};

const contentBlocksToText = (blocks: ContentBlock[]): string =>
  blocks
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('');

const toAnthropicMessage = (m: ChatMessage): AnthropicMessage => {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: typeof m.content === 'string' ? m.content : contentBlocksToText(m.content),
        },
      ],
    };
  }

  if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
    const blocks: AnthropicContentBlock[] = [];
    if (typeof m.content === 'string' && m.content) {
      blocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') blocks.push({ type: 'text', text: b.text });
      }
    }
    for (const call of m.tool_calls) {
      let input: unknown = {};
      try {
        input = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        input = {};
      }
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
    }
    return { role: 'assistant', content: blocks };
  }

  const role = m.role === 'assistant' ? 'assistant' : 'user';
  if (typeof m.content === 'string') {
    return { role, content: m.content };
  }

  const blocks: AnthropicContentBlock[] = m.content.map((b) =>
    b.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: b.mime_type, data: b.data } }
      : { type: 'text', text: b.text },
  );
  return { role, content: blocks };
};

const toAnthropicTool = (t: ToolDef): AnthropicTool => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

interface ToolCallBuffer {
  id: string;
  name: string;
  input: string;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  abortSignal: AbortSignal,
  providerId: string,
): AsyncGenerator<StreamEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolBuffers = new Map<number, ToolCallBuffer>();
  let finishReason: StreamEvent & { type: 'done' } = { type: 'done', finish_reason: 'stop' };

  try {
    while (true) {
      if (abortSignal.aborted) {
        throw new AIError('cancelled', 'Request cancelled', { provider_id: providerId });
      }
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseEventBlock(rawEvent);
        if (!event) continue;
        const translated = translateEvent(event, toolBuffers, (reason) => {
          finishReason = { type: 'done', finish_reason: reason };
        });
        for (const ev of translated) yield ev;
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }

  yield finishReason;
}

interface RawSseEvent {
  event: string | null;
  data: unknown;
}

const parseEventBlock = (raw: string): RawSseEvent | null => {
  let eventName: string | null = null;
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join('\n');
  if (!joined || joined === '[DONE]') return null;
  try {
    return { event: eventName, data: JSON.parse(joined) };
  } catch {
    return null;
  }
};

const translateEvent = (
  raw: RawSseEvent,
  toolBuffers: Map<number, ToolCallBuffer>,
  setFinishReason: (reason: 'stop' | 'tool_calls' | 'length' | 'error') => void,
): StreamEvent[] => {
  const data = raw.data as {
    type?: string;
    index?: number;
    content_block?: { type?: string; id?: string; name?: string };
    delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
    error?: { type?: string; message?: string };
  };

  switch (data.type) {
    case 'content_block_start': {
      if (data.content_block?.type === 'tool_use' && typeof data.index === 'number') {
        toolBuffers.set(data.index, {
          id: data.content_block.id ?? `call_${data.index}`,
          name: data.content_block.name ?? '',
          input: '',
        });
      }
      return [];
    }
    case 'content_block_delta': {
      const delta = data.delta;
      if (!delta) return [];
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        return [{ type: 'token', text: delta.text }];
      }
      if (
        delta.type === 'input_json_delta' &&
        typeof delta.partial_json === 'string' &&
        typeof data.index === 'number'
      ) {
        const buf = toolBuffers.get(data.index);
        if (!buf) return [];
        buf.input += delta.partial_json;
        return [{ type: 'tool_call_delta', id: buf.id, arguments_delta: delta.partial_json }];
      }
      return [];
    }
    case 'content_block_stop': {
      if (typeof data.index === 'number') {
        const buf = toolBuffers.get(data.index);
        if (buf) {
          toolBuffers.delete(data.index);
          return [{ type: 'tool_call', id: buf.id, name: buf.name, arguments: buf.input }];
        }
      }
      return [];
    }
    case 'message_delta': {
      const stopReason = data.delta?.stop_reason;
      if (stopReason === 'tool_use') setFinishReason('tool_calls');
      else if (stopReason === 'max_tokens') setFinishReason('length');
      else if (stopReason === 'end_turn' || stopReason === 'stop_sequence') setFinishReason('stop');
      return [];
    }
    case 'error': {
      setFinishReason('error');
      return [
        {
          type: 'error',
          code: data.error?.type ?? 'unknown',
          message: data.error?.message ?? 'Stream error',
          retryable: data.error?.type === 'overloaded_error',
        },
      ];
    }
    case 'message_start':
    case 'message_stop':
    case 'ping':
    default:
      return [];
  }
};

// ---------------------------------------------------------------------------
// Error normalization
// ---------------------------------------------------------------------------

const errorFromResponse = async (
  response: Response,
): Promise<{ code: AIErrorCode; message: string; retryAfterMs?: number }> => {
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch {
    /* ignore */
  }
  let parsed: { error?: { type?: string; message?: string } } = {};
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    /* ignore */
  }
  const message = parsed.error?.message ?? response.statusText ?? 'Request failed';
  const anthropicType = parsed.error?.type ?? '';

  let code: AIErrorCode = 'unknown';
  if (response.status === 401 || response.status === 403) code = 'invalid_credentials';
  else if (response.status === 429) code = 'rate_limited';
  else if (response.status === 400 && /context|too long|token/i.test(message)) {
    code = 'context_overflow';
  } else if (response.status >= 500) code = 'model_unavailable';
  else if (anthropicType === 'overloaded_error') code = 'model_unavailable';

  const retryHeader = response.headers.get('retry-after');
  const retryAfterMs = retryHeader ? parseRetryAfter(retryHeader) : undefined;

  return { code, message, retryAfterMs };
};

const parseRetryAfter = (header: string): number | undefined => {
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs) * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
};

const isAbortError = (err: unknown): boolean =>
  err instanceof DOMException && err.name === 'AbortError';

const fetchErrorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : 'Network error';
