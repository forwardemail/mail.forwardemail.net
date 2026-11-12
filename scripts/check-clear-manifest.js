#!/usr/bin/env node

/**
 * Checks if changed files between two git refs match any patterns in
 * .clear-site-data.json. If so, warns that clear-manifest.json may
 * need updating.
 *
 * Usage:
 *   node scripts/check-clear-manifest.js [base-ref]
 *
 * If base-ref is omitted, defaults to origin/main.
 *
 * Exit codes:
 *   0 — no clear-triggering files changed
 *   1 — clear-triggering files changed (warning)
 *
 * In CI, this posts a PR comment via GITHUB_OUTPUT. Locally, it prints
 * to stdout.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// Load config
let config;
try {
  config = JSON.parse(readFileSync(resolve(root, '.clear-site-data.json'), 'utf8'));
} catch {
  console.log('No .clear-site-data.json found — skipping check');
  process.exit(0);
}

const triggers = config.triggers || {};
const baseRef = process.argv[2] || 'origin/main';

// Get changed files. The base ref is the name of a branch, which can hold
// almost any character, so git is run directly instead of through a shell.
const diffNames = (...revisions) =>
  execFileSync('git', ['diff', '--name-only', '--diff-filter=ACDMRT', ...revisions], {
    cwd: root,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);

let changedFiles;
try {
  changedFiles = diffNames(`${baseRef}...HEAD`);
} catch {
  // If the diff fails (e.g., shallow clone), try without the merge-base syntax
  try {
    changedFiles = diffNames(baseRef, 'HEAD');
  } catch {
    console.log('Could not determine changed files — skipping check');
    process.exit(0);
  }
}

if (!changedFiles.length) {
  console.log('No changed files');
  process.exit(0);
}

// Simple glob matching (supports * and ** patterns)
function matchesPattern(file, pattern) {
  // Exact match
  if (file === pattern) return true;

  // Convert glob to regex
  const regex = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regex}$`).test(file);
}

// Check each target
const matched = {};
for (const [target, patterns] of Object.entries(triggers)) {
  const hits = [];
  for (const file of changedFiles) {
    for (const pattern of patterns) {
      if (matchesPattern(file, pattern)) {
        hits.push(file);
        break;
      }
    }
  }
  if (hits.length) {
    matched[target] = hits;
  }
}

if (!Object.keys(matched).length) {
  console.log('No clear-triggering files changed');
  process.exit(0);
}

// Build warning message
const lines = ['## Clear-Site-Data Warning', ''];
lines.push(
  'The following changes may require updating `public/clear-manifest.json`.',
  'If this release changes DB schema, service worker behavior, or cache strategy,',
  'set `clear_below` to the current version to force client resets.',
  '',
);

for (const [target, files] of Object.entries(matched)) {
  lines.push(`### Target: \`${target}\``);
  for (const f of files) {
    lines.push(`- \`${f}\``);
  }
  lines.push('');
}

lines.push(
  '> To trigger a client reset, update `public/clear-manifest.json`:',
  '> ```json',
  '> { "version": "<new-version>", "clear_below": "<new-version>" }',
  '> ```',
  '> See `docs/clear-site-data-spec.md` for details.',
);

const message = lines.join('\n');
console.log(message);

// Write to GITHUB_OUTPUT if available (for CI)
if (process.env.GITHUB_OUTPUT) {
  // Multiline output
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `clear_warning<<EOF\n${message}\nEOF\n`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_warning=true\n`);
}

process.exit(1);
