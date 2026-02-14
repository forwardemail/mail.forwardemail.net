import { describe, it, expect } from 'vitest';
import { validateFolderName } from '../../src/utils/folder-validation.ts';

describe('validateFolderName', () => {
  it('accepts valid folder names', () => {
    expect(validateFolderName('Inbox')).toEqual({ ok: true, value: 'Inbox' });
    expect(validateFolderName('Work Projects')).toEqual({ ok: true, value: 'Work Projects' });
    expect(validateFolderName('Archive-2024')).toEqual({ ok: true, value: 'Archive-2024' });
  });

  it('trims whitespace', () => {
    expect(validateFolderName('  Trimmed  ')).toEqual({ ok: true, value: 'Trimmed' });
  });

  it('rejects empty/null/undefined names', () => {
    expect(validateFolderName('')).toEqual({ ok: false, error: 'Folder name is required' });
    expect(validateFolderName(null)).toEqual({ ok: false, error: 'Folder name is required' });
    expect(validateFolderName(undefined)).toEqual({ ok: false, error: 'Folder name is required' });
    expect(validateFolderName('   ')).toEqual({ ok: false, error: 'Folder name is required' });
  });

  it('rejects names with invalid characters', () => {
    const invalids = [
      'folder/sub',
      'back\\slash',
      'col:on',
      'star*',
      'quest?',
      'quote"',
      'lt<',
      'gt>',
      'pipe|',
    ];
    for (const name of invalids) {
      const result = validateFolderName(name);
      expect(result.ok, `"${name}" should be invalid`).toBe(false);
      expect(result.error).toContain('invalid characters');
    }
  });
});
