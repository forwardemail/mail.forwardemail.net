/**
 * Repository tools: `list_repo_files`, `read_repo_file`, `grep_repo`.
 *
 * These are the Phase 1.5 context tools the model uses to pull code from a
 * registered local repository when drafting support replies. All three:
 *   - require the scope to declare the target repo (via `scope.repos`); if
 *     the model asks for a repo id not in scope, the tool refuses.
 *   - enforce path safety via `resolveSafePath` (rejects absolute paths,
 *     `..`, drive letters, etc.)
 *   - impose explicit size caps (no unbounded reads)
 *   - use `@tauri-apps/plugin-fs` — imported dynamically so the module
 *     loads cleanly in web/browser environments where there is no Tauri
 *     runtime (the `availableIn` check catches that case first, but the
 *     dynamic import keeps the surface clean).
 */

import { readDir, readTextFile, stat } from '@tauri-apps/plugin-fs';
import type { ToolImpl, ToolResult, ToolExecutionContext } from './types';
import { ToolError } from './types';
import { findRepo, hasRepos } from '../context/scope';
import { getRepository } from '../repositories/store';
import { resolveSafePath, PathSafetyError } from '../repositories/path-safety';
import { walkRepository, matchesGlob, isTextFile } from '../repositories/walker';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_GREP_MATCHES = 50;
const MAX_GREP_FILES = 500;
const GREP_EXCERPT_CHARS = 160;

// `readDir` from @tauri-apps/plugin-fs returns DirEntry[]. Its signature
// matches the shape `walkRepository` expects. We adapt the String URL
// parameter path to the callback the walker calls.
const fsReadDir = (absolute: string) =>
  readDir(absolute) as unknown as Promise<
    Array<{ name?: string; isDirectory?: boolean; isFile?: boolean }>
  >;

const resolveRepoForTool = async (
  ctx: ToolExecutionContext,
  args: Record<string, unknown>,
): Promise<{ id: string; label: string; absoluteRoot: string }> => {
  const repoId = typeof args.repo_id === 'string' ? args.repo_id.trim() : '';
  if (!repoId) throw new ToolError('bad_args', 'repo_id is required');
  const ref = findRepo(ctx.scope, repoId);
  if (!ref) {
    throw new ToolError('out_of_scope', `repo_id "${repoId}" is not attached to this session`);
  }
  const config = await getRepository(repoId);
  if (!config) {
    throw new ToolError('not_found', `repository "${repoId}" has no stored config`);
  }
  return { id: repoId, label: ref.label, absoluteRoot: config.path };
};

// ---------------------------------------------------------------------------
// list_repo_files
// ---------------------------------------------------------------------------

export const listRepoFilesTool: ToolImpl = {
  def: {
    name: 'list_repo_files',
    description:
      'List files in a registered repository. Optionally filter by glob (e.g. "src/**/*.ts"). Returns up to 500 paths. Only text files are returned — binaries, images, and typical build/dependency directories are skipped.',
    parameters: {
      type: 'object',
      properties: {
        repo_id: {
          type: 'string',
          description: 'The id of a repository attached to this session.',
        },
        pattern: {
          type: 'string',
          description: 'Optional glob pattern. Supports *, **, ?.',
        },
      },
      required: ['repo_id'],
      additionalProperties: false,
    },
  },

  availableIn: (scope) => hasRepos(scope),

  async run(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const { id, label, absoluteRoot } = await resolveRepoForTool(ctx, args);
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;

    const entries = await walkRepository(absoluteRoot, fsReadDir, {
      pattern,
      maxEntries: 500,
    });

    return {
      data: {
        repo_id: id,
        pattern: pattern ?? null,
        files: entries.map((e) => ({ path: e.path })),
      },
      summary: `Listed ${entries.length} file${entries.length === 1 ? '' : 's'} in ${label}${
        pattern ? ` matching ${pattern}` : ''
      }`,
    };
  },
};

// ---------------------------------------------------------------------------
// read_repo_file
// ---------------------------------------------------------------------------

