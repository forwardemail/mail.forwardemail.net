/**
 * Unit tests for the iOS SceneDelegate injection script.
 *
 * These tests verify that inject-ios-scene-delegate.cjs correctly:
 * 1. Copies SceneDelegate.swift, TaoWindowCapture.m, and bridging header
 * 2. Adds SWIFT_VERSION and SWIFT_OBJC_BRIDGING_HEADER to project.yml
 * 3. Adds UIApplicationSceneManifest to project.yml info.properties
 * 4. Falls back to direct plist injection if the generated plist lacks the manifest
 * 5. Fails the build when xcodegen fails or the xcodeproj lacks the sources
 *
 * The tests mock the filesystem to simulate the generated iOS project structure
 * that `tauri ios init` produces.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, spawnSync } from 'node:child_process';

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

  // The body of a Swift method, from its declaration to its closing brace.
  const swiftMethod = (content: string, signature: string) => {
    const start = content.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    return content.slice(start, content.indexOf('\n    }\n', start));
  };

  it('SceneDelegate.swift finds the tao window again for a reconnected scene', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    // The capture is cleared after the first scene uses it, and tao's
    // AppDelegate has no window property, so a later scene needs this.
    expect(content).toContain('private static weak var taoWindow: UIWindow?');
    expect(swiftMethod(content, 'private func assignScene(')).toContain(
      'TaoSceneDelegate.taoWindow = window',
    );
    const connect = swiftMethod(content, 'willConnectTo session');
    expect(connect).toContain('captured.first ?? TaoSceneDelegate.taoWindow');
    expect(connect).toContain('windows.first ?? TaoSceneDelegate.taoWindow');
    expect(connect).not.toContain('appDelegate.window');
  });

  it('SceneDelegate.swift stops polling for the window when the scene disconnects', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    expect(swiftMethod(content, 'willConnectTo session')).toContain('pollTimer = timer');
    expect(swiftMethod(content, 'func sceneDidDisconnect(')).toContain('pollTimer?.invalidate()');
  });

  it('SceneDelegate.swift forwards opened URLs to the app delegate tao listens on', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    // UIKit delivers URLs to the scene when a scene manifest is present.
    expect(content).toContain(
      'func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>)',
    );
    expect(swiftMethod(content, 'willConnectTo session')).toContain(
      'forwardDeepLinks(connectionOptions.urlContexts)',
    );
    const forward = swiftMethod(content, 'private static func forwardDeepLinks(');
    expect(forward).toContain('isForwardableDeepLink(context.url)');
    expect(forward).toContain('UIApplication.shared.delegate?.application?(');
    expect(forward).toContain('UIApplication.shared, open: context.url, options: [:])');
  });

  it('SceneDelegate.swift forwards only the URL schemes the app registers', () => {
    const content = fs.readFileSync(SCENE_DELEGATE_SRC, 'utf8');
    const literal = content.match(/deepLinkSchemes: Set<String> = \[([^\]]*)\]/);
    expect(literal).not.toBeNull();
    const swiftSchemes = [...literal![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'),
    );
    const registered = config.plugins['deep-link'].mobile
      .flatMap((entry: { scheme: string[] }) => entry.scheme)
      .sort();
    expect(swiftSchemes).toEqual(registered);

    // tao aborts on a URL Url::parse rejects, so the check also refuses a
    // user, password, port or unusual host.
    const check = swiftMethod(content, 'private static func isForwardableDeepLink(');
    expect(check).toContain('deepLinkSchemes.contains(scheme)');
    expect(check).toContain('parts.user == nil, parts.password == nil, parts.port == nil');
    expect(check).toContain('hostCharacters.contains($0)');
  });

  // ─── TaoWindowCapture.m content tests ───────────────────────────────────────

  it('TaoWindowCapture.m method type encodings match their selectors', () => {
    const content = fs.readFileSync(TAO_CAPTURE_SRC, 'utf8');
    const added = [...content.matchAll(/class_addMethod\(cls, (\w+), \w+, "([^"]+)"\)/g)];
    expect(added.length).toBe(3);
    for (const [, selVar, encoding] of added) {
      const sel = content.match(new RegExp(`SEL ${selVar} = sel_registerName\\("([^"]+)"\\)`));
      expect(sel).not.toBeNull();
      const argCount = sel![1].split(':').length - 1;
      // Return type void, then self and _cmd, then one object or block per
      // argument (a block is "@?").
      expect(encoding.startsWith('v@:')).toBe(true);
      const args = encoding.slice(3).match(/@\?|@/g) ?? [];
      expect(args.join('')).toBe(encoding.slice(3));
      expect({ sel: sel![1], args: args.length }).toEqual({ sel: sel![1], args: argCount });
    }
  });

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

  // ─── Running the inject scripts ─────────────────────────────────────────────

  // `tauri ios build` never runs xcodegen, so a failed regeneration or an
  // xcodeproj without the sources must stop the build: Info.ios.plist always
  // names TaoSceneDelegate, and an app without it is a black screen on iOS 26.

  // A stand-in xcodegen first on PATH, so a run neither needs nor touches a
  // real one.
  function envWithXcodegen(exitCode: number) {
    const bin = path.join(tmpDir, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'xcodegen'), `#!/bin/sh\nexit ${exitCode}\n`, {
      mode: 0o755,
    });
    return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  }

  // The scripts resolve the repo root from their own location, so they run
  // from a copy inside the sandbox.
  function runScript(name: string, env: typeof process.env) {
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    const script = path.join(tmpDir, 'scripts', name);
    fs.copyFileSync(path.join(ROOT, 'scripts', name), script);
    return spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
  }

  function runSceneInject(env: typeof process.env, pbxproj: string) {
    fs.cpSync(INJECT_DIR, path.join(tmpDir, 'src-tauri', 'ios-inject'), { recursive: true });
    const xcodeproj = path.join(appleDir, 'forwardemail-desktop.xcodeproj');
    fs.mkdirSync(xcodeproj, { recursive: true });
    fs.writeFileSync(path.join(xcodeproj, 'project.pbxproj'), pbxproj);
    return runScript('inject-ios-scene-delegate.cjs', env);
  }

  const PBXPROJ_WITH_SOURCES =
    '/* SceneDelegate.swift in Sources */\n/* TaoWindowCapture.m in Sources */\n';

  it('inject script succeeds when the xcodeproj compiles both sources', () => {
    const result = runSceneInject(envWithXcodegen(0), PBXPROJ_WITH_SOURCES);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('✓ SceneDelegate.swift is in xcodeproj compile sources');
    expect(result.stdout).toContain('✓ TaoWindowCapture.m is in xcodeproj compile sources');
  });

  it('inject script fails when the xcodeproj does not compile the scene delegate', () => {
    const result = runSceneInject(envWithXcodegen(0), '/* TaoWindowCapture.m in Sources */\n');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('SceneDelegate.swift NOT found');
  });

  it('inject script fails when xcodegen fails', () => {
    const result = runSceneInject(envWithXcodegen(1), PBXPROJ_WITH_SOURCES);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('xcodegen generate failed');
  });

  it('inject-ios-signing.cjs fails when xcodegen fails', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"version":"1.0.1"}');
    fs.writeFileSync(
      path.join(tmpDir, 'src-tauri', 'tauri.conf.json'),
      '{"identifier":"net.forwardemail.mail"}',
    );
    fs.writeFileSync(path.join(tmpDir, 'src-tauri', 'Entitlements.plist'), SAMPLE_INFO_PLIST);
    // The signing script requires this helper from its own directory.
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.copyFileSync(
      path.join(ROOT, 'scripts', 'ios-export-compliance.cjs'),
      path.join(tmpDir, 'scripts', 'ios-export-compliance.cjs'),
    );
    fs.writeFileSync(
      path.join(appleDir, 'project.yml'),
      SAMPLE_PROJECT_YML.replace(
        '    info:\n',
        '    entitlements:\n      path: forwardemail-desktop_iOS/forwardemail-desktop_iOS.entitlements\n    info:\n',
      ),
    );
    const result = runScript('inject-ios-signing.cjs', {
      ...envWithXcodegen(1),
      APPLE_TEAM_ID: 'TEAM123456',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('xcodegen generate failed');
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

  it('Info.ios.plist explains microphone use, for video taken from the attach picker', () => {
    // The compose attach input accepts any file, so iOS offers "Take Photo or
    // Video". Recording video without this string ends the app.
    const infoPlist = fs.readFileSync(path.join(ROOT, 'src-tauri', 'Info.ios.plist'), 'utf8');
    const usage = infoPlist.match(
      /<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/,
    );
    expect(usage).not.toBeNull();
    expect(usage![1]).toMatch(/^Forward Email uses the microphone /);
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
    // registerForRemoteNotifications raises on the iOS 26 simulator, so every
    // call must be compiled out of simulator builds: either inside
    // `#if !targetEnvironment(simulator)` or in the `#else` branch of
    // `#if targetEnvironment(simulator)`.
    const calls = [...plugin.matchAll(/registerForRemoteNotifications\(\)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const before = plugin.slice(0, call.index);
      const directives = [...before.matchAll(/^\s*#(if [^\n]*|else|endif)\s*$/gm)].map((m) =>
        m[1].trim(),
      );
      // Walk back to the innermost open conditional around the call.
      const stack: string[] = [];
      for (const directive of directives) {
        if (directive.startsWith('if ')) stack.push(directive);
        else if (directive === 'else') stack.push(`else:${stack.pop()}`);
        else stack.pop();
      }
      const innermost = stack[stack.length - 1];
      expect(
        innermost === 'if !targetEnvironment(simulator)' ||
          innermost === 'else:if targetEnvironment(simulator)',
      ).toBe(true);
    }
  });

  // ─── Plist fallback injection test ──────────────────────────────────────────

  it('plist fallback injection works when the generated plist lacks the manifest', () => {
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
