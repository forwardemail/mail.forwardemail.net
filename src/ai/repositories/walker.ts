/**
 * Repository walker.
 *
 * Walks a registered repo root via `@tauri-apps/plugin-fs.readDir`, yielding
 * relative paths that pass:
 *   - not in the hardcoded skip list (`.git`, `node_modules`, build outputs)
 *   - file, not directory
 *   - extension is in the text allowlist (avoids readTextFile on binaries)
 *
 * Future (Session 2): add the `ignore` npm dep and parse `.gitignore` files
 * along the walk. For Session 1 MVP the hardcoded skip list covers the
 * common cases (Node, Rust, Python, Go, Ruby, plain build dirs).
 */

// Directories never descended into. Match by exact name (not path). Covers
// the common bulk in Node, Rust, Python, Go, Ruby, JVM, Xcode, and the major
// JS frameworks / build tools. Err on the side of skipping — a file in a
// build directory isn't useful context for drafting a support reply.
const SKIP_DIRS: ReadonlySet<string> = new Set([
  // Version control
  '.git',
  '.hg',
  '.svn',
  // IDE metadata
  '.idea',
  '.vscode',
  '.vs',
  // JS / Node
  'node_modules',
  'bower_components',
  '.yarn',
  '.pnpm-store',
  // Build outputs
  'dist',
  'build',
  'out',
  'target',
  '.output',
  '.turbo',
  '.vercel',
  '.netlify',
  'coverage',
  '.nyc_output',
  // Frameworks / bundlers
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.astro',
  '.docusaurus',
  '.expo',
  '.cache',
  '.parcel-cache',
  '.rollup.cache',
  '.webpack',
  // Python
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  'site-packages',
  // JVM / Kotlin / Android
  '.gradle',
  '.mvn',
  // iOS / macOS
  'Pods',
  'DerivedData',
  // Rust
  '.cargo',
  // Go (module cache if ever present)
  'vendor',
  // Misc
  'tmp',
  '.tmp',
  'logs',
]);

// Text-ish file extensions we're willing to read. Conservative — extend here
// rather than inverting to a binary denylist, which drifts.
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  // JS / TS ecosystem
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'svelte',
  'vue',
  'astro',
  // Web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  // Data / config
  'json',
  'jsonc',
  'yaml',
  'yml',
  'toml',
  'ini',
  'env',
  'conf',
  'properties',
  // Docs
  'md',
  'mdx',
  'rst',
  'txt',
  'adoc',
  // Systems / compiled
  'rs',
  'go',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'hh',
  'm',
  'mm',
  'swift',
  'java',
  'kt',
  'kts',
  'scala',
  // Scripts
  'py',
  'rb',
  'pl',
  'sh',
  'bash',
  'zsh',
  'fish',
  'lua',
  'php',
  'ps1',
  // DB / query
  'sql',
  'graphql',
  'gql',
  'prisma',
  // Misc text
  'xml',
  'proto',
  'dockerfile',
  'makefile',
  'cmake',
  'gradle',
  'gitignore',
  'gitattributes',
]);

const EXTENSIONLESS_TEXT_BASENAMES: ReadonlySet<string> = new Set([
  'Dockerfile',
  'Makefile',
  'Rakefile',
  'Gemfile',
  'Procfile',
  'LICENSE',
  'README',
  'CHANGELOG',
  'AUTHORS',
  'CONTRIBUTORS',
]);

export const isTextFile = (pathPart: string): boolean => {
  const base = pathPart.split('/').pop() ?? pathPart;
  if (EXTENSIONLESS_TEXT_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf('.');
  if (dot === -1 || dot === 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
};

export const shouldSkipDir = (name: string): boolean => SKIP_DIRS.has(name);

/**
 * Lightweight glob matcher: supports `*` (any non-slash chars), `**` (any
 * including slashes), `?` (single non-slash char). No character classes, no
 * negation. Good enough for common patterns like `src/**\/*.ts`. Case-
 * insensitive on the extension only matters if callers supply upper-case
 * patterns — we match case-sensitively for path precision.
 */
export const matchesGlob = (pattern: string, path: string): boolean => {
  if (!pattern) return true;
  const regex = globToRegex(pattern);
  return regex.test(path);
};

const globToRegex = (pattern: string): RegExp => {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === '*' && next === '*') {
      out += '.*';
      i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('.+^$()[]{}|\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
};

export interface WalkEntry {
  /** Forward-slash relative path from the repo root. */
  path: string;
  isDirectory: boolean;
}

export interface WalkLimits {
  maxEntries?: number;
  /** Glob matched against the relative path. When omitted, matches all. */
  pattern?: string;
}

/**
 * Walk the directory tree rooted at `root`, yielding entries that pass the
 * skip-list + text-file filter + optional glob. Breadth-first, so callers
 * see top-level files before descending into any directory.
 *
 * `readDir` is injected so this function is testable without a real FS.
 */
export const walkRepository = async (
  root: string,
  readDir: (
    absolutePath: string,
  ) => Promise<Array<{ name?: string; isDirectory?: boolean; isFile?: boolean }>>,
  limits: WalkLimits = {},
): Promise<WalkEntry[]> => {
  const maxEntries = limits.maxEntries ?? 500;
  const results: WalkEntry[] = [];

  interface QueueItem {
    absolute: string;
    relative: string;
  }
  const queue: QueueItem[] = [{ absolute: root, relative: '' }];

  while (queue.length > 0 && results.length < maxEntries) {
    const item = queue.shift();
    if (!item) break;
    let entries: Array<{ name?: string; isDirectory?: boolean; isFile?: boolean }>;
    try {
      entries = await readDir(item.absolute);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (!name) continue;
      const relPath = item.relative ? `${item.relative}/${name}` : name;

      if (entry.isDirectory) {
        if (shouldSkipDir(name)) continue;
        queue.push({ absolute: `${item.absolute}/${name}`, relative: relPath });
        continue;
      }

      if (!entry.isFile) continue;
      if (!isTextFile(relPath)) continue;
      if (limits.pattern && !matchesGlob(limits.pattern, relPath)) continue;

      results.push({ path: relPath, isDirectory: false });
      if (results.length >= maxEntries) break;
    }
  }

  return results;
};
