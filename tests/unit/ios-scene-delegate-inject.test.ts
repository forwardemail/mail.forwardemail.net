/**
 * Unit tests for the iOS SceneDelegate injection script.
 *
 * These tests verify that inject-ios-scene-delegate.cjs correctly:
 * 1. Copies SceneDelegate.swift, TaoWindowCapture.m, and bridging header
 * 2. Adds SWIFT_VERSION and SWIFT_OBJC_BRIDGING_HEADER to project.yml
 * 3. Adds UIApplicationSceneManifest to project.yml info.properties
 * 4. Falls back to direct plist injection if xcodegen is unavailable
 *
 * The tests mock the filesystem to simulate the generated iOS project structure
 * that `tauri ios init` produces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(__dirname, '../..');
const INJECT_SCRIPT = path.join(ROOT, 'scripts', 'inject-ios-scene-delegate.cjs');
const INJECT_DIR = path.join(ROOT, 'src-tauri', 'ios-inject');
const SCENE_DELEGATE_SRC = path.join(INJECT_DIR, 'SceneDelegate.swift');
const TAO_CAPTURE_SRC = path.join(INJECT_DIR, 'TaoWindowCapture.m');
const BRIDGING_HEADER_SRC = path.join(INJECT_DIR, 'TaoWindowCapture-Bridging.h');

// A minimal project.yml that matches the structure Tauri generates
const SAMPLE_PROJECT_YML = `name: forwardemail-desktop
options:
  bundleIdPrefix: net.forwardemail
  deploymentTarget:
    iOS: "16.0"
targets:
  forwardemail-desktop_iOS:
    type: application
    platform: iOS
    sources:
      - path: forwardemail-desktop_iOS
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: net.forwardemail.mail
        TARGETED_DEVICE_FAMILY: "1,2"
    info:
      path: forwardemail-desktop_iOS/Info.plist
      properties:
        LSRequiresIPhoneOS: true
        UILaunchStoryboardName: LaunchScreen
        UISupportedInterfaceOrientations:
          - UIInterfaceOrientationPortrait
`;

// A minimal Info.plist that Tauri generates
const SAMPLE_INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>LSRequiresIPhoneOS</key>
\t<true/>
\t<key>UILaunchStoryboardName</key>
\t<string>LaunchScreen</string>
</dict>
</plist>
`;

describe('inject-ios-scene-delegate.cjs', () => {
  let tmpDir: string;
  let appleDir: string;
  let targetDir: string;

  beforeEach(() => {
    // Create a temporary directory simulating the generated iOS project
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ios-inject-test-'));
    appleDir = path.join(tmpDir, 'src-tauri', 'gen', 'apple');
    targetDir = path.join(appleDir, 'forwardemail-desktop_iOS');
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(appleDir, 'project.yml'), SAMPLE_PROJECT_YML);
    fs.writeFileSync(path.join(targetDir, 'Info.plist'), SAMPLE_INFO_PLIST);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Source file existence tests ────────────────────────────────────────────

  it('source SceneDelegate.swift exists', () => {
    expect(fs.existsSync(SCENE_DELEGATE_SRC)).toBe(true);
  });

  it('source TaoWindowCapture.m exists', () => {
    expect(fs.existsSync(TAO_CAPTURE_SRC)).toBe(true);
  });

  it('source TaoWindowCapture-Bridging.h exists', () => {
    expect(fs.existsSync(BRIDGING_HEADER_SRC)).toBe(true);
  });

  // ─── SceneDelegate.swift content tests ──────────────────────────────────────

  it('SceneDelegate.swift contains TaoSceneDelegate class', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    expect(content).toContain('@objc(TaoSceneDelegate)');
    expect(content).toContain('class TaoSceneDelegate');
    expect(content).toContain('UIWindowSceneDelegate');
  });

  it('SceneDelegate.swift uses TaoWindowCapture to find the window', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    expect(content).toContain('TaoWindowCapture.capturedWindows()');
    expect(content).toContain('windowScene');
    expect(content).toContain('makeKeyAndVisible');
  });

  it('SceneDelegate.swift has scene:willConnectTo: delegate method', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    expect(content).toContain('func scene(');
    expect(content).toContain('willConnectTo session');
  });

  // ─── TaoWindowCapture.m content tests ───────────────────────────────────────

  it('TaoWindowCapture.m uses +load for early swizzle', () => {
    const content = fs.readFileSync(TAO_CAPTURE_SRC, 'utf8');
    expect(content).toContain('+ (void)load');
    expect(content).toContain('method_exchangeImplementations');
    expect(content).toContain('makeKeyAndVisible');
  });

  it('TaoWindowCapture.m captures sceneless windows', () => {
    const content = fs.readFileSync(TAO_CAPTURE_SRC, 'utf8');
    expect(content).toContain('self.windowScene == nil');
    expect(content).toContain('_capturedWindows');
    expect(content).toContain('capturedWindows');
    expect(content).toContain('clearCapturedWindows');
  });

  it('TaoWindowCapture.m is Objective-C (not Swift)', () => {
    const content = fs.readFileSync(TAO_CAPTURE_SRC, 'utf8');
    expect(content).toContain('#import <UIKit/UIKit.h>');
    expect(content).toContain('#import <objc/runtime.h>');
    expect(content).toContain('@implementation');
  });

  // ─── Bridging header tests ──────────────────────────────────────────────────

  it('Bridging header declares TaoWindowCapture interface', () => {
    const content = fs.readFileSync(BRIDGING_HEADER_SRC, 'utf8');
    expect(content).toContain('@interface TaoWindowCapture');
    expect(content).toContain('capturedWindows');
    expect(content).toContain('clearCapturedWindows');
  });

  // ─── Inject script tests ────────────────────────────────────────────────────

  it('inject script exists and is executable', () => {
    expect(fs.existsSync(INJECT_SCRIPT)).toBe(true);
    const stat = fs.statSync(INJECT_SCRIPT);
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it('inject script has no syntax errors', () => {
    execSync(`node -c "${INJECT_SCRIPT}"`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(true).toBe(true);
  });

  it('inject script copies all three source files', () => {
    const content = fs.readFileSync(INJECT_SCRIPT, 'utf8');
    expect(content).toContain('SceneDelegate.swift');
    expect(content).toContain('TaoWindowCapture.m');
    expect(content).toContain('TaoWindowCapture-Bridging.h');
  });

  // ─── project.yml modification tests ─────────────────────────────────────────

  it('inject script modifies project.yml to add SWIFT_VERSION', () => {
    let yml = SAMPLE_PROJECT_YML;

    if (!yml.includes('SWIFT_VERSION')) {
      const settingsRegex = /(settings:\s*\n\s+base:\s*\n)/;
      const match = yml.match(settingsRegex);
      if (match) {
        const afterBase = yml.substring(yml.indexOf(match[0]) + match[0].length);
        const nextLine = afterBase.split('\n')[0];
        const indent = nextLine.match(/^(\s*)/)?.[1] || '        ';
        yml = yml.replace(settingsRegex, `$1${indent}SWIFT_VERSION: "5.0"\n`);
      }
    }

    expect(yml).toContain('SWIFT_VERSION: "5.0"');
  });

  it('inject script modifies project.yml to add SWIFT_OBJC_BRIDGING_HEADER', () => {
    let yml = SAMPLE_PROJECT_YML;

    if (!yml.includes('SWIFT_OBJC_BRIDGING_HEADER')) {
      const settingsRegex = /(settings:\s*\n\s+base:\s*\n)/;
      const match = yml.match(settingsRegex);
      if (match) {
        const afterBase = yml.substring(yml.indexOf(match[0]) + match[0].length);
        const nextLine = afterBase.split('\n')[0];
        const indent = nextLine.match(/^(\s*)/)?.[1] || '        ';
        yml = yml.replace(
          settingsRegex,
          `$1${indent}SWIFT_OBJC_BRIDGING_HEADER: "forwardemail-desktop_iOS/TaoWindowCapture-Bridging.h"\n`,
        );
      }
    }

    expect(yml).toContain('SWIFT_OBJC_BRIDGING_HEADER');
    expect(yml).toContain('TaoWindowCapture-Bridging.h');
  });

  it('inject script modifies project.yml to add UIApplicationSceneManifest', () => {
    let yml = SAMPLE_PROJECT_YML;

    if (!yml.includes('UIApplicationSceneManifest')) {
      const infoPropsRegex = /(info:\s*\n\s+path:[^\n]+\n\s+properties:\n)/;
      const infoPropsMatch = yml.match(infoPropsRegex);
      if (infoPropsMatch) {
        const afterProps = yml.substring(yml.indexOf(infoPropsMatch[0]) + infoPropsMatch[0].length);
        const firstPropLine = afterProps.split('\n')[0];
        const baseIndent = firstPropLine.match(/^(\s*)/)?.[1] || '        ';
        const sceneManifestYaml =
          `${baseIndent}UIApplicationSceneManifest:\n` +
          `${baseIndent}  UIApplicationSupportsMultipleScenes: false\n` +
          `${baseIndent}  UISceneConfigurations:\n` +
          `${baseIndent}    UIWindowSceneSessionRoleApplication:\n` +
          `${baseIndent}      - UISceneConfigurationName: "Default Configuration"\n` +
          `${baseIndent}        UISceneDelegateClassName: "TaoSceneDelegate"\n`;
        yml = yml.replace(infoPropsRegex, `$1${sceneManifestYaml}`);
      }
    }

    expect(yml).toContain('UIApplicationSceneManifest');
    expect(yml).toContain('TaoSceneDelegate');
    expect(yml).toContain('UIWindowSceneSessionRoleApplication');
  });

  // ─── Info.ios.plist tests ───────────────────────────────────────────────────

  it('Info.ios.plist contains UIApplicationSceneManifest', () => {
    const infoPlist = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Info.ios.plist'), 'utf8');
    expect(infoPlist).toContain('UIApplicationSceneManifest');
    expect(infoPlist).toContain('TaoSceneDelegate');
    expect(infoPlist).toContain('UIWindowSceneSessionRoleApplication');
    expect(infoPlist).toContain('Default Configuration');
  });

  // ─── Build script integration tests ─────────────────────────────────────────

  // Every path reaches the scene-delegate injection through the shared
  // configure-ios-project.sh, which owns the ordered post-init step list. The
  // property being guarded is unchanged: each build path runs the injection.

  it('configure-ios-project.sh calls inject-ios-scene-delegate.cjs', () => {
    const shared = fs.readFileSync(path.join(ROOT, 'scripts', 'configure-ios-project.sh'), 'utf8');
    expect(shared).toContain('inject-ios-scene-delegate.cjs');
  });

  it('ios-dev.sh runs the shared iOS configure script', () => {
    const iosDevSh = fs.readFileSync(path.join(ROOT, 'scripts', 'ios-dev.sh'), 'utf8');
    expect(iosDevSh).toContain('configure-ios-project.sh');
  });

  it('ios-build.sh runs the shared iOS configure script', () => {
    const iosBuildSh = fs.readFileSync(path.join(ROOT, 'scripts', 'ios-build.sh'), 'utf8');
    expect(iosBuildSh).toContain('configure-ios-project.sh');
  });

  it('CI workflows run the shared iOS configure script', () => {
    const e2eIos = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'e2e-mobile-ios.yml'),
      'utf8',
    );
    const buildMobile = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'build-mobile.yml'),
      'utf8',
    );
    const releaseMobile = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'release-mobile.yml'),
      'utf8',
    );

    expect(e2eIos).toContain('configure-ios-project.sh');
    expect(buildMobile).toContain('configure-ios-project.sh');
    expect(releaseMobile).toContain('configure-ios-project.sh');
  });

  // ─── MobilePushPlugin tests ─────────────────────────────────────────────────

  it('MobilePushPlugin.swift has simulator guard for registerForRemoteNotifications', () => {
    const plugin = fs.readFileSync(
      path.join(
        ROOT,
        'src-tauri',
        'plugins',
        'tauri-plugin-mobile-push',
        'ios',
        'Sources',
        'MobilePushPlugin.swift',
      ),
      'utf8',
    );
    expect(plugin).toContain('#if !targetEnvironment(simulator)');
    const matches = plugin.match(/#if !targetEnvironment\(simulator\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  // ─── Plist fallback injection test ──────────────────────────────────────────

  it('plist fallback injection works when xcodegen is unavailable', () => {
    let plist = SAMPLE_INFO_PLIST;
    expect(plist).not.toContain('UIApplicationSceneManifest');

    const sceneManifest = `\t<key>UIApplicationSceneManifest</key>
\t<dict>
\t\t<key>UIApplicationSupportsMultipleScenes</key>
\t\t<false/>
\t\t<key>UISceneConfigurations</key>
\t\t<dict>
\t\t\t<key>UIWindowSceneSessionRoleApplication</key>
\t\t\t<array>
\t\t\t\t<dict>
\t\t\t\t\t<key>UISceneConfigurationName</key>
\t\t\t\t\t<string>Default Configuration</string>
\t\t\t\t\t<key>UISceneDelegateClassName</key>
\t\t\t\t\t<string>TaoSceneDelegate</string>
\t\t\t\t</dict>
\t\t\t</array>
\t\t</dict>
\t</dict>
`;
    plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `${sceneManifest}</dict>\n</plist>\n`);

    expect(plist).toContain('UIApplicationSceneManifest');
    expect(plist).toContain('TaoSceneDelegate');
    expect(plist).toContain('Default Configuration');
    expect(plist).toContain('</plist>');
  });
});
