/**
 * Camera permission injection for the generated mobile projects.
 *
 * src-tauri/gen/ is gitignored and rebuilt from scratch, so these permissions
 * only exist if this script re-applies them on every build. The iOS half is
 * load-bearing in the strongest sense: UIKit terminates the process on first
 * camera access when NSCameraUsageDescription is absent, so a regression here
 * is a crash on a user's phone rather than a permission prompt they can deny.
 */
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const sourceScript = join(process.cwd(), 'scripts', 'configure-mobile-camera.cjs');
const fixtures = [];

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application android:label="Mail">
    </application>
</manifest>
`;

const PROJECT_YML = `name: forwardemail-desktop
targets:
  forwardemail-desktop_iOS:
    type: application
    platform: iOS
    info:
      path: forwardemail-desktop_iOS/Info.plist
      properties:
        CFBundleDisplayName: Mail
        LSRequiresIPhoneOS: true
`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Mail</string>
</dict>
</plist>
`;

function createFixture({ android = true, ios = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'forwardemail-camera-'));
  fixtures.push(root);

  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(sourceScript, join(root, 'scripts', 'configure-mobile-camera.cjs'));

  if (android) {
    const manifestDir = join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main');
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'AndroidManifest.xml'), MANIFEST);
  }

  if (ios) {
    const appleDir = join(root, 'src-tauri', 'gen', 'apple');
    const targetDir = join(appleDir, 'forwardemail-desktop_iOS');
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(appleDir, 'project.yml'), PROJECT_YML);
    writeFileSync(join(targetDir, 'Info.plist'), INFO_PLIST);
  }

  return {
    root,
    run() {
      const result = spawnSync(
        process.execPath,
        [join(root, 'scripts', 'configure-mobile-camera.cjs')],
        {
          cwd: root,
          encoding: 'utf8',
        },
      );
      if (result.status !== 0) {
        throw new Error(`script failed: ${result.stderr || result.stdout}`);
      }
      return result;
    },
    manifest: () =>
      readFileSync(
        join(root, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        'utf8',
      ),
    projectYml: () => readFileSync(join(root, 'src-tauri', 'gen', 'apple', 'project.yml'), 'utf8'),
    plist: () =>
      readFileSync(
        join(root, 'src-tauri', 'gen', 'apple', 'forwardemail-desktop_iOS', 'Info.plist'),
        'utf8',
      ),
  };
}

