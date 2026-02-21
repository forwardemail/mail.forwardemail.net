#!/usr/bin/env node

/**
 * Validates that SCHEMA_VERSION in public/sw-sync.js matches
 * src/utils/db-constants.ts. A mismatch means the service worker
 * would read/write a different IndexedDB database than the main app.
 *
 * Exit codes:
 *   0 — versions match
 *   1 — mismatch or parse failure
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// sync-core.js is the shared sync logic inlined into sw-sync.js at build time.
// It has its own SCHEMA_VERSION that must match db-constants.ts.
const SW_PATH = resolve(root, 'src/utils/sync-core.js');
const DB_PATH = resolve(root, 'src/utils/db-constants.ts');

function extractVersion(filePath, label) {
  const src = readFileSync(filePath, 'utf8');
  const match = src.match(/^\s*(?:export\s+)?const\s+SCHEMA_VERSION\s*=\s*(\d+)/m);
  if (!match) {
    console.error(`Could not find SCHEMA_VERSION in ${label} (${filePath})`);
    process.exit(1);
  }
  return Number(match[1]);
}

const swVersion = extractVersion(SW_PATH, 'sync-core.js');
const dbVersion = extractVersion(DB_PATH, 'db-constants.ts');

if (swVersion !== dbVersion) {
  console.error(
    `SCHEMA_VERSION mismatch: sync-core.js has ${swVersion}, db-constants.ts has ${dbVersion}.\n` +
      'Both files must use the same version or the service worker will use a different database.',
  );
  process.exit(1);
}

console.log(`SCHEMA_VERSION OK (${dbVersion})`);
