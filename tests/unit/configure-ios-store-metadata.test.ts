/**
 * Unit tests for scripts/configure-ios-store-metadata.cjs.
 *
 * The script runs against the gitignored, regenerated Xcode project, so these
 * tests build a throwaway src-tauri/gen/apple tree shaped like the Tauri
 * template and check that the privacy manifest lands in the target folder and
 * that TARGETED_DEVICE_FAMILY is written once, under settings.base.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'configure-ios-store-metadata.cjs');
const TRACKED_MANIFEST = path.join(ROOT, 'src-tauri', 'PrivacyInfo.xcprivacy');

// Mirrors the settings block Tauri's project.yml template generates.
const SAMPLE_PROJECT_YML = `name: forwardemail-desktop
targets:
  forwardemail-desktop_iOS:
    type: application
    platform: iOS
    sources:
      - path: forwardemail-desktop_iOS
    info:
      path: forwardemail-desktop_iOS/Info.plist
      properties:
        LSRequiresIPhoneOS: true
    settings:
      base:
        SWIFT_OBJC_BRIDGING_HEADER: "forwardemail-desktop_iOS/TaoWindowCapture-Bridging.h"
        SWIFT_VERSION: "5.0"
        ENABLE_BITCODE: false
      groups: [app]
`;

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-store-metadata-'));
  const appleDir = path.join(dir, 'src-tauri', 'gen', 'apple');
  const targetDir = path.join(appleDir, 'forwardemail-desktop_iOS');
  fs.mkdirSync(targetDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(appleDir, 'project.yml'), SAMPLE_PROJECT_YML);
  // The script resolves the repo root relative to its own location, so copy
  // it and the tracked manifest into the sandbox.
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'configure-ios-store-metadata.cjs'));
  fs.copyFileSync(TRACKED_MANIFEST, path.join(dir, 'src-tauri', 'PrivacyInfo.xcprivacy'));
  return { dir, appleDir, targetDir };
}

function run(dir: string) {
  return execSync(`node ${path.join(dir, 'scripts', 'configure-ios-store-metadata.cjs')}`, {
    encoding: 'utf8',
  });
}

describe('configure-ios-store-metadata', () => {
  let sandbox: ReturnType<typeof makeSandbox>;

  beforeEach(() => {
    sandbox = makeSandbox();
  });

  afterEach(() => {
    fs.rmSync(sandbox.dir, { recursive: true, force: true });
  });

  it('copies the tracked privacy manifest into the iOS target folder', () => {
    run(sandbox.dir);
    const copied = path.join(sandbox.targetDir, 'PrivacyInfo.xcprivacy');
    expect(fs.existsSync(copied)).toBe(true);
    expect(fs.readFileSync(copied, 'utf8')).toBe(fs.readFileSync(TRACKED_MANIFEST, 'utf8'));
  });

  it('declares the required-reason APIs and no tracking in the tracked manifest', () => {
    const manifest = fs.readFileSync(TRACKED_MANIFEST, 'utf8');
    expect(manifest).toContain('<key>NSPrivacyTracking</key>\n  <false/>');
    for (const category of [
      'NSPrivacyAccessedAPICategoryUserDefaults',
      'NSPrivacyAccessedAPICategoryFileTimestamp',
      'NSPrivacyAccessedAPICategoryDiskSpace',
      'NSPrivacyAccessedAPICategorySystemBootTime',
    ]) {
      expect(manifest).toContain(category);
    }
  });

  it('writes TARGETED_DEVICE_FAMILY under the iOS target settings.base block', () => {
    run(sandbox.dir);
    const yml = fs.readFileSync(path.join(sandbox.appleDir, 'project.yml'), 'utf8');
    const lines = yml.split('\n');
    const swiftLine = lines.findIndex((l) => l.includes('SWIFT_VERSION:'));
    expect(lines[swiftLine + 1]).toBe('        TARGETED_DEVICE_FAMILY: "1,2"');
  });

  it('is idempotent across a second run', () => {
    run(sandbox.dir);
    const first = fs.readFileSync(path.join(sandbox.appleDir, 'project.yml'), 'utf8');
    const output = run(sandbox.dir);
    const second = fs.readFileSync(path.join(sandbox.appleDir, 'project.yml'), 'utf8');
    expect(second).toBe(first);
    expect(second.match(/TARGETED_DEVICE_FAMILY/g)).toHaveLength(1);
    expect(output).toContain('already configured');
  });

  it('fails loudly when the tracked manifest is missing', () => {
    fs.rmSync(path.join(sandbox.dir, 'src-tauri', 'PrivacyInfo.xcprivacy'));
    expect(() => run(sandbox.dir)).toThrow(/privacy manifest must be tracked/);
  });
});
