#!/usr/bin/env node
/**
 * App Store metadata for the generated iOS project.
 *
 * Runs after `tauri ios init` from scripts/configure-ios-project.sh. The
 * generated project under src-tauri/gen/apple is gitignored and rebuilt on
 * every CI run, so the two things App Review needs from the Xcode project are
 * re-applied here instead of committed:
 *
 * 1. PrivacyInfo.xcprivacy. Apple rejects submissions without a privacy
 *    manifest. The tracked copy lives in src-tauri/ and is copied into the
 *    target folder, which project.yml already lists as a source path; xcodegen
 *    files unknown extensions into the Resources build phase, which is where
 *    the manifest has to be.
 *
 * 2. TARGETED_DEVICE_FAMILY. The template leaves it unset, so Xcode's default
 *    made the build universal by accident while the iPad orientation keys
 *    were present. Universal is the deliberate choice (the responsive layout
 *    works on iPad and App Store Connect then requires iPad screenshots), and
 *    it is now stated explicitly so the device family cannot drift.
 *
 * ORDER MATTERS: this must run before inject-ios-scene-delegate.cjs, which
 * invokes xcodegen and regenerates the .xcodeproj from project.yml.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const PRIVACY_MANIFEST_NAME = 'PrivacyInfo.xcprivacy';
// 1 = iPhone, 2 = iPad. Keep in sync with docs/store-submission.md.
const TARGETED_DEVICE_FAMILY = '1,2';

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

function copyPrivacyManifest(targetDir) {
  const source = path.join(root, 'src-tauri', PRIVACY_MANIFEST_NAME);
  if (!fs.existsSync(source)) {
    throw new Error(
      `Missing ${source}; the App Store privacy manifest must be tracked in src-tauri/`,
    );
  }
  const destination = path.join(targetDir, PRIVACY_MANIFEST_NAME);
  const content = fs.readFileSync(source, 'utf8');
  if (fs.existsSync(destination) && fs.readFileSync(destination, 'utf8') === content) return false;
  fs.writeFileSync(destination, content);
  console.log(`Copied ${PRIVACY_MANIFEST_NAME} into ${path.relative(root, targetDir)}`);
  return true;
}

function setDeviceFamily(appleDir) {
  const projectYmlPath = path.join(appleDir, 'project.yml');
  if (!fs.existsSync(projectYmlPath)) return false;

  let yml = fs.readFileSync(projectYmlPath, 'utf8');
  if (/^\s*TARGETED_DEVICE_FAMILY:/m.test(yml)) return false;

  // The iOS target's settings.base block is the one that carries
  // SWIFT_VERSION in the Tauri template. Insert directly after that line so
  // the key inherits the same indentation.
  const anchor = /^(\s*)SWIFT_VERSION:[^\n]*\n/m;
  const match = yml.match(anchor);
  if (!match) {
    console.warn('Could not find settings.base in project.yml; TARGETED_DEVICE_FAMILY not set');
    return false;
  }
  yml = yml.replace(
    anchor,
    `${match[0]}${match[1]}TARGETED_DEVICE_FAMILY: "${TARGETED_DEVICE_FAMILY}"\n`,
  );
  fs.writeFileSync(projectYmlPath, yml);
  console.log(`Set TARGETED_DEVICE_FAMILY=${TARGETED_DEVICE_FAMILY} in project.yml`);
  return true;
}

function configureIos() {
  const appleDir = path.join(root, 'src-tauri', 'gen', 'apple');
  if (!fs.existsSync(appleDir)) return false;

  const targetDir = findIosTargetDir(appleDir);
  const manifest = targetDir ? copyPrivacyManifest(targetDir) : false;
  const family = setDeviceFamily(appleDir);
  return manifest || family;
}

if (require.main === module) {
  if (!configureIos()) {
    console.log('iOS store metadata already configured');
  }
}

module.exports = { PRIVACY_MANIFEST_NAME, TARGETED_DEVICE_FAMILY, configureIos };
