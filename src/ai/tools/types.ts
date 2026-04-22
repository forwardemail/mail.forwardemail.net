/**
 * Tool implementation contract.
 *
 * A tool is a (definition, implementation) pair. The definition is what the
 * model sees (name, description, JSON Schema for args). The implementation
 * runs in `ai.worker` when the model emits a `tool_call` event.
 *
 * Every tool receives the active `ContextScope` and an `AbortSignal`. Tools
 * MUST honor the scope — a tool that returns results outside the declared
 * scope is a bug on the scope rail, which exists specifically to catch it.
 */

import type { ToolDef } from '../providers/types';
import type { ContextScope } from '../context/scope';

export interface ToolExecutionContext {
  scope: ContextScope;
  abort_signal: AbortSignal;
}

export interface ToolResult {
  /** JSON-serializable data fed back to the model as the `tool_result`. */
  data: unknown;
  /** Short one-line summary shown in the panel UI. */
  summary: string;
}

export interface ToolImpl {
  /** JSON Schema the model sees. */
  def: ToolDef;
  /**
   * `true` when this tool is available under the given scope. Used by the
   * registry to filter the tools offered per request.
   */
  availableIn: (scope: ContextScope) => boolean;
  /** Execute with args the model supplied. Must enforce scope. */
  run: (args: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolResult>;
}

export class ToolError extends Error {
  readonly code: 'bad_args' | 'out_of_scope' | 'not_found' | 'internal';
  constructor(code: ToolError['code'], message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}
