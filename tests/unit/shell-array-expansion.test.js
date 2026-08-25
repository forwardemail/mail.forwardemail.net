/**
 * Guard against bash 3.2 empty-array expansion in the build scripts.
 *
 * macOS ships bash 3.2.57 as /bin/bash and that is what `#!/usr/bin/env bash`
 * resolves to on a stock machine. Under `set -u`, bash below 4.4 treats
 * "${arr[@]}" on an EMPTY array as an unbound variable and aborts. Our default
 * Android profile (unified-push) is exactly the case that leaves FEATURE_ARGS
 * empty, so the unguarded form breaks `pnpm tauri:android:build` on any Mac
 * without a newer bash - while the fcm/play profiles sail through, which is
 * what makes it easy to reintroduce unnoticed.
 *
 * The safe form is ${arr[@]+"${arr[@]}"}, which expands to zero arguments when
 * empty and preserves word boundaries when not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptsDir = join(process.cwd(), 'scripts');
const shellScripts = readdirSync(scriptsDir).filter((name) => name.endsWith('.sh'));

/** Array names assigned an empty literal anywhere in the script. */
const emptyCapableArrays = (source) =>
  [...source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)=\(\s*\)\s*$/gm)].map((match) => match[1]);

const usesNounset = (source) => /^\s*set\s+-[a-z]*u/m.test(source);

describe('shell scripts', () => {
  it('has scripts to check', () => {
    expect(shellScripts.length).toBeGreaterThan(0);
  });

  it.each(shellScripts)('%s guards empty array expansion under set -u', (name) => {
    const source = readFileSync(join(scriptsDir, name), 'utf8');
    if (!usesNounset(source)) return;

    for (const array of emptyCapableArrays(source)) {
      // The unguarded form, not preceded by the `+` default-value guard.
      const unguarded = new RegExp(`(?<!\\+)"\\$\\{${array}\\[@\\]\\}"`, 'g');
      const offenders = [...source.matchAll(unguarded)];

      expect(
        offenders.length,
        `${name}: "\${${array}[@]}" aborts on bash 3.2 when ${array} is empty. ` +
          `Use \${${array}[@]+"\${${array}[@]}"} instead.`,
      ).toBe(0);
    }
  });
});
