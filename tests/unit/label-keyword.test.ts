/**
 * Label keyword canonicalization — regression guard for the "tags vanish after
 * refresh / don't show cross-client" bug.
 *
 * The backend (forwardemail.net) lowercases every message label keyword on save
 * (`normalizeLabelKeyword` = trim + lowercase). The client used to key its
 * labelMap and compare tags with case PRESERVED, so a "Work" definition no
 * longer matched the server-returned "work" keyword after a round-trip — the
 * chip then hide-rendered (`{#if labelMap.get(lbl)}`). `canonicalizeLabelKeyword`
 * must mirror the backend so every identity boundary (labelMap keying/lookup,
 * contextLabel send, picker applied-state) matches case-insensitively.
 */
import { describe, expect, it } from 'vitest';
import { canonicalizeLabelKeyword } from '../../src/utils/labels.js';

describe('canonicalizeLabelKeyword', () => {
  it('trims and lowercases (mirrors the backend normalizeLabelKeyword)', () => {
    expect(canonicalizeLabelKeyword('Work')).toBe('work');
    expect(canonicalizeLabelKeyword('  Work  ')).toBe('work');
    expect(canonicalizeLabelKeyword('Project-X')).toBe('project-x');
    expect(canonicalizeLabelKeyword('IMPORTANT')).toBe('important');
  });

  it('is idempotent and stable for already-canonical keywords', () => {
    expect(canonicalizeLabelKeyword('work')).toBe('work');
    expect(canonicalizeLabelKeyword(canonicalizeLabelKeyword('Work'))).toBe('work');
  });

  it('coerces nullish / non-string input without throwing', () => {
    expect(canonicalizeLabelKeyword(null)).toBe('');
    expect(canonicalizeLabelKeyword(undefined)).toBe('');
    expect(canonicalizeLabelKeyword(123 as unknown as string)).toBe('123');
  });
});

describe('labelMap case-insensitive matching (the round-trip regression)', () => {
  // Mirror how Mailbox.svelte builds labelMap: keyed by the canonical keyword.
  const buildLabelMap = (defs: Array<{ keyword: string; name: string }>) =>
    new Map(defs.map((d) => [canonicalizeLabelKeyword(d.keyword), d]));

  it('matches a server-lowercased keyword against a case-preserved definition', () => {
    const labelMap = buildLabelMap([{ keyword: 'Work', name: 'Work' }]);
    // Pre-fix: labelMap.get('work') was undefined (keyed by 'Work') → chip hidden.
    const def = labelMap.get(canonicalizeLabelKeyword('work'));
    expect(def?.name).toBe('Work');
  });

  it('still resolves when both definition and keyword are lowercase', () => {
    const labelMap = buildLabelMap([{ keyword: 'urgent', name: 'urgent' }]);
    expect(labelMap.get(canonicalizeLabelKeyword('urgent'))?.name).toBe('urgent');
  });

  it('returns undefined for a keyword with no definition (caller renders a fallback chip)', () => {
    const labelMap = buildLabelMap([{ keyword: 'Work', name: 'Work' }]);
    // Definition not loaded on this client → lookup misses, but the render now
    // falls back to the raw keyword instead of hiding the tag.
    expect(labelMap.get(canonicalizeLabelKeyword('clientonly'))).toBeUndefined();
  });

  it('contextLabel add/remove membership is case-insensitive', () => {
    // Existing (server) labels are lowercase; a click sends "Work".
    const current = ['work'].map(canonicalizeLabelKeyword);
    const clicked = canonicalizeLabelKeyword('Work');
    expect(current.includes(clicked)).toBe(true); // recognized as already-applied → toggles off
  });
});
