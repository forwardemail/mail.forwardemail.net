#!/usr/bin/env node
/**
 * Release notes for every client, built from the commits in a release.
 *
 * `write` runs in the npm `version` hook (after sync-version.cjs), so np puts
 * its output in the release commit:
 *   - a new section at the top of CHANGELOG.md, the source of truth
 *   - a <description> on this version's <release> in the AppStream metainfo
 *
 * Store uploads in CI read CHANGELOG.md back with `print --target <name>`, so
 * the tagged commit decides what every store shows.
 *
 * Which commits make it in:
 *   - `Release-note: <text>` lines in the commit body win. `Release-note(ios):`
 *     limits one to a platform, and `Release-note: none` hides the commit.
 *   - Otherwise feat, fix and perf subjects are used, split on "; ".
 *   - A platform scope (`fix(ios): ...`) limits the subject to that platform.
 *   - Everything else (chore, docs, test, ci, refactor, release commits) is
 *     left out.
 *
 * Usage:
 *   node scripts/release-notes.mjs write [--from <tag>] [--to <ref>]
 *   node scripts/release-notes.mjs preview [--from <tag>] [--to <ref>]
 *   node scripts/release-notes.mjs print --version <x.y.z> --target <target>
 *
 * Targets: github, android (Play and F-Droid), ios, linux.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(root, 'CHANGELOG.md');
const metainfoPath = path.join(root, 'net.forwardemail.mail.metainfo.xml');

export const FALLBACK_NOTE = 'Bug fixes and performance improvements.';

// Store limits on the "what's new" field.
export const TARGET_LIMITS = { android: 500, ios: 4000 };

const PLATFORM_LABELS = {
  ios: 'iOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  desktop: 'Desktop',
  terminal: 'Terminal',
  web: 'Web',
};

// Commit scopes that name a platform. Any other scope (calendar, compose)
// means the change reaches every client.
const SCOPE_PLATFORMS = {
  ios: ['ios'],
  android: ['android'],
  mobile: ['ios', 'android'],
  macos: ['macos'],
  mac: ['macos'],
  windows: ['windows'],
  linux: ['linux'],
  desktop: ['desktop'],
  cli: ['terminal'],
  terminal: ['terminal'],
  tui: ['terminal'],
  web: ['web'],
  webmail: ['web'],
};

// Which entries each target shows: those for every client plus these.
const TARGET_PLATFORMS = {
  android: ['android'],
  ios: ['ios'],
  linux: ['linux', 'desktop'],
};

const HEADINGS = { features: 'New', fixes: 'Fixes' };

const SUBJECT_RE = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const TRAILER_RE = /^release-note(?:\(([^)]*)\))?:\s*(.*)$/i;

const parsePlatforms = (list) =>
  [
    ...new Set(
      String(list || '')
        .split(/[,\s]+/)
        .flatMap((scope) => SCOPE_PLATFORMS[scope.toLowerCase()] || []),
    ),
  ].sort();

/** Turns a commit subject fragment into a sentence-style note. */
export const cleanText = (text) => {
  let cleaned = String(text)
    .replace(/\[skip ci\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
  // Capitalize "fix the thing" but leave "iOS" or "UnifiedPush" alone.
  if (/^[a-z]+\b/.test(cleaned) && !/^[a-z]+[A-Z]/.test(cleaned)) {
    cleaned = cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  return cleaned;
};

/**
 * Notes from one commit: [] when it is not user facing, otherwise entries of
 * { section: 'features' | 'fixes', text, platforms }.
 */
export const notesFromCommit = ({ subject, body = '' }) => {
  const match = SUBJECT_RE.exec(String(subject).trim());
  const type = match?.[1]?.toLowerCase();
  const section = type === 'feat' ? 'features' : 'fixes';

  const trailers = String(body)
    .split('\n')
    .map((line) => TRAILER_RE.exec(line.trim()))
    .filter(Boolean);
  if (trailers.length > 0) {
    return trailers
      .filter(([, , text]) => text.trim() && !/^none\.?$/i.test(text.trim()))
      .map(([, scope, text]) => ({
        section,
        text: cleanText(text),
        platforms: parsePlatforms(scope),
      }));
  }

  if (!match || !['feat', 'fix', 'perf'].includes(type)) return [];
  if (/^release$/i.test(match[2] || '')) return [];
  const platforms = parsePlatforms(match[2]);
  return match[4]
    .split(/;\s+/)
    .map(cleanText)
    .filter(Boolean)
    .map((text) => ({ section, text, platforms }));
};

/** Collects notes from commits (oldest first), dropping reverted pairs. */
export const buildNotes = (commits) => {
  const reverted = new Set();
  for (const commit of commits) {
    const hash = /This reverts commit ([0-9a-f]{7,40})/.exec(commit.body || '')?.[1];
    if (hash) {
      reverted.add(commit.hash);
      reverted.add(hash);
    }
  }
  const isReverted = (hash) =>
    [...reverted].some((r) => hash && (hash.startsWith(r) || r.startsWith(hash)));

  const notes = { features: [], fixes: [] };
  const seen = new Set();
  for (const commit of commits) {
    if (isReverted(commit.hash)) continue;
    for (const note of notesFromCommit(commit)) {
      const key = `${note.section}\n${note.text.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notes[note.section].push({ text: note.text, platforms: note.platforms });
    }
  }
  return notes;
};

const platformSuffix = (platforms) =>
  platforms.length ? ` _(${platforms.map((p) => PLATFORM_LABELS[p] || p).join(', ')})_` : '';

/** The CHANGELOG.md section for one version. */
export const renderMarkdown = (version, date, notes) => {
  const lines = [`## ${version} (${date})`, ''];
  const sections = Object.keys(HEADINGS).filter((key) => notes[key].length > 0);
  if (sections.length === 0) return [...lines, FALLBACK_NOTE, ''].join('\n');
  for (const key of sections) {
    lines.push(`### ${HEADINGS[key]}`, '');
    for (const note of notes[key]) lines.push(`- ${note.text}${platformSuffix(note.platforms)}`);
    lines.push('');
  }
  return lines.join('\n');
};

const LABEL_PLATFORMS = Object.fromEntries(
  Object.entries(PLATFORM_LABELS).map(([key, label]) => [label.toLowerCase(), key]),
);

/** Reads one version's notes back out of CHANGELOG.md, or null if absent. */
export const parseChangelogSection = (changelog, version) => {
  const lines = String(changelog).split('\n');
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^## \\[?v?${escaped}\\]?(\\s|$)`).test(line));
  if (start === -1) return null;

  const notes = { features: [], fixes: [] };
  const headingKeys = Object.fromEntries(Object.entries(HEADINGS).map(([k, v]) => [v, k]));
  let section = 'fixes';
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    const heading = /^### (.+)$/.exec(line);
    if (heading) {
      section = headingKeys[heading[1].trim()] || 'fixes';
      continue;
    }
    const bullet = /^[-*] (.+)$/.exec(line);
    if (!bullet) continue;
    const suffix = /\s_\(([^)]+)\)_$/.exec(bullet[1]);
    const platforms = suffix
      ? suffix[1]
          .split(',')
          .map((label) => LABEL_PLATFORMS[label.trim().toLowerCase()])
          .filter(Boolean)
      : [];
    const text = suffix ? bullet[1].slice(0, suffix.index) : bullet[1];
    notes[section].push({ text: text.trim(), platforms });
  }
  return notes;
};

const forTarget = (notes, target) => {
  const allowed = TARGET_PLATFORMS[target];
  if (!allowed) return notes;
  const keep = (note) =>
    note.platforms.length === 0 || note.platforms.some((p) => allowed.includes(p));
  return { features: notes.features.filter(keep), fixes: notes.fixes.filter(keep) };
};

/**
 * Plain text for a store's "what's new" field. Notes that would push it past
 * `limit` are dropped from the end and replaced with "...and more".
 */
export const renderStoreText = (notes, { limit = Infinity } = {}) => {
  const sections = Object.keys(HEADINGS).filter((key) => notes[key].length > 0);
  if (sections.length === 0) return FALLBACK_NOTE;

  const more = '…and more.';
  const out = [];
  let truncated = false;
  const fits = (lines) => [...lines, more].join('\n').length <= limit;
  for (const key of sections) {
    const heading = `${HEADINGS[key]}:`;
    for (const [index, note] of notes[key].entries()) {
      let bullet = `• ${note.text}`;
      const next =
        index === 0 ? [...out, ...(out.length ? [''] : []), heading, bullet] : [...out, bullet];
      if (!fits(next)) {
        // A single note longer than the whole limit is cut down rather than lost.
        if (out.length === 0) {
          // Two newlines, the "• " prefix and the trailing "…".
          const room = limit - heading.length - more.length - 5;
          bullet = `• ${note.text.slice(0, Math.max(room, 0)).trimEnd()}…`;
          out.push(heading, bullet);
        }
        truncated = true;
        break;
      }
      out.splice(0, out.length, ...next);
    }
    if (truncated) break;
  }
  if (truncated) out.push(more);
  return out.join('\n');
};

const escapeXml = (text) =>
  String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The AppStream <description> body for a <release>, indented to fit. */
export const renderMetainfoDescription = (notes) => {
  const pad = '        ';
  const sections = Object.keys(HEADINGS).filter((key) => notes[key].length > 0);
  if (sections.length === 0) return `${pad}<p>${escapeXml(FALLBACK_NOTE)}</p>`;
  const lines = [];
  for (const key of sections) {
    lines.push(`${pad}<p>${HEADINGS[key]}</p>`, `${pad}<ul>`);
    for (const note of notes[key]) lines.push(`${pad}  <li>${escapeXml(note.text)}</li>`);
    lines.push(`${pad}</ul>`);
  }
  return lines.join('\n');
};

/** Adds (or replaces) the description on this version's <release> entry. */
export const applyMetainfoRelease = (metainfo, version, notes, date) => {
  const escaped = version.replace(/\./g, '\\.');
  const existing = new RegExp(
    `^( *)<release version="${escaped}"([^>]*?)(?:/>|>[\\s\\S]*?</release>)`,
    'm',
  );
  const description = renderMetainfoDescription(forTarget(notes, 'linux'));
  const build = (indent, attrs) =>
    `${indent}<release version="${version}"${attrs}>\n${indent}  <description>\n${description}\n${indent}  </description>\n${indent}</release>`;

  if (existing.test(metainfo)) {
    return metainfo.replace(existing, (_, indent, attrs) => build(indent, attrs.trimEnd()));
  }
  if (/^ {2}<releases>\n/m.test(metainfo)) {
    return metainfo.replace(
      /^ {2}<releases>\n/m,
      `  <releases>\n${build('    ', ` date="${date}"`)}\n`,
    );
  }
  return metainfo;
};

const CHANGELOG_HEADER = `# Changelog

User-facing changes in each release. \`scripts/release-notes.mjs\` writes each
section from commit messages when the version is bumped, and the app store
release notes are taken from here. To change what a commit says, add a
\`Release-note: <text>\` line to its message (or \`Release-note: none\` to leave
it out).
`;

/** Puts a version's section at the top of the changelog, replacing any older copy. */
export const applyChangelogSection = (changelog, version, section) => {
  let text = changelog && changelog.trim() ? changelog : CHANGELOG_HEADER;
  const escaped = version.replace(/\./g, '\\.');
  text = text.replace(
    new RegExp(`^## ${escaped} \\([^)]*\\)\\n[\\s\\S]*?(?=^## |(?![\\s\\S]))`, 'm'),
    '',
  );
  const firstSection = text.search(/^## /m);
  const body = `${section.trimEnd()}\n\n`;
  if (firstSection === -1) return `${text.trimEnd()}\n\n${body}`.replace(/\n+$/, '\n');
  return `${text.slice(0, firstSection)}${body}${text.slice(firstSection)}`.replace(/\n+$/, '\n');
};

// ── git and CLI ───────────────────────────────────────────────────────────

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const readCommits = (from, to) => {
  const range = from ? `${from}..${to}` : to;
  const raw = git('log', '--reverse', '--format=%H%x1f%s%x1f%b%x1e', range);
  return raw
    .split('\x1e')
    .map((entry) => entry.replace(/^\n/, ''))
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body] = entry.split('\x1f');
      return { hash, subject, body: body || '' };
    });
};

const previousTag = (to) => {
  try {
    // At the version hook HEAD is the last commit before the new tag. When
    // `to` is itself a tag, step back one commit to find the release before it.
    const isTag = git('tag', '--points-at', to).split('\n').includes(to);
    return git('describe', '--tags', '--abbrev=0', isTag ? `${to}^` : to);
  } catch {
    return '';
  }
};

const parseArgs = (argv) => {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else args._.push(argv[i]);
  }
  return args;
};

