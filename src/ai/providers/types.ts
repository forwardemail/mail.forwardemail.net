/**
 * Shared Provider Interface
 *
 * Every AI provider — Anthropic, OpenAI-compatible endpoints (Ollama, LM Studio,
 * OpenRouter, Groq, vLLM, llama.cpp server), future local GGUF, future Forward
 * Email hosted — implements this interface. Web and desktop (Rust) use the same
 * shape so features can be written once against the abstraction.
 */

export type ProviderKind = 'anthropic' | 'openai_compat' | 'local_gguf' | 'hosted_fe';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  mime_type: string;
  // base64-encoded image bytes
  data: string;
}

export type ContentBlock = TextBlock | ImageBlock;

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-serialized arguments. Providers stream deltas; consumers are responsible for assembly. */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentBlock[];
  /** Set on tool-result messages; matches the originating `ToolCall.id`. */
  tool_call_id?: string;
  /** Set on assistant messages that requested tool execution. */
  tool_calls?: ToolCall[];
}

/**
 * JSON Schema subset we commit to. We do not accept full JSON Schema — any
 * feature not in this shape will be rejected by the tool registry validator.
 */
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: Array<string | number>;
  /** Always false for tool parameters — we reject unknown fields. */
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Defaults depend on provider. Keep at 0 for DSL translation, higher for drafting. */
  temperature?: number;
  max_tokens?: number;
  /**
   * Force JSON output when the provider supports it. Not every provider honors
   * this — adapters set it best-effort and the caller must still validate.
   */
  response_format?: { type: 'json_object' | 'text' };
  /** Cancellation. Adapters must abort network I/O when this fires. */
  abort_signal: AbortSignal;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'error';

export type StreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | {
      type: 'tool_call_delta';
      id: string;
      /** Partial JSON arguments, concatenated by the consumer in emission order. */
      arguments_delta: string;
    }
  | { type: 'done'; finish_reason: FinishReason }
  | { type: 'error'; code: string; message: string; retryable: boolean };

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  vision: boolean;
  max_context: number;
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
}

export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  chat(options: ChatOptions): AsyncIterable<StreamEvent>;
  validateConnection(): Promise<ValidateResult>;
}
