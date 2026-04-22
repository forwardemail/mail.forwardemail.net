/**
 * Path safety tests.
 *
 * This is the single most security-critical module in the repo-tools path —
 * anything that lets a model-supplied string escape the registered repository
 * root becomes an arbitrary file read primitive. Every rejection case that
 * ever mattered historically (Windows drive letters, parent traversal, null
 * byte, UNC, backslash-to-forwardslash) lands here. If anyone weakens
 * `normalizeRelativePath` in the future, this suite catches it.
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeRelativePath,
  resolveSafePath,
  isWithinRoot,
  PathSafetyError,
} from '../../../src/ai/repositories/path-safety';

describe('normalizeRelativePath', () => {
  it('accepts plain relative paths', () => {
    expect(normalizeRelativePath('src/api/auth.ts')).toBe('src/api/auth.ts');
    expect(normalizeRelativePath('README.md')).toBe('README.md');
  });

  it('strips redundant ./ segments', () => {
    expect(normalizeRelativePath('./src/./api/./auth.ts')).toBe('src/api/auth.ts');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(normalizeRelativePath('src\\api\\auth.ts')).toBe('src/api/auth.ts');
  });

  it('rejects absolute POSIX paths', () => {
    expect(() => normalizeRelativePath('/etc/passwd')).toThrow(PathSafetyError);
    try {
      normalizeRelativePath('/etc/passwd');
    } catch (err) {
      expect((err as PathSafetyError).code).toBe('absolute_path');
    }
  });

  it('rejects Windows drive letters', () => {
    expect(() => normalizeRelativePath('C:\\Users\\me\\secret')).toThrow(PathSafetyError);
    expect(() => normalizeRelativePath('c:/Windows/System32')).toThrow(PathSafetyError);
  });

  it('rejects parent traversal', () => {
    expect(() => normalizeRelativePath('../../../etc/passwd')).toThrow(PathSafetyError);
    expect(() => normalizeRelativePath('src/../../secret')).toThrow(PathSafetyError);
    expect(() => normalizeRelativePath('./..')).toThrow(PathSafetyError);
  });

  it('rejects null byte injection', () => {
    expect(() => normalizeRelativePath('README.md\0.png')).toThrow(PathSafetyError);
  });

  it('rejects empty or whitespace-only paths', () => {
    expect(() => normalizeRelativePath('')).toThrow(PathSafetyError);
    expect(() => normalizeRelativePath('./')).toThrow(PathSafetyError);
    expect(() => normalizeRelativePath('.')).toThrow(PathSafetyError);
  });

  it('rejects non-string input', () => {
    // @ts-expect-error — runtime guard test; intentionally passing null
    expect(() => normalizeRelativePath(null)).toThrow(PathSafetyError);
    // @ts-expect-error — runtime guard test; intentionally passing number
    expect(() => normalizeRelativePath(42)).toThrow(PathSafetyError);
  });

  it('collapses multiple slashes', () => {
    expect(normalizeRelativePath('src//api///auth.ts')).toBe('src/api/auth.ts');
  });

  it('preserves unicode filenames', () => {
    expect(normalizeRelativePath('docs/résumé.md')).toBe('docs/résumé.md');
  });
});

describe('resolveSafePath', () => {
  it('joins root and relative with a single separator', () => {
    expect(resolveSafePath('/home/me/repo', 'src/api.ts')).toBe('/home/me/repo/src/api.ts');
  });

  it('tolerates trailing slashes on the root', () => {
    expect(resolveSafePath('/home/me/repo/', 'src/api.ts')).toBe('/home/me/repo/src/api.ts');
    expect(resolveSafePath('/home/me/repo///', 'src/api.ts')).toBe('/home/me/repo/src/api.ts');
  });

  it('propagates PathSafetyError for bad relative paths', () => {
    expect(() => resolveSafePath('/home/me/repo', '../../etc')).toThrow(PathSafetyError);
    expect(() => resolveSafePath('/home/me/repo', '/etc')).toThrow(PathSafetyError);
  });
});

describe('isWithinRoot', () => {
  it('accepts the root itself', () => {
    expect(isWithinRoot('/home/me/repo', '/home/me/repo')).toBe(true);
  });

  it('accepts paths under the root', () => {
    expect(isWithinRoot('/home/me/repo/src/api.ts', '/home/me/repo')).toBe(true);
  });

  it('rejects sibling paths with matching prefix', () => {
    // The "repo-secret" directory looks like it starts with "/home/me/repo"
    // but is NOT a child — must still reject.
    expect(isWithinRoot('/home/me/repo-secret/foo', '/home/me/repo')).toBe(false);
  });

  it('rejects parents of the root', () => {
    expect(isWithinRoot('/home/me', '/home/me/repo')).toBe(false);
    expect(isWithinRoot('/', '/home/me/repo')).toBe(false);
  });

  it('normalizes trailing slashes', () => {
    expect(isWithinRoot('/home/me/repo/src', '/home/me/repo/')).toBe(true);
  });

  it('handles backslash-style paths', () => {
    expect(isWithinRoot('C:\\users\\me\\repo\\src', 'C:\\users\\me\\repo')).toBe(true);
  });
});