const generate = (args) => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = args.version || pkg.version;
  const to = args.to || 'HEAD';
  const from = args.from ?? previousTag(to);
  const date = args.to
    ? git('log', '-1', '--format=%cs', to)
    : new Date().toISOString().slice(0, 10);
  const notes = buildNotes(readCommits(from, to));
  return { version, date, notes, from, to };
};

const main = (argv) => {
  const args = parseArgs(argv);
  const command = args._[0];

  if (command === 'write' || command === 'preview') {
    const { version, date, notes, from, to } = generate(args);
    const section = renderMarkdown(version, date, notes);
    if (command === 'preview') {
      process.stdout.write(`${section}\n`);
      return;
    }
    const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
    writeFileSync(changelogPath, applyChangelogSection(changelog, version, section));
    if (existsSync(metainfoPath)) {
      const metainfo = readFileSync(metainfoPath, 'utf8');
      writeFileSync(metainfoPath, applyMetainfoRelease(metainfo, version, notes, date));
    }
    console.log(
      `Release notes for ${version} (${from || 'start'}..${to}) → CHANGELOG.md, metainfo`,
    );
    return;
  }

  if (command === 'print') {
    const { version, target = 'github' } = args;
    if (!version) throw new Error('print needs --version');
    const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '';
    const notes = parseChangelogSection(changelog, version.replace(/^v/, ''));
    if (!notes) {
      console.error(`No CHANGELOG.md section for ${version}`);
      process.exitCode = 2;
      return;
    }
    if (target === 'github') {
      const section = renderMarkdown(version, '', notes).split('\n').slice(2).join('\n');
      process.stdout.write(`${section.trim()}\n`);
      return;
    }
    if (!TARGET_LIMITS[target] && target !== 'linux') throw new Error(`Unknown target: ${target}`);
    process.stdout.write(
      `${renderStoreText(forTarget(notes, target), { limit: TARGET_LIMITS[target] })}\n`,
    );
    return;
  }

  throw new Error('Usage: release-notes.mjs write|preview|print [options]');
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
