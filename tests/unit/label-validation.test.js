import { describe, it, expect } from 'vitest';
import { validateLabelName, LABEL_NAME_PATTERN } from '../../src/utils/label-validation.ts';

describe('validateLabelName', () => {
  it('accepts valid label names', () => {
    expect(validateLabelName('work')).toEqual({ ok: true, value: 'work' });
    expect(validateLabelName('$inbox')).toEqual({ ok: true, value: '$inbox' });
    expect(validateLabelName('project-alpha')).toEqual({ ok: true, value: 'project-alpha' });
    expect(validateLabelName('v2.0')).toEqual({ ok: true, value: 'v2.0' });
    expect(validateLabelName('my_label')).toEqual({ ok: true, value: 'my_label' });
    expect(validateLabelName('A')).toEqual({ ok: true, value: 'A' });
    expect(validateLabelName('9lives')).toEqual({ ok: true, value: '9lives' });
  });

  it('trims whitespace', () => {
    expect(validateLabelName('  trimmed  ')).toEqual({ ok: true, value: 'trimmed' });
  });

  it('rejects empty/null/undefined', () => {
    expect(validateLabelName('')).toEqual({ ok: false, error: 'Name is required.' });
    expect(validateLabelName(null)).toEqual({ ok: false, error: 'Name is required.' });
    expect(validateLabelName(undefined)).toEqual({ ok: false, error: 'Name is required.' });
  });

  it('rejects names with spaces', () => {
    const result = validateLabelName('has space');
    expect(result.ok).toBe(false);
  });

  it('rejects names starting with invalid characters', () => {
    expect(validateLabelName('-dash').ok).toBe(false);
    expect(validateLabelName('.dot').ok).toBe(false);
    expect(validateLabelName('_under').ok).toBe(false);
  });

  it('rejects names with special punctuation', () => {
    expect(validateLabelName('a@b').ok).toBe(false);
    expect(validateLabelName('a!b').ok).toBe(false);
    expect(validateLabelName('a/b').ok).toBe(false);
  });
});

describe('LABEL_NAME_PATTERN', () => {
  it('matches valid patterns', () => {
    expect(LABEL_NAME_PATTERN.test('abc')).toBe(true);
    expect(LABEL_NAME_PATTERN.test('$special')).toBe(true);
    expect(LABEL_NAME_PATTERN.test('a.b-c_d')).toBe(true);
  });

  it('rejects invalid patterns', () => {
    expect(LABEL_NAME_PATTERN.test('')).toBe(false);
    expect(LABEL_NAME_PATTERN.test(' ')).toBe(false);
    expect(LABEL_NAME_PATTERN.test('-start')).toBe(false);
  });
});
