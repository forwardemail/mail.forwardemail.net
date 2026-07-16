import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  DISPLAY_NAME,
  configureMobileDisplayName,
  setAndroidString,
  setPlistString,
} = require('../../scripts/configure-mobile-display-name.cjs');

const temporaryRoots = [];

function createTemporaryRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'forward-email-display-name-'));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

describe('mobile launcher display-name configuration', () => {
  it('replaces generated Android launcher labels with the spaced app name', () => {
    const root = createTemporaryRoot();
    const stringsPath = path.join(
      root,
      'src-tauri/gen/android/app/src/main/res/values/strings.xml',
    );
    mkdirSync(path.dirname(stringsPath), { recursive: true });
    writeFileSync(
      stringsPath,
      '<resources>\n    <string name="app_name">ForwardEmail</string>\n    <string name="main_activity_title">ForwardEmail</string>\n</resources>\n',
    );

    const first = configureMobileDisplayName(root);
    const second = configureMobileDisplayName(root);
    const result = readFileSync(stringsPath, 'utf8');

    expect(DISPLAY_NAME).toBe('Forward Email');
    expect(result).toContain('<string name="app_name">Forward Email</string>');
    expect(result).toContain('<string name="main_activity_title">Forward Email</string>');
    expect(first.changed).toEqual([stringsPath]);
    expect(second.changed).toEqual([]);
  });

  it('adds or replaces CFBundleDisplayName in every generated iOS plist', () => {
    const root = createTemporaryRoot();
    const firstPlist = path.join(root, 'src-tauri/gen/apple/ForwardEmail_iOS/Info.plist');
    const secondPlist = path.join(root, 'src-tauri/gen/apple/Sources/ForwardEmail/Info.plist');
    mkdirSync(path.dirname(firstPlist), { recursive: true });
    mkdirSync(path.dirname(secondPlist), { recursive: true });
    writeFileSync(
      firstPlist,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleDisplayName</key><string>ForwardEmail</string></dict></plist>\n',
    );
    writeFileSync(
      secondPlist,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>net.forwardemail.app</string></dict></plist>\n',
    );

    const result = configureMobileDisplayName(root);

    expect(result.changed.sort()).toEqual([firstPlist, secondPlist].sort());
    for (const plistPath of [firstPlist, secondPlist]) {
      const plist = readFileSync(plistPath, 'utf8');
      expect(plist).toContain('<key>CFBundleDisplayName</key>');
      expect(plist).toContain('<string>Forward Email</string>');
    }
  });

  it('keeps standalone XML and plist transforms idempotent', () => {
    const android = '<resources>\n</resources>\n';
    const withAndroidName = setAndroidString(android, 'app_name', DISPLAY_NAME);
    expect(setAndroidString(withAndroidName, 'app_name', DISPLAY_NAME)).toBe(withAndroidName);

    const plist = '<plist><dict>\n</dict></plist>\n';
    const withIosName = setPlistString(plist, 'CFBundleDisplayName', DISPLAY_NAME);
    expect(setPlistString(withIosName, 'CFBundleDisplayName', DISPLAY_NAME)).toBe(withIosName);
  });

  it.each(['android-build.sh', 'android-dev.sh', 'ios-build.sh', 'ios-dev.sh'])(
    'runs the display-name configurator from %s',
    (scriptName) => {
      const script = readFileSync(path.join(process.cwd(), 'scripts', scriptName), 'utf8');
      expect(script).toContain('node scripts/configure-mobile-display-name.cjs');
      expect(script.indexOf('node scripts/configure-mobile-display-name.cjs')).toBeGreaterThan(
        script.indexOf('tauri ios init') >= 0
          ? script.indexOf('tauri ios init')
          : script.indexOf('tauri android init'),
      );
    },
  );
});
