/**
 * Tool Registry
 *
 * Central dispatch point for `ai.worker`. Given a scope, returns the tool
 * definitions that are available (for offering to the model) and dispatches
 * `tool_call` events to the implementation layer.
 *
 * Design invariants:
 * - `availableIn(scope)` is the single source of truth for "can the model see
 *   this tool" — the registry never hands out a `ToolDef` whose impl would
 *   later refuse the scope.
 * - `execute()` always calls the impl's `run()`, which runs its own scope
 *   check. This is belt-and-suspenders — if `getAllowedTools` is ever
 *   bypassed, the impl still refuses.
 */

import type { ToolDef } from '../providers/types';
import type { ContextScope } from '../context/scope';
import type { ToolImpl, ToolResult, ToolExecutionContext } from './types';
import { ToolError } from './types';
import { listFoldersTool } from './list-folders';
import { searchMessagesTool } from './search-messages';
import { getThreadTool } from './get-thread';
import { listRepoFilesTool, readRepoFileTool, grepRepoTool } from './repo-tools';

const REGISTRY: Readonly<Record<string, ToolImpl>> = Object.freeze({
  list_folders: listFoldersTool,
  search_messages: searchMessagesTool,
  get_thread: getThreadTool,
  list_repo_files: listRepoFilesTool,
  read_repo_file: readRepoFileTool,
  grep_repo: grepRepoTool,
});

export const getAllowedTools = (scope: ContextScope): ToolDef[] =>
  Object.values(REGISTRY)
    .filter((t) => t.availableIn(scope))
    .map((t) => t.def);

export const hasTools = (scope: ContextScope): boolean => getAllowedTools(scope).length > 0;

/**
 * Execute a tool call. Parses args JSON, dispatches to the impl, normalizes
 * errors. Never throws — returns a structured error result the worker can
 * feed back to the model as a `tool_result`.
 */
export const executeTool = async (
  name: string,
  argsJson: string,
  ctx: ToolExecutionContext,
): Promise<
  { ok: true; result: ToolResult } | { ok: false; error: ToolError | Error; summary: string }
> => {
  const impl = REGISTRY[name];
  if (!impl) {
    const err = new ToolError('not_found', `Unknown tool: ${name}`);
    return { ok: false, error: err, summary: err.message };
  }

  let args: Record<string, unknown>;
  try {
    args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
  } catch (err) {
    const toolErr = new ToolError('bad_args', `Invalid JSON arguments: ${String(err)}`);
    return { ok: false, error: toolErr, summary: toolErr.message };
  }

  try {
    const result = await impl.run(args, ctx);
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: err, summary: err.message };
    }
    const wrapped = new ToolError('internal', err instanceof Error ? err.message : String(err));
    return { ok: false, error: wrapped, summary: wrapped.message };
  }
};
