#!/usr/bin/env node
/**
 * Inject iOS signing settings + write ExportOptions.plist.
 *
 * Called in CI after `tauri ios init` regenerates src-tauri/gen/apple/.
 * Reads team id, profile name, and export method from environment variables
 * so local unsigned dev builds continue to work unchanged.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));

const teamId = process.env.APPLE_TEAM_ID || conf.bundle?.iOS?.developmentTeam;
const method = process.env.IOS_EXPORT_METHOD || 'release-testing';
const signingIdentity = process.env.IOS_SIGNING_IDENTITY || 'Apple Distribution';
const profileName = process.env.IOS_PROFILE_NAME || '';
const bundleId = conf.identifier;

if (!teamId) {
  console.error('APPLE_TEAM_ID env var or tauri.conf.json bundle.iOS.developmentTeam is required');
  process.exit(1);
}

const appleDir = path.join(root, 'src-tauri', 'gen', 'apple');
if (!fs.existsSync(appleDir)) {
  console.error(`${appleDir} not found — run \`tauri ios init\` first`);
  process.exit(1);
}

// Generate an iOS-only entitlement file inside the generated Apple project.
// The committed Entitlements.plist is shared with macOS and must never contain
// aps-environment because Developer ID macOS profiles are not APNs-authorized.
const baseEntitlementsPath = path.join(root, 'src-tauri', 'Entitlements.plist');
const iosEntitlementsName = 'ForwardEmail-iOS.entitlements';
const iosEntitlementsPath = path.join(appleDir, iosEntitlementsName);
const exportMethod = method.toLowerCase();
const forceProduction = process.env.APNS_PRODUCTION === 'true';
const isProduction =
  forceProduction ||
  exportMethod === 'app-store-connect' ||
  exportMethod === 'release-testing' ||
  exportMethod === 'app-store' ||
  exportMethod === 'ad-hoc' ||
  exportMethod === 'enterprise';
const apsEnvironment = isProduction ? 'production' : 'development';

if (!fs.existsSync(baseEntitlementsPath)) {
  console.error(`${baseEntitlementsPath} not found — cannot generate iOS entitlements`);
  process.exit(1);
}

let iosEntitlements = fs.readFileSync(baseEntitlementsPath, 'utf8');
const apsBlock = `  <key>aps-environment</key>\n  <string>${apsEnvironment}</string>\n`;
if (/<key>aps-environment<\/key>/.test(iosEntitlements)) {
  iosEntitlements = iosEntitlements.replace(
    /<key>aps-environment<\/key>\s*<string>[^<]*<\/string>\n?/,
    apsBlock,
  );
} else {
  iosEntitlements = iosEntitlements.replace(/<\/dict>(\s*<\/plist>\s*)$/m, `${apsBlock}</dict>$1`);
}
fs.writeFileSync(iosEntitlementsPath, iosEntitlements);
console.log(`Generated ${iosEntitlementsName} with aps-environment="${apsEnvironment}"`);

// ── 1. Patch project.yml (deployment target + signing settings) ─────────
const projectYmlPath = path.join(appleDir, 'project.yml');
let projYml = fs.readFileSync(projectYmlPath, 'utf8');
let modified = false;

// Xcode 26's iOS 26.4 SDK no longer ships libswiftCompatibility56.a
// (the Swift 5.6 back-deploy shim auto-linked when the deployment
// target is < iOS 15.4, where Swift 5.6 first shipped in the OS).
// 16.0 gives a clean margin above that threshold.
const bumpedYml = projYml.replace(/(\n {2}deploymentTarget:\n {4}iOS: )[\d.]+/, '$116.0');
if (bumpedYml !== projYml) {
  projYml = bumpedYml;
  modified = true;
  console.log('Bumped iOS deployment target to 16.0 in project.yml');
} else if (!/deploymentTarget:\n {4}iOS: 16\.0/.test(projYml)) {
  console.warn('Could not find options.deploymentTarget.iOS in project.yml');
}

if (!projYml.includes('CODE_SIGN_STYLE')) {
  const signingLines = [
    `        CODE_SIGN_STYLE: Manual`,
    `        DEVELOPMENT_TEAM: ${teamId}`,
    `        CODE_SIGN_IDENTITY: "${signingIdentity}"`,
    `        CODE_SIGN_ENTITLEMENTS: "${iosEntitlementsName}"`,
  ];
  if (profileName) {
    signingLines.push(`        PROVISIONING_PROFILE_SPECIFIER: "${profileName}"`);
  }

  // Insert at the top of the iOS target's `settings.base:` block.
  // xcodegen uses 4-space indents for targets and 6-space for settings.
  const replaced = projYml.replace(
    / {4}settings:\n {6}base:\n/,
    (match) => `${match}${signingLines.join('\n')}\n`,
  );
  if (replaced === projYml) {
    console.error('Could not find iOS target settings.base in project.yml');
    process.exit(1);
  }
  projYml = replaced;
  modified = true;
  console.log('Injected signing settings into project.yml');
} else {
  console.log('Signing settings already present in project.yml — updating entitlements only');
}

const entitlementsSetting = `        CODE_SIGN_ENTITLEMENTS: "${iosEntitlementsName}"`;
if (/^\s*CODE_SIGN_ENTITLEMENTS:/m.test(projYml)) {
  const updatedYml = projYml.replace(/^\s*CODE_SIGN_ENTITLEMENTS:.*$/m, entitlementsSetting);
  if (updatedYml !== projYml) {
    projYml = updatedYml;
    modified = true;
  }
} else if (projYml.includes('CODE_SIGN_STYLE')) {
  projYml = projYml.replace(/(^\s*CODE_SIGN_STYLE:.*$)/m, `$1\n${entitlementsSetting}`);
  modified = true;
}

if (modified) {
  fs.writeFileSync(projectYmlPath, projYml);
  // Re-run xcodegen so the generated .xcodeproj picks up the new settings.
  try {
    execSync('xcodegen generate', { cwd: appleDir, stdio: 'inherit' });
  } catch {
    console.warn('xcodegen not available — tauri will regenerate xcodeproj on build');
  }
}

// ── 2. Write ExportOptions.plist ─────────────────────────────────────────
const profileMapping = profileName
  ? `
    <key>provisioningProfiles</key>
    <dict>
        <key>${bundleId}</key>
        <string>${profileName}</string>
    </dict>`
  : '';

const exportOptions = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>method</key>
    <string>${method}</string>
    <key>teamID</key>
    <string>${teamId}</string>
    <key>signingStyle</key>
    <string>manual</string>
    <key>signingCertificate</key>
    <string>${signingIdentity}</string>
    <key>stripSwiftSymbols</key>
    <true/>
    <key>compileBitcode</key>
    <false/>${profileMapping}
</dict>
</plist>
`;
fs.writeFileSync(path.join(appleDir, 'ExportOptions.plist'), exportOptions);
console.log(
  `Wrote ExportOptions.plist (method=${method}, team=${teamId}, identity=${signingIdentity})`,
);

// ── 3. Sync Info.plist version + monotonic build number ──────────────────
const infoPlistPath = path.join(appleDir, 'forwardemail-desktop_iOS', 'Info.plist');
if (fs.existsSync(infoPlistPath)) {
  const [major, minor, patch] = pkg.version.split('.').map(Number);
  // App Store Connect requires CFBundleVersion to be a monotonically
  // increasing integer. Derive from semver the same way Android does.
  const buildNumber = major * 10000 + minor * 100 + patch;
  try {
    execSync(
      `plutil -replace CFBundleShortVersionString -string "${pkg.version}" "${infoPlistPath}"`,
    );
    execSync(`plutil -replace CFBundleVersion -string "${buildNumber}" "${infoPlistPath}"`);
    console.log(
      `Synced Info.plist: CFBundleShortVersionString=${pkg.version}, CFBundleVersion=${buildNumber}`,
    );
  } catch {
    let plist = fs.readFileSync(infoPlistPath, 'utf8');
    plist = plist.replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${pkg.version}$2`,
    );
    plist = plist.replace(
      /(<key>CFBundleVersion<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${buildNumber}$2`,
    );
    fs.writeFileSync(infoPlistPath, plist);
    console.log(`Synced Info.plist via regex fallback (versionCode=${buildNumber})`);
  }
}

// ── 3b. Inject App Store compliance keys into Info.plist ─────────────────────
// ITSAppUsesNonExemptEncryption=false: the app uses only standard/exempt crypto
// (TLS + user-held PGP keys via libsodium/openpgp), qualifying for the
// mass-market exemption (US EAR §740.17(b)(1)). Declaring it avoids the
// per-build "Missing Compliance" stall in App Store Connect.
// NSPhotoLibraryUsageDescription is required because the app presents an image
// picker for attachments / avatars (<input type="file" accept="image/*">).
if (fs.existsSync(infoPlistPath)) {
  const photoUsage =
    'Forward Email needs access to your photos so you can attach images to emails and set a profile picture.';
  try {
    execSync(`plutil -replace ITSAppUsesNonExemptEncryption -bool false "${infoPlistPath}"`);
    execSync(
      `plutil -replace NSPhotoLibraryUsageDescription -string "${photoUsage}" "${infoPlistPath}"`,
    );
    console.log('Injected ITSAppUsesNonExemptEncryption=false + NSPhotoLibraryUsageDescription');
  } catch {
    // Regex fallback (no plutil): insert each key before the final </dict>
    // only if it isn't already present.
    let plist = fs.readFileSync(infoPlistPath, 'utf8');
    if (!/<key>ITSAppUsesNonExemptEncryption<\/key>/.test(plist)) {
      plist = plist.replace(
        /<\/dict>(\s*<\/plist>\s*)$/m,
        `  <key>ITSAppUsesNonExemptEncryption</key>\n  <false/>\n</dict>$1`,
      );
    }
    if (!/<key>NSPhotoLibraryUsageDescription<\/key>/.test(plist)) {
      plist = plist.replace(
        /<\/dict>(\s*<\/plist>\s*)$/m,
        `  <key>NSPhotoLibraryUsageDescription</key>\n  <string>${photoUsage}</string>\n</dict>$1`,
      );
    }
    fs.writeFileSync(infoPlistPath, plist);
    console.log('Injected compliance keys via regex fallback');
  }
}

// APNs authorization is now isolated to ForwardEmail-iOS.entitlements in the
// generated Apple project; the shared macOS entitlement file remains unchanged.
