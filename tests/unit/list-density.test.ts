import { describe, expect, it } from 'vitest';
import { resolveListDensity } from '../../src/stores/viewStore';

describe('resolveListDensity', () => {
  it('keeps each known density', () => {
    expect(resolveListDensity('comfortable')).toBe('comfortable');
    expect(resolveListDensity('compact')).toBe('compact');
    expect(resolveListDensity('power')).toBe('power');
  });

  it('falls back to compact for a missing or unknown value', () => {
    expect(resolveListDensity(undefined)).toBe('compact');
    expect(resolveListDensity(null)).toBe('compact');
    expect(resolveListDensity('')).toBe('compact');
    // A value written by a newer build this one does not know.
    expect(resolveListDensity('ultra')).toBe('compact');
    expect(resolveListDensity('Power')).toBe('compact');
  });
});