afterEach(() => {
  while (fixtures.length > 0) {
    const dir = fixtures.pop();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Every path that regenerates the iOS project must configure it through the
 * shared script. The camera step once went missing from the release pipeline
 * precisely because each workflow kept its own post-init list, and on iOS a
 * missing NSCameraUsageDescription is a process kill, not a permission prompt.
 */
describe('iOS post-init consolidation', () => {
  const workflowDir = join(process.cwd(), '.github', 'workflows');

  it('routes every ios-init workflow through configure-ios-project.sh', () => {
    const offenders = [];
    for (const name of readdirSync(workflowDir)) {
      if (!name.endsWith('.yml')) continue;
      const body = readFileSync(join(workflowDir, name), 'utf8');
      if (!body.includes('tauri ios init')) continue;
      if (!body.includes('configure-ios-project.sh')) offenders.push(name);
      if (body.includes('inject-ios-scene-delegate.cjs'))
        offenders.push(`${name} (direct scene-delegate call)`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the camera step before xcodegen inside the shared script', () => {
    const body = readFileSync(join(process.cwd(), 'scripts', 'configure-ios-project.sh'), 'utf8');
    const camera = body.indexOf('configure-mobile-camera.cjs');
    const sceneDelegate = body.indexOf('inject-ios-scene-delegate.cjs');
    expect(camera).toBeGreaterThan(-1);
    expect(sceneDelegate).toBeGreaterThan(camera);
  });
});

describe('configure-mobile-camera', () => {
  it('declares CAMERA in the Android manifest', () => {
    const fixture = createFixture();
    fixture.run();

    expect(fixture.manifest()).toContain(
      '<uses-permission android:name="android.permission.CAMERA" />',
    );
  });

  it('marks the camera feature optional so camera-less devices still install', () => {
    const fixture = createFixture();
    fixture.run();

    expect(fixture.manifest()).toContain(
      '<uses-feature android:name="android.hardware.camera" android:required="false" />',
    );
  });

  it('keeps the manifest well-formed and leaves existing permissions alone', () => {
    const fixture = createFixture();
    fixture.run();
    const manifest = fixture.manifest();

    expect(manifest).toContain('android.permission.INTERNET');
    expect(manifest.indexOf('android.permission.CAMERA')).toBeLessThan(
      manifest.indexOf('<application'),
    );
    expect(manifest).toMatch(/<\/manifest>\s*$/);
  });

  it('adds NSCameraUsageDescription to project.yml, which is what xcodegen reads', () => {
    const fixture = createFixture();
    fixture.run();
    const yml = fixture.projectYml();

    expect(yml).toContain('NSCameraUsageDescription:');
    // Must sit inside info.properties at the same indent as its siblings, or
    // xcodegen drops it silently.
    expect(yml).toMatch(/\n {8}NSCameraUsageDescription: "[^"]+"\n/);
    expect(yml).toContain('CFBundleDisplayName: Mail');
  });

  it('declares the local-network usage description for dev-on-device', () => {
    const fixture = createFixture();
    fixture.run();

    expect(fixture.projectYml()).toContain('NSLocalNetworkUsageDescription:');
    expect(fixture.plist()).toContain('<key>NSLocalNetworkUsageDescription</key>');
  });

  it('adds a newly introduced key to a project that already has the older ones', () => {
    // The regression this guards: a single includes() early-return skipped the
    // whole block when any one key was present, so projects configured before
    // a key was introduced never received it.
    const fixture = createFixture();
    fixture.run();

    const ymlWithoutLocalNetwork = fixture
      .projectYml()
      .split('\n')
      .filter((line) => !line.includes('NSLocalNetworkUsageDescription'))
      .join('\n');
    writeFileSync(
      join(fixture.root, 'src-tauri', 'gen', 'apple', 'project.yml'),
      ymlWithoutLocalNetwork,
    );

    fixture.run();

    expect(fixture.projectYml()).toContain('NSLocalNetworkUsageDescription:');
    // And the key that was already there is not duplicated.
    expect(fixture.projectYml().match(/NSCameraUsageDescription/g)).toHaveLength(1);
  });

  it('also patches Info.plist directly, for when xcodegen is unavailable', () => {
    const fixture = createFixture();
    fixture.run();
    const plist = fixture.plist();

    expect(plist).toContain('<key>NSCameraUsageDescription</key>');
    expect(plist).toMatch(/<\/dict>\s*<\/plist>\s*$/);
    expect(plist).toContain('CFBundleDisplayName');
  });

  it('is idempotent across repeated builds', () => {
    const fixture = createFixture();
    fixture.run();
    const first = {
      manifest: fixture.manifest(),
      yml: fixture.projectYml(),
      plist: fixture.plist(),
    };

    fixture.run();
    fixture.run();

    expect(fixture.manifest()).toBe(first.manifest);
    expect(fixture.projectYml()).toBe(first.yml);
    expect(fixture.plist()).toBe(first.plist);
  });

  it('skips a platform whose project has not been generated', () => {
    const androidOnly = createFixture({ ios: false });
    expect(() => androidOnly.run()).not.toThrow();
    expect(androidOnly.manifest()).toContain('android.permission.CAMERA');

    const iosOnly = createFixture({ android: false });
    expect(() => iosOnly.run()).not.toThrow();
    expect(iosOnly.plist()).toContain('NSCameraUsageDescription');
  });
});
