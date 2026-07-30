import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
}

describe('iOS WebView prototype security configuration', () => {
  it('disables prototype freezing in the base and iOS-specific Tauri configs', () => {
    const base = readJson('src-tauri/tauri.conf.json');
    const ios = readJson('src-tauri/tauri.ios.conf.json');

    expect(base.app.security.freezePrototype).toBe(false);
    expect(ios.app.security.freezePrototype).toBe(false);
  });

  it.each(['ios-dev.sh', 'ios-build.sh'])(
    'passes an explicit unfrozen-prototype config from %s',
    (scriptName) => {
      const script = readFileSync(path.join(root, 'scripts', scriptName), 'utf8');
      const configMatch = script.match(/TAURI_IOS_SECURITY_CONFIG='([^']+)'/);

      expect(configMatch).not.toBeNull();
      expect(JSON.parse(configMatch[1]).app.security.freezePrototype).toBe(false);
      expect(script).toMatch(/tauri ios (?:dev|build) --config "\$TAURI_IOS_SECURITY_CONFIG"/);
    },
  );
});
