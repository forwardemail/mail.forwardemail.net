/**
 * @vitest-environment jsdom
 *
 * Source-level regression guard: ensures that no file in the static import
 * chain reachable from the web entry points uses a top-level (non-dynamic)
 * import of @tauri-apps/api/core or other Tauri-only modules.
 *
 * A static bare-module import of a Tauri package that ends up in an entry
 * chunk causes the browser to throw:
 *   TypeError: Failed to resolve module specifier "@tauri-apps/api/core".
 *   Relative references must start with either "/", "./", or "../".
 *
 * This crashes the entire app and renders a blank page (the 0.12.15 incident).
 *
 * The `rejectStaticTauriWebImportsPlugin` in vite.config.js is the build-time
 * guard, but this test provides a fast source-level assertion that catches the
 * issue before the full build even runs.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');

const TAURI_BARE_MODULES = [
  '@tauri-apps/api/core',
  '@tauri-apps/api/event',
  '@tauri-apps/api/window',
  '@tauri-apps/plugin-notification',
  '@tauri-apps/plugin-updater',
  '@tauri-apps/plugin-os',
  '@tauri-apps/plugin-deep-link',
  '@tauri-apps/plugin-process',
  'tauri-plugin-remote-push-api',
];

// Matches top-level static import statements (not dynamic import())
const STATIC_IMPORT_RE = /^import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm;

function getStaticImports(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const imports = [];
  let match;
  const re = new RegExp(STATIC_IMPORT_RE.source, 'gm');
  while ((match = re.exec(content)) !== null) {
    imports.push(match[1]);
  }

  return imports;
}

function resolveImport(specifier, fromFile) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const dir = path.dirname(fromFile);
  const extensions = ['.js', '.ts', '.svelte', '/index.js', '/index.ts', ''];
  for (const ext of extensions) {
    const candidate = path.resolve(dir, specifier + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  return null;
}

function walkStaticImportGraph(entryFile) {
  const visited = new Set();
  const violations = [];

  function walk(filePath) {
    const normalized = path.resolve(filePath);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    const imports = getStaticImports(normalized);
    for (const specifier of imports) {
      // Check if this is a Tauri bare module
      if (TAURI_BARE_MODULES.some((m) => specifier === m || specifier.startsWith(m + '/'))) {
        violations.push({
          file: path.relative(ROOT, normalized),
          specifier,
        });
      }

      // Resolve relative imports and continue walking
      const resolved = resolveImport(specifier, normalized);
      if (resolved) walk(resolved);
    }
  }

  walk(entryFile);
  return violations;
}

describe('static import graph from web entry points', () => {
  it('src/main.ts must not transitively import Tauri bare modules', () => {
    const violations = walkStaticImportGraph(path.join(ROOT, 'src/main.ts'));
    expect(
      violations.map((v) => `${v.file} imports "${v.specifier}"`),
      'Static Tauri imports in the entry graph cause a blank page. ' +
        'Use platform-guarded dynamic import() instead.',
    ).toEqual([]);
  });

  it('src/utils/unified-push.js must use dynamic import for @tauri-apps/api/core', () => {
    const filePath = path.join(ROOT, 'src/utils/unified-push.js');
    const content = fs.readFileSync(filePath, 'utf8');

    // Must NOT have a static import of @tauri-apps/api/core
    expect(content).not.toMatch(/^import\s+.*from\s+['"]@tauri-apps\/api\/core['"]/m);

    // MUST have a dynamic import of @tauri-apps/api/core
    expect(content).toMatch(/import\(['"]@tauri-apps\/api\/core['"]\)/);
  });

  it('vite.config.js must include rejectStaticTauriWebImportsPlugin', () => {
    const filePath = path.join(ROOT, 'vite.config.js');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('rejectStaticTauriWebImportsPlugin');
  });

  it('vite.config.js must include stubTauriModulesPlugin for defense-in-depth', () => {
    const filePath = path.join(ROOT, 'vite.config.js');
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('stubTauriModulesPlugin');
  });

  it('vite.config.js must NOT use rollupOptions.external for Tauri modules', () => {
    const filePath = path.join(ROOT, 'vite.config.js');
    const content = fs.readFileSync(filePath, 'utf8');
    // The external approach leaves bare specifiers in the output which crash browsers.
    // The stubTauriModulesPlugin resolves them to empty stubs instead.
    const externalBlock = content.match(/rollupOptions[\s\S]*?external\s*:/)?.[0] || '';
    expect(externalBlock).not.toContain('@tauri-apps');
  });
});
