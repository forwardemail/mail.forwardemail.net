/**
 * scripts/check-clear-manifest.js is run by CI with the base branch of a pull
 * request, and a branch name can hold almost any character.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.join(process.cwd(), 'scripts', 'check-clear-manifest.js');

describe('check-clear-manifest', () => {
  it('does not run a base ref as a shell command', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'clear-manifest-'));
    const marker = path.join(dir, 'marker');
    try {
      const result = spawnSync(process.execPath, [script, `origin/main;touch ${marker};#`], {
        encoding: 'utf8',
      });
      expect(existsSync(marker)).toBe(false);
      // git rejects the name, which the script reports as nothing to check.
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Could not determine changed files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
