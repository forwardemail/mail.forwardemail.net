#!/usr/bin/env node
/**
 * Inject SceneDelegate + TaoWindowCapture into the generated iOS Xcode project.
 *
 * Called after `tauri ios init` in ios-dev.sh and ios-build.sh.
 *
 * This script:
 * 1. Copies SceneDelegate.swift, TaoWindowCapture.m, and the bridging header
 *    into the generated iOS target source directory.
 * 2. Adds SWIFT_VERSION, SWIFT_OBJC_BRIDGING_HEADER, and
 *    UIApplicationSceneManifest to project.yml so that xcodegen generates
 *    the xcodeproj AND plist correctly.
 * 3. Re-runs xcodegen to regenerate the .xcodeproj with the new source files
 *    and the scene manifest baked into the generated Info.plist.
 * 4. As a safety net, verifies the generated Info.plist contains the
 *    UIApplicationSceneManifest — if not, injects it directly.
 *
 * IMPORTANT: The scene manifest MUST be in project.yml BEFORE xcodegen runs,
 * because xcodegen regenerates plists from project.yml and would overwrite
 * any direct plist edits made before it runs.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const appleDir = path.join(root, 'src-tauri', 'gen', 'apple');

if (!fs.existsSync(appleDir)) {
  console.error(`${appleDir} not found — run \`tauri ios init\` first`);
  process.exit(1);
}

// Find the iOS target directory
let targetDir = path.join(appleDir, 'forwardemail-desktop_iOS');
let targetDirName = 'forwardemail-desktop_iOS';
if (!fs.existsSync(targetDir)) {
  const entries = fs.readdirSync(appleDir).filter((e) => {
    return e.endsWith('_iOS') && fs.statSync(path.join(appleDir, e)).isDirectory();
  });
  if (entries.length === 0) {
    console.error(`No *_iOS target directory found in ${appleDir}`);
    process.exit(1);
  }
  targetDir = path.join(appleDir, entries[0]);
  targetDirName = entries[0];
  console.log(`Using target directory: ${entries[0]}`);
}

// ─── Step 1: Copy source files ──────────────────────────────────────────────
const injectDir = path.join(root, 'src-tauri', 'ios-inject');
const filesToCopy = ['SceneDelegate.swift', 'TaoWindowCapture.m', 'TaoWindowCapture-Bridging.h'];

for (const file of filesToCopy) {
  const src = path.join(injectDir, file);
  if (!fs.existsSync(src)) {
    console.error(`${src} not found`);
    process.exit(1);
  }
  const dest = path.join(targetDir, file);
  fs.copyFileSync(src, dest);
  console.log(`Copied ${file} → ${path.relative(root, dest)}`);
}

// ─── Step 2: Modify project.yml ─────────────────────────────────────────────
// Add SWIFT_VERSION, SWIFT_OBJC_BRIDGING_HEADER, and UIApplicationSceneManifest
const projectYmlPath = path.join(appleDir, 'project.yml');
if (fs.existsSync(projectYmlPath)) {
  let yml = fs.readFileSync(projectYmlPath, 'utf8');
  let modified = false;

  // Add SWIFT_VERSION if not present
  if (!yml.includes('SWIFT_VERSION')) {
    const settingsRegex = /(settings:\s*\n\s+base:\s*\n)/;
    const match = yml.match(settingsRegex);
    if (match) {
      const afterBase = yml.substring(yml.indexOf(match[0]) + match[0].length);
      const nextLine = afterBase.split('\n')[0];
      const indent = nextLine.match(/^(\s*)/)[1];
      yml = yml.replace(settingsRegex, `$1${indent}SWIFT_VERSION: "5.0"\n`);
      modified = true;
      console.log('Added SWIFT_VERSION=5.0 to project.yml');
    }
  }

  // Add SWIFT_OBJC_BRIDGING_HEADER if not present
  if (!yml.includes('SWIFT_OBJC_BRIDGING_HEADER')) {
    const settingsRegex = /(settings:\s*\n\s+base:\s*\n)/;
    const match = yml.match(settingsRegex);
    if (match) {
      const afterBase = yml.substring(yml.indexOf(match[0]) + match[0].length);
      const nextLine = afterBase.split('\n')[0];
      const indent = nextLine.match(/^(\s*)/)[1];
      // The bridging header path is relative to the project root (appleDir)
      const bridgingHeaderPath = `${targetDirName}/TaoWindowCapture-Bridging.h`;
      yml = yml.replace(
        settingsRegex,
        `$1${indent}SWIFT_OBJC_BRIDGING_HEADER: "${bridgingHeaderPath}"\n`,
      );
      modified = true;
      console.log(`Added SWIFT_OBJC_BRIDGING_HEADER=${bridgingHeaderPath} to project.yml`);
    }
  }

  // Add UIApplicationSceneManifest to the target's info.plist properties
  if (!yml.includes('UIApplicationSceneManifest')) {
    const infoPropsRegex = /(info:\s*\n\s+path:[^\n]+\n\s+properties:\n)/;
    const infoPropsMatch = yml.match(infoPropsRegex);

    if (infoPropsMatch) {
      const afterProps = yml.substring(yml.indexOf(infoPropsMatch[0]) + infoPropsMatch[0].length);
      const firstPropLine = afterProps.split('\n')[0];
      const baseIndent = firstPropLine.match(/^(\s*)/)[1];

      const sceneManifestYaml =
        `${baseIndent}UIApplicationSceneManifest:\n` +
        `${baseIndent}  UIApplicationSupportsMultipleScenes: false\n` +
        `${baseIndent}  UISceneConfigurations:\n` +
        `${baseIndent}    UIWindowSceneSessionRoleApplication:\n` +
        `${baseIndent}      - UISceneConfigurationName: "Default Configuration"\n` +
        `${baseIndent}        UISceneDelegateClassName: "TaoSceneDelegate"\n`;

      yml = yml.replace(infoPropsRegex, `$1${sceneManifestYaml}`);
      modified = true;
      console.log('Added UIApplicationSceneManifest to project.yml info.properties');
    } else {
      console.warn(
        'Could not find info.properties section in project.yml — will inject into plist directly',
      );
    }
  }

  if (modified) {
    fs.writeFileSync(projectYmlPath, yml);
  }
}

// ─── Step 3: Re-run xcodegen ────────────────────────────────────────────────
try {
  execSync('xcodegen generate', { cwd: appleDir, stdio: 'inherit' });
  console.log('Regenerated xcodeproj with SceneDelegate + TaoWindowCapture');
} catch {
  console.warn('xcodegen not available — tauri will regenerate xcodeproj on build');
}

// ─── Step 4: Safety net — verify plist has the manifest ─────────────────────
const infoPlistPath = path.join(targetDir, 'Info.plist');
if (fs.existsSync(infoPlistPath)) {
  let plist = fs.readFileSync(infoPlistPath, 'utf8');
  if (!plist.includes('UIApplicationSceneManifest')) {
    console.warn(
      'UIApplicationSceneManifest NOT found in generated plist after xcodegen — injecting directly',
    );
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
    fs.writeFileSync(infoPlistPath, plist);
    console.log('Injected UIApplicationSceneManifest into Info.plist (fallback)');
  } else {
    console.log('✓ UIApplicationSceneManifest present in generated Info.plist');
  }
} else {
  console.warn(`Info.plist not found at ${infoPlistPath}`);
}

// ─── Step 5: Final verification ─────────────────────────────────────────────
const xcodeprojDir = fs.readdirSync(appleDir).find((f) => f.endsWith('.xcodeproj'));
if (xcodeprojDir) {
  const pbxprojPath = path.join(appleDir, xcodeprojDir, 'project.pbxproj');
  if (fs.existsSync(pbxprojPath)) {
    const pbx = fs.readFileSync(pbxprojPath, 'utf8');
    const checks = [
      ['SceneDelegate.swift', 'SceneDelegate.swift'],
      ['TaoWindowCapture.m', 'TaoWindowCapture.m'],
    ];
    for (const [name, search] of checks) {
      if (pbx.includes(search)) {
        console.log(`✓ ${name} is in xcodeproj compile sources`);
      } else {
        console.error(`⚠️  ${name} NOT found in xcodeproj — it may not be compiled!`);
      }
    }
  }
}
