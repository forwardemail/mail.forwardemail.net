import { describe, expect, it } from 'vitest';
import {
  isTextFile,
  shouldSkipDir,
  matchesGlob,
  walkRepository,
} from '../../../src/ai/repositories/walker';

describe('isTextFile', () => {
  it.each(['src/api.ts', 'README.md', 'package.json', 'docs/guide.mdx', 'Dockerfile', 'Makefile'])(
    'accepts %s',
    (path) => {
      expect(isTextFile(path)).toBe(true);
    },
  );

  it.each(['logo.png', 'binary.exe', 'archive.zip', 'video.mp4'])('rejects %s', (path) => {
    expect(isTextFile(path)).toBe(false);
  });

  it('rejects files without an extension and without a known basename', () => {
    expect(isTextFile('LICENSE')).toBe(true); // known basename
    expect(isTextFile('somefile')).toBe(false);
  });
});

describe('shouldSkipDir', () => {
  it.each(['.git', 'node_modules', 'dist', 'target', '__pycache__'])('skips %s', (name) => {
    expect(shouldSkipDir(name)).toBe(true);
  });

  it('does not skip source directories', () => {
    expect(shouldSkipDir('src')).toBe(false);
    expect(shouldSkipDir('lib')).toBe(false);
  });
});

describe('matchesGlob', () => {
  it('* matches any non-slash characters', () => {
    expect(matchesGlob('*.ts', 'api.ts')).toBe(true);
    expect(matchesGlob('*.ts', 'src/api.ts')).toBe(false);
  });

  it('** matches across directory boundaries', () => {
    expect(matchesGlob('src/**/*.ts', 'src/api/auth.ts')).toBe(true);
    expect(matchesGlob('**/test.ts', 'a/b/c/test.ts')).toBe(true);
  });

  it('? matches a single character', () => {
    expect(matchesGlob('a?.ts', 'ab.ts')).toBe(true);
    expect(matchesGlob('a?.ts', 'abc.ts')).toBe(false);
  });

  it('escapes regex-significant characters in the pattern', () => {
    expect(matchesGlob('v1.2.ts', 'v1.2.ts')).toBe(true);
    // A literal `.` must not match any character
    expect(matchesGlob('v1.2.ts', 'v1X2.ts')).toBe(false);
  });

  it('empty pattern matches everything', () => {
    expect(matchesGlob('', 'anything')).toBe(true);
  });
});

describe('walkRepository', () => {
  // Build a fake FS keyed by absolute path → entries.
  const makeFs =
    (tree: Record<string, Array<{ name: string; isDirectory?: boolean; isFile?: boolean }>>) =>
    async (absolute: string) => {
      const entries = tree[absolute];
      if (!entries) throw new Error(`no such dir: ${absolute}`);
      return entries;
    };

  it('walks files, skipping ignored directories and non-text files', async () => {
    const fs = makeFs({
      '/repo': [
        { name: 'src', isDirectory: true },
        { name: 'node_modules', isDirectory: true },
        { name: 'README.md', isFile: true },
        { name: 'logo.png', isFile: true },
      ],
      '/repo/src': [
        { name: 'api.ts', isFile: true },
        { name: 'util.ts', isFile: true },
        { name: 'assets', isDirectory: true },
      ],
      '/repo/src/assets': [{ name: 'icon.svg', isFile: true }],
      // node_modules should never be entered
    });

    const result = await walkRepository('/repo', fs);
    const paths = result.map((e) => e.path).sort();
    expect(paths).toEqual(['README.md', 'src/api.ts', 'src/util.ts']);
    // logo.png filtered by isTextFile
    // src/assets/icon.svg not in TEXT_EXTENSIONS, filtered
    // node_modules never traversed
  });

  it('respects maxEntries', async () => {
    const fs = makeFs({
      '/repo': Array.from({ length: 50 }, (_, i) => ({
        name: `file${i}.ts`,
        isFile: true,
      })),
    });
    const result = await walkRepository('/repo', fs, { maxEntries: 10 });
    expect(result).toHaveLength(10);
  });

  it('applies glob pattern', async () => {
    const fs = makeFs({
      '/repo': [
        { name: 'api.ts', isFile: true },
        { name: 'types.d.ts', isFile: true },
        { name: 'README.md', isFile: true },
      ],
    });
    const result = await walkRepository('/repo', fs, { pattern: '*.ts' });
    expect(result.map((e) => e.path).sort()).toEqual(['api.ts', 'types.d.ts']);
  });

  it('survives readDir errors on subdirectories (continues)', async () => {
    const fs = async (abs: string) => {
      if (abs === '/repo') {
        return [
          { name: 'bad', isDirectory: true },
          { name: 'good.ts', isFile: true },
        ];
      }
      throw new Error('EACCES');
    };
    const result = await walkRepository('/repo', fs);
    expect(result.map((e) => e.path)).toEqual(['good.ts']);
  });
});
