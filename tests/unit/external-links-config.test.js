import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getSettingDefinition,
  parseLocalValue,
  serializeLocalValue,
  SETTING_SCOPES,
} from '../../src/stores/settingsRegistry';

const repoRoot = path.resolve(import.meta.dirname, '../..');

describe('external link override configuration', () => {
  it('registers the browser override as a device-only trimmed string setting', () => {
    const def = getSettingDefinition('external_browser_override');

    expect(def).toBeTruthy();
    expect(def.scope).toBe(SETTING_SCOPES.DEVICE);
    expect(def.valueType).toBe('string');
    expect(def.defaultValue).toBe('');
    expect(parseLocalValue(def, '  firefox  ')).toBe('firefox');
    expect(serializeLocalValue(def, '  firefox  ')).toBe('firefox');
  });

  const readCapability = (name) =>
    JSON.parse(fs.readFileSync(path.join(repoRoot, `src-tauri/capabilities/${name}.json`), 'utf8'));
  const findPermission = (capability, identifier) =>
    capability.permissions.find(
      (entry) => entry && typeof entry === 'object' && entry.identifier === identifier,
    );

  it('allows openUrl only with the system default program, on every platform', () => {
    // http and https URLs, opened with the system default
    const opener = findPermission(readCapability('default'), 'opener:allow-open-url');
    expect(opener.allow).toEqual([{ url: 'https://*' }, { url: 'http://*' }]);

    // No capability lets the webview name the program (`app`): that ran any
    // executable with the URL as its command line. The Windows browser
    // override goes through the open_url_in_browser command instead.
    const dir = path.join(repoRoot, 'src-tauri/capabilities');
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const capability = readCapability(file.replace(/\.json$/, ''));
      for (const entry of capability.permissions) {
        const identifier = typeof entry === 'string' ? entry : entry?.identifier;
        expect(identifier, file).not.toMatch(/^opener:(?:default|allow-default-urls)$/);
        if (identifier === 'opener:allow-open-url') {
          for (const scope of entry.allow || []) expect(scope.app, file).toBeUndefined();
        }
      }
    }
  });

  it('only allows writing the temp files that Open Original can open', () => {
    const capability = readCapability('default');
    const write = findPermission(capability, 'fs:allow-write-file');
    const open = findPermission(capability, 'opener:allow-open-path');
    expect(write.allow).toEqual(open.allow);
  });
});
