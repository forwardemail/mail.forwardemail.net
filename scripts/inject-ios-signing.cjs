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

// ── 1. Inject signing settings into project.yml ──────────────────────────
const projectYmlPath = path.join(appleDir, 'project.yml');
let projYml = fs.readFileSync(projectYmlPath, 'utf8');

if (!projYml.includes('CODE_SIGN_STYLE')) {
  const signingLines = [
    `        CODE_SIGN_STYLE: Manual`,
    `        DEVELOPMENT_TEAM: ${teamId}`,
    `        CODE_SIGN_IDENTITY: "${signingIdentity}"`,
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
  fs.writeFileSync(projectYmlPath, projYml);
  console.log('Injected signing settings into project.yml');

  // Re-run xcodegen so the generated .xcodeproj picks up the new settings.
  try {
    execSync('xcodegen generate', { cwd: appleDir, stdio: 'inherit' });
  } catch {
    console.warn('xcodegen not available — tauri will regenerate xcodeproj on build');
  }
} else {
  console.log('Signing settings already present in project.yml — skipping');
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
