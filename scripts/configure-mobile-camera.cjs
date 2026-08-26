#!/usr/bin/env node
/**
 * Grant camera access to the generated mobile projects, for QR device pairing.
 *
 * Called after `tauri android init` / `tauri ios init` from the dev and build
 * scripts. src-tauri/gen/ is gitignored and regenerated, so every permission
 * has to be re-applied here rather than committed. Idempotent.
 *
 * Android: wry's RustWebChromeClient.onPermissionRequest already requests
 * runtime CAMERA and grants VIDEO_CAPTURE to the webview, but it can only
 * request a permission the manifest declares. The <uses-feature> is marked
 * not-required so camera-less devices are not excluded from the Play listing -
 * pairing is one feature, not the whole app.
 *
 * iOS: WKWebView grants media capture through wry's WKUIDelegate, but UIKit
 * kills the process on first camera access if NSCameraUsageDescription is
 * absent. That is a crash, not a denial, so this is load-bearing.
 *
 * ORDER MATTERS ON iOS: xcodegen regenerates Info.plist from project.yml, so
 * this must run BEFORE inject-ios-scene-delegate.cjs (which invokes xcodegen).
 * The plist is also patched directly as a fallback for when xcodegen is not
 * installed.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const CAMERA_USAGE_DESCRIPTION =
  'Forward Email uses the camera to scan a pairing code shown by another device.';

/**
 * Every iOS privacy usage description the app declares, injected per-key so a
 * project that already carries one of them still gains the others.
 *
 * NSLocalNetworkUsageDescription exists for `tauri ios dev` on a physical
 * device, where the app connects to the dev server over the LAN and iOS 14+
 * gates that behind the Local Network permission. A production build never
 * opens a local-network connection, so the key sits unused there and the
 * prompt never appears; declaring it unconditionally is harmless and keeps
 * one pipeline instead of a dev-only fork.
 */
const IOS_USAGE_DESCRIPTIONS = [
  { key: 'NSCameraUsageDescription', text: CAMERA_USAGE_DESCRIPTION },
  {
    key: 'NSLocalNetworkUsageDescription',
    text: 'Forward Email connects to your development server over the local network during development.',
  },
];

const ANDROID_PERMISSIONS = ['android.permission.CAMERA'];
const ANDROID_FEATURES = [{ name: 'android.hardware.camera', required: false }];

function writeIfChanged(file, value) {
  if (fs.readFileSync(file, 'utf8') !== value) {
    fs.writeFileSync(file, value);
    return true;
  }
  return false;
}

function configureAndroid() {
  const manifestPath = path.join(
    root,
    'src-tauri',
    'gen',
    'android',
    'app',
    'src',
    'main',
    'AndroidManifest.xml',
  );
  if (!fs.existsSync(manifestPath)) return false;

  let manifest = fs.readFileSync(manifestPath, 'utf8');

  const missingPermissions = ANDROID_PERMISSIONS.filter(
    (permission) => !manifest.includes(`android:name="${permission}"`),
  );
  const missingFeatures = ANDROID_FEATURES.filter(
    (feature) => !manifest.includes(`android:name="${feature.name}"`),
  );

  if (missingPermissions.length === 0 && missingFeatures.length === 0) return false;

  const declarations = [
    ...missingPermissions.map(
      (permission) => `    <uses-permission android:name="${permission}" />`,
    ),
    ...missingFeatures.map(
      (feature) =>
        `    <uses-feature android:name="${feature.name}" android:required="${feature.required}" />`,
    ),
  ].join('\n');

  manifest = manifest.replace(/\s*<application/, `\n${declarations}\n\n    <application`);

  const changed = writeIfChanged(manifestPath, manifest);
  if (changed) console.log('Added camera permission to AndroidManifest.xml');
  return changed;
}

function findIosTargetDir(appleDir) {
  const preferred = path.join(appleDir, 'forwardemail-desktop_iOS');
  if (fs.existsSync(preferred)) return preferred;

  const entries = fs
    .readdirSync(appleDir)
    .filter(
      (entry) => entry.endsWith('_iOS') && fs.statSync(path.join(appleDir, entry)).isDirectory(),
    );
  return entries.length > 0 ? path.join(appleDir, entries[0]) : null;
}

function configureIosProjectYml(appleDir) {
  const projectYmlPath = path.join(appleDir, 'project.yml');
  if (!fs.existsSync(projectYmlPath)) return false;

  let yml = fs.readFileSync(projectYmlPath, 'utf8');
  // Checked PER KEY, not with one early return: a project regenerated after a
  // previous run already carries the earlier keys, and skipping the whole
  // block would silently drop any newly added description forever.
  const missing = IOS_USAGE_DESCRIPTIONS.filter(({ key }) => !yml.includes(key));
  if (missing.length === 0) return false;

  const infoPropsRegex = /(info:\s*\n\s+path:[^\n]+\n\s+properties:\n)/;
  const match = yml.match(infoPropsRegex);
  if (!match) {
    console.warn(
      'Could not find info.properties in project.yml; relying on the direct Info.plist patch',
    );
    return false;
  }

  // Match the indentation of whatever property already sits in the block.
  const afterProps = yml.substring(yml.indexOf(match[0]) + match[0].length);
  const baseIndent = (afterProps.split('\n')[0].match(/^(\s*)/) || ['', '    '])[1];

  const lines = missing.map(({ key, text }) => `${baseIndent}${key}: "${text}"\n`).join('');
  yml = yml.replace(infoPropsRegex, `$1${lines}`);

  fs.writeFileSync(projectYmlPath, yml);
  console.log(`Added ${missing.map(({ key }) => key).join(', ')} to project.yml info.properties`);
  return true;
}

function configureIosPlist(targetDir) {
  const plistPath = path.join(targetDir, 'Info.plist');
  if (!fs.existsSync(plistPath)) return false;

  let plist = fs.readFileSync(plistPath, 'utf8');
  const missing = IOS_USAGE_DESCRIPTIONS.filter(({ key }) => !plist.includes(key));
  if (missing.length === 0) return false;

  if (!/<\/dict>\s*<\/plist>\s*$/.test(plist)) {
    console.warn('Info.plist has an unexpected shape; skipping the direct patch');
    return false;
  }

  const entries = missing
    .map(({ key, text }) => `\t<key>${key}</key>\n\t<string>${text}</string>\n`)
    .join('');
  plist = plist.replace(/<\/dict>\s*<\/plist>\s*$/, `${entries}</dict>\n</plist>\n`);
  fs.writeFileSync(plistPath, plist);
  console.log(`Added ${missing.map(({ key }) => key).join(', ')} to Info.plist`);
  return true;
}

function configureIos() {
  const appleDir = path.join(root, 'src-tauri', 'gen', 'apple');
  if (!fs.existsSync(appleDir)) return false;

  const targetDir = findIosTargetDir(appleDir);
  const yml = configureIosProjectYml(appleDir);
  const plist = targetDir ? configureIosPlist(targetDir) : false;
  return yml || plist;
}

const touchedAndroid = configureAndroid();
const touchedIos = configureIos();

if (!touchedAndroid && !touchedIos) {
  console.log('Camera permissions already configured');
}

module.exports = { CAMERA_USAGE_DESCRIPTION, IOS_USAGE_DESCRIPTIONS };
