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

  it('allows app-specific openUrl calls for http and https URLs in Tauri capabilities', () => {
    const capability = JSON.parse(
      fs.readFileSync(path.join(repoRoot, 'src-tauri/capabilities/default.json'), 'utf8'),
    );
    const openerPermission = capability.permissions.find(
      (entry) => entry && typeof entry === 'object' && entry.identifier === 'opener:allow-open-url',
    );

    expect(openerPermission).toBeTruthy();
    expect(openerPermission.allow).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ url: 'https://*', app: true }),
        expect.objectContaining({ url: 'http://*', app: true }),
      ]),
    );
  });
});
