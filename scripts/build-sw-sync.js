#!/usr/bin/env node

/**
 * Forward Email – build-sw-sync.js
 *
 * Inlines the shared `src/utils/sync-core.js` into `dist/sw-sync.js` so that
 * the Workbox-generated service worker can `importScripts('sw-sync.js')` and
 * get the full sync + mutation-queue logic without a separate network request.
 *
 * ─── How it works ────────────────────────────────────────────────────────
 *
 *   1. Reads `src/utils/sync-core.js` (ES module).
 *   2. Strips the `export` keyword from `export function createSyncCore`
 *      so the function becomes a plain declaration visible in the IIFE scope
 *      of sw-sync.js.
 *   3. Replaces the placeholder block between the BUILD_INJECT markers in
 *      `dist/sw-sync.js` with the transformed source.
 *   4. Writes the result back to `dist/sw-sync.js`.
 *
 * ─── Integration ─────────────────────────────────────────────────────────
 *
 *   Called automatically by the `build` npm script:
 *
 *     "build": "vite build && node scripts/build-sw-sync.js && workbox generateSW workbox.config.cjs"
 *
 *   The order matters:
 *     • Vite copies `public/sw-sync.js` → `dist/sw-sync.js` (with placeholder)
 *     • This script inlines the core into `dist/sw-sync.js`
 *     • Workbox picks up the completed `dist/sw-sync.js` via importScripts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, '..');
const CORE_SRC = resolve(ROOT, 'src', 'utils', 'sync-core.js');
const SW_SYNC_DIST = resolve(ROOT, 'dist', 'sw-sync.js');

const START_MARKER = '// @BUILD_INJECT_SYNC_CORE_START';
const END_MARKER = '// @BUILD_INJECT_SYNC_CORE_END';

function main() {
  // 1. Read the sync-core ES module source
  if (!existsSync(CORE_SRC)) {
    console.error(`[build-sw-sync] ERROR: ${CORE_SRC} not found`);
    process.exit(1);
  }

  let coreSource = readFileSync(CORE_SRC, 'utf8');

  // 2. Convert ES module → plain function declaration
  //    Strip `export` from `export function createSyncCore`
  coreSource = coreSource.replace(
    /^export\s+function\s+createSyncCore/m,
    'function createSyncCore',
  );

  // Remove any other ES module syntax (import/export) that might exist
  // The sync-core module should be self-contained, but just in case:
  coreSource = coreSource
    .split('\n')
    .filter((line) => !line.match(/^\s*(import|export)\s/))
    .join('\n');

  // 3. Read the sw-sync.js template from dist
  if (!existsSync(SW_SYNC_DIST)) {
    console.error(`[build-sw-sync] ERROR: ${SW_SYNC_DIST} not found (run vite build first)`);
    process.exit(1);
  }

  let swSync = readFileSync(SW_SYNC_DIST, 'utf8');

  // 4. Replace the placeholder block
  const startIdx = swSync.indexOf(START_MARKER);
  const endIdx = swSync.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error('[build-sw-sync] ERROR: Could not find BUILD_INJECT markers in dist/sw-sync.js');
    process.exit(1);
  }

  const before = swSync.slice(0, startIdx + START_MARKER.length);
  const after = swSync.slice(endIdx);

  swSync = `${before}\n${coreSource}\n  ${after}`;

  // 5. Write back
  writeFileSync(SW_SYNC_DIST, swSync, 'utf8');

  const sizeKb = (Buffer.byteLength(swSync, 'utf8') / 1024).toFixed(1);
  console.log(`[build-sw-sync] Inlined sync-core into dist/sw-sync.js (${sizeKb} KB)`);
}

main();
