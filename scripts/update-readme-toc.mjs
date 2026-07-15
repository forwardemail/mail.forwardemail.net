#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const TOC_START = '<!-- readme-toc:start -->';
const TOC_END = '<!-- readme-toc:end -->';

function githubSlug(value, occurrences) {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, '')
    .replace(/[^\p{L}\p{N}\p{M}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
  const count = occurrences.get(base) || 0;
  occurrences.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

function headingText(value) {
  return value
    .replace(/\s+#+\s*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[*_~`]/g, '')
    .trim();
}

export function buildTableOfContents(readme) {
  const lines = readme.split(/\r?\n/);
  const entries = [];
  const occurrences = new Map();
  let fence;

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) fence = marker;
      else if (fence === marker) fence = undefined;
      continue;
    }

    if (fence) continue;

    const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (!match) continue;

    const depth = match[1].length;
    const text = headingText(match[2]);
    if (!text || text.toLowerCase() === 'table of contents') continue;

    entries.push({ depth, slug: githubSlug(text, occurrences), text });
  }

  return entries
    .map(({ depth, slug, text }) => `${'  '.repeat(depth - 2)}- [${text}](#${slug})`)
    .join('\n');
}

export function replaceTableOfContents(readme, tableOfContents) {
  const newline = readme.includes('\r\n') ? '\r\n' : '\n';
  const normalizedTableOfContents = tableOfContents.replace(/\r?\n/g, newline);
  const startIndex = readme.indexOf(TOC_START);
  const endIndex = readme.indexOf(TOC_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error('README table-of-contents markers are missing or out of order');
  }

  if (readme.indexOf(TOC_START, startIndex + TOC_START.length) !== -1) {
    throw new Error('README contains more than one table-of-contents start marker');
  }

  if (readme.indexOf(TOC_END, endIndex + TOC_END.length) !== -1) {
    throw new Error('README contains more than one table-of-contents end marker');
  }

  const before = readme.slice(0, startIndex + TOC_START.length);
  const after = readme.slice(endIndex);
  return `${before}${newline}${newline}${normalizedTableOfContents}${newline}${newline}${after}`;
}

export function updateTableOfContents(readme) {
  return replaceTableOfContents(readme, buildTableOfContents(readme));
}

async function run() {
  const { values } = parseArgs({
    options: {
      check: { default: false, type: 'boolean' },
      help: { default: false, type: 'boolean' },
    },
    strict: true,
  });

  if (values.help) {
    console.log('Usage: node scripts/update-readme-toc.mjs [--check]');
    return;
  }

  const readmePath = path.join(process.cwd(), 'README.md');
  const original = await fs.readFile(readmePath, 'utf8');
  const generated = updateTableOfContents(original);

  if (values.check) {
    if (generated !== original) {
      console.error('README.md has a stale generated table of contents.');
      console.error('Run "pnpm docs:toc" and commit the result.');
      process.exitCode = 1;
    }
    return;
  }

  if (generated !== original) await fs.writeFile(readmePath, generated);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
