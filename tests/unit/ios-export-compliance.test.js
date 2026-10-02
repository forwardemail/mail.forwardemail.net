/**
 * Export-compliance keys written into the generated iOS Info.plist.
 *
 * The app ships standard encryption on top of the system's own and is not
 * offered in France, so App Store Connect treats it as exempt and the flag is
 * false. A compliance code from Apple (after a French declaration) flips it to
 * true and adds ITSEncryptionExportComplianceCode. These tests write a real
 * plist through the XML path that runs when plutil is unavailable.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { applyExportCompliance } = require('../../scripts/ios-export-compliance.cjs');

// Shaped like the Info.plist Tauri generates and Info.ios.plist merges into.
const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Mail</string>
\t<key>ITSAppUsesNonExemptEncryption</key>
\t<false/>
</dict>
</plist>
`;

const dirs = [];

function plistFile(contents = INFO_PLIST) {
  const dir = mkdtempSync(join(tmpdir(), 'ios-export-compliance-'));
  dirs.push(dir);
  const file = join(dir, 'Info.plist');
  writeFileSync(file, contents);
  return file;
}

function keys(file) {
  const doc = new DOMParser().parseFromString(readFileSync(file, 'utf8'), 'application/xml');
  expect(doc.querySelector('parsererror')).toBeNull();
  const out = {};
  const children = [...doc.querySelector('plist > dict').children];
  for (let i = 0; i < children.length; i += 2) {
    const value = children[i + 1];
    out[children[i].textContent] =
      value.tagName === 'true' ? true : value.tagName === 'false' ? false : value.textContent;
  }
  return out;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('applyExportCompliance', () => {
  it('declares exempt encryption and no compliance code by default', () => {
    const file = plistFile();
    expect(applyExportCompliance(file, { env: {}, plutil: false })).toEqual({
      usesNonExemptEncryption: false,
      code: '',
    });
    expect(keys(file)).toEqual({
      CFBundleDisplayName: 'Mail',
      ITSAppUsesNonExemptEncryption: false,
    });
  });

  it('adds the flag when the generated plist lacks it', () => {
    const file = plistFile(INFO_PLIST.replace(/\t<key>ITSApp[^]*?<false\/>\n/, ''));
    applyExportCompliance(file, { env: {}, plutil: false });
    expect(keys(file).ITSAppUsesNonExemptEncryption).toBe(false);
  });

  it('declares non-exempt encryption with Apple’s code once France is added', () => {
    const file = plistFile();
    applyExportCompliance(file, {
      env: { IOS_ENCRYPTION_COMPLIANCE_CODE: ' a1b2-C3d4 ' },
      plutil: false,
    });
    expect(keys(file)).toEqual({
      CFBundleDisplayName: 'Mail',
      ITSAppUsesNonExemptEncryption: true,
      ITSEncryptionExportComplianceCode: 'a1b2-C3d4',
    });
  });

  it('removes a stale code when a later build has none', () => {
    const file = plistFile();
    applyExportCompliance(file, { env: { IOS_ENCRYPTION_COMPLIANCE_CODE: 'abc' }, plutil: false });
    applyExportCompliance(file, { env: {}, plutil: false });
    expect(keys(file)).toEqual({
      CFBundleDisplayName: 'Mail',
      ITSAppUsesNonExemptEncryption: false,
    });
  });

  it('is idempotent', () => {
    const file = plistFile();
    const env = { IOS_ENCRYPTION_COMPLIANCE_CODE: 'abc' };
    applyExportCompliance(file, { env, plutil: false });
    const first = readFileSync(file, 'utf8');
    applyExportCompliance(file, { env, plutil: false });
    expect(readFileSync(file, 'utf8')).toBe(first);
  });

  it('rejects a code that is not letters, digits and hyphens', () => {
    const file = plistFile();
    expect(() =>
      applyExportCompliance(file, {
        env: { IOS_ENCRYPTION_COMPLIANCE_CODE: 'abc"; rm -rf /' },
        plutil: false,
      }),
    ).toThrow(/letters, digits and hyphens/);
    expect(readFileSync(file, 'utf8')).toBe(INFO_PLIST);
  });
});

// `tauri ios build` merges the plists into the app, later ones winning: the
// generated Info.plist (which inject-ios-signing.cjs edits through
// applyExportCompliance), then src-tauri/Info.plist, then
// src-tauri/Info.ios.plist (tauri-cli, mobile/ios/build.rs).
describe('export compliance in the built app', () => {
  const SRC_TAURI = join(process.cwd(), 'src-tauri');

  // A plist named in bundle.iOS.infoPlist would be merged last, after these.
  it('has no bundle.iOS.infoPlist that would be merged over them', () => {
    for (const file of ['tauri.conf.json', 'tauri.ios.conf.json']) {
      const config = JSON.parse(readFileSync(join(SRC_TAURI, file), 'utf8'));
      expect(config.bundle?.iOS?.infoPlist, file).toBeUndefined();
    }
  });

  function builtApp(env) {
    const generated = plistFile(INFO_PLIST.replace(/\t<key>ITSApp[^]*?<false\/>\n/, ''));
    applyExportCompliance(generated, { env, plutil: false });
    return {
      ...keys(generated),
      ...keys(join(SRC_TAURI, 'Info.plist')),
      ...keys(join(SRC_TAURI, 'Info.ios.plist')),
    };
  }

  it('declares exempt encryption while the app is not offered in France', () => {
    const app = builtApp({});
    expect(app.ITSAppUsesNonExemptEncryption).toBe(false);
    expect(app).not.toHaveProperty('ITSEncryptionExportComplianceCode');
  });

  it('declares non-exempt encryption with Apple’s code once France is added', () => {
    const app = builtApp({ IOS_ENCRYPTION_COMPLIANCE_CODE: 'abc-123' });
    expect(app.ITSAppUsesNonExemptEncryption).toBe(true);
    expect(app.ITSEncryptionExportComplianceCode).toBe('abc-123');
  });
});