export const readRepoFileTool: ToolImpl = {
  def: {
    name: 'read_repo_file',
    description:
      'Read the contents of a single file in a registered repository. Returns up to 256 KB of text; larger files are truncated with a marker. Paths must be relative to the repo root and must not contain ".." components.',
    parameters: {
      type: 'object',
      properties: {
        repo_id: { type: 'string' },
        path: {
          type: 'string',
          description: 'Forward-slash relative path from the repo root.',
        },
      },
      required: ['repo_id', 'path'],
      additionalProperties: false,
    },
  },

  availableIn: (scope) => hasRepos(scope),

  async run(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const { id, label, absoluteRoot } = await resolveRepoForTool(ctx, args);
    const relPath = typeof args.path === 'string' ? args.path : '';

    let abs: string;
    try {
      abs = resolveSafePath(absoluteRoot, relPath);
    } catch (err) {
      if (err instanceof PathSafetyError) throw new ToolError('bad_args', err.message);
      throw err;
    }
    if (!isTextFile(relPath)) {
      throw new ToolError(
        'bad_args',
        `path "${relPath}" is not a recognized text file — binary / unsupported extension`,
      );
    }

    let size = 0;
    try {
      const s = await stat(abs);
      size = s.size;
    } catch (err) {
      throw new ToolError('not_found', `stat failed for ${relPath}: ${String(err)}`);
    }

    let content: string;
    try {
      content = await readTextFile(abs);
    } catch (err) {
      throw new ToolError('internal', `read failed for ${relPath}: ${String(err)}`);
    }

    let truncated = false;
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES) + '\n\n[…truncated to 256 KB…]';
      truncated = true;
    }

    return {
      data: { repo_id: id, path: relPath, size, truncated, content },
      summary: `Read ${label}:${relPath} (${Math.round(size / 1024)} KB${truncated ? ', truncated' : ''})`,
    };
  },
};

// ---------------------------------------------------------------------------
// grep_repo
// ---------------------------------------------------------------------------

export const grepRepoTool: ToolImpl = {
  def: {
    name: 'grep_repo',
    description:
      'Search a registered repository for a regex pattern. Returns up to 50 matches across up to 500 files. Each match has a file path, line number, and a short excerpt. Use this to find relevant files before calling read_repo_file on the full body.',
    parameters: {
      type: 'object',
      properties: {
        repo_id: { type: 'string' },
        pattern: {
          type: 'string',
          description: 'JavaScript regex pattern (e.g. "function\\s+handleLogin").',
        },
        file_glob: {
          type: 'string',
          description: 'Optional glob to restrict which files are searched.',
        },
        case_sensitive: { type: 'boolean', description: 'Default false.' },
      },
      required: ['repo_id', 'pattern'],
      additionalProperties: false,
    },
  },

  availableIn: (scope) => hasRepos(scope),

  async run(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult> {
    const { id, label, absoluteRoot } = await resolveRepoForTool(ctx, args);
    const patternStr = typeof args.pattern === 'string' ? args.pattern : '';
    if (!patternStr) throw new ToolError('bad_args', 'pattern is required');

    const flags = args.case_sensitive === true ? 'm' : 'im';
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, flags);
    } catch (err) {
      throw new ToolError('bad_args', `invalid regex: ${String(err)}`);
    }

    const fileGlob = typeof args.file_glob === 'string' ? args.file_glob : undefined;

    const files = await walkRepository(absoluteRoot, fsReadDir, {
      pattern: fileGlob,
      maxEntries: MAX_GREP_FILES,
    });

    const matches: Array<{ path: string; line: number; excerpt: string }> = [];
    for (const entry of files) {
      if (matches.length >= MAX_GREP_MATCHES) break;
      if (ctx.abort_signal.aborted) break;
      if (!matchesGlob(fileGlob ?? '', entry.path) && fileGlob) continue;

      let content: string;
      try {
        content = await readTextFile(`${absoluteRoot}/${entry.path}`);
      } catch {
        continue;
      }

      // Size-cap each file before scanning.
      const scan = content.length > MAX_FILE_BYTES ? content.slice(0, MAX_FILE_BYTES) : content;
      const lines = scan.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= MAX_GREP_MATCHES) break;
        if (regex.test(lines[i])) {
          const excerpt = lines[i].trim().slice(0, GREP_EXCERPT_CHARS);
          matches.push({ path: entry.path, line: i + 1, excerpt });
        }
      }
    }

    return {
      data: { repo_id: id, pattern: patternStr, matches, total_files_scanned: files.length },
      summary: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in ${label}`,
    };
  },
};
