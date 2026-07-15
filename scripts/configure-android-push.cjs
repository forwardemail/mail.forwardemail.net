#!/usr/bin/env node
/**
 * Configure push transports in Tauri's generated Android project.
 *
 * ANDROID_PUSH_PROVIDER values:
 *   unified-push (default) - Google-free; no Firebase/Play Services artifacts
 *   fcm                    - Firebase is enabled and selected at runtime
 *   both                   - Firebase is enabled; runtime tries FCM then UnifiedPush
 *
 * GOOGLE_SERVICES_JSON points to google-services.json for `fcm` and `both`.
 * VAPID_PUBLIC_KEY is public configuration shared with the
 * backend VAPID key pair. Set REQUIRE_PUSH_CONFIG=1 in release automation to
 * fail rather than produce a build whose selected provider cannot register.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const genAndroid = path.join(root, 'src-tauri', 'gen', 'android');
const appDir = path.join(genAndroid, 'app');
const capabilityPath = path.join(root, 'src-tauri', 'capabilities', 'android-fcm.generated.json');
const provider = (process.env.ANDROID_PUSH_PROVIDER || 'unified-push').toLowerCase();
const requireConfig = process.env.REQUIRE_PUSH_CONFIG === '1';
const validProviders = new Set(['unified-push', 'fcm', 'both']);

if (!validProviders.has(provider)) {
  throw new Error(
    `ANDROID_PUSH_PROVIDER must be one of ${[...validProviders].join(', ')}; received ${provider}`,
  );
}

if (!fs.existsSync(appDir)) {
  throw new Error(
    `Generated Android project not found at ${appDir}. Run \`pnpm tauri android init\` first.`,
  );
}

const enablesFcm = provider === 'fcm' || provider === 'both';
const enablesUnifiedPush = provider === 'unified-push' || provider === 'both';
const googleServicesSource =
  process.env.GOOGLE_SERVICES_JSON || path.join(__dirname, 'android', 'google-services.json');
const googleServicesDest = path.join(appDir, 'google-services.json');
const projectGradlePath = path.join(genAndroid, 'build.gradle.kts');
const appGradlePath = path.join(appDir, 'build.gradle.kts');
const manifestPath = path.join(appDir, 'src', 'main', 'AndroidManifest.xml');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function writeIfChanged(file, value) {
  if (read(file) !== value) fs.writeFileSync(file, value);
}

function removeFile(file) {
  if (fs.existsSync(file)) fs.rmSync(file);
}

function stripFcmGradleWiring() {
  if (fs.existsSync(projectGradlePath)) {
    let source = read(projectGradlePath);
    source = source.replace(
      /^\s*classpath\("com\.google\.gms:google-services:[^"\n]+"\)\s*\n/gm,
      '',
    );
    writeIfChanged(projectGradlePath, source);
  }

  if (fs.existsSync(appGradlePath)) {
    let source = read(appGradlePath);
    source = source
      .replace(/^\s*id\("com\.google\.gms\.google-services"\)\s*\n/gm, '')
      .replace(
        /^\s*implementation\(platform\("com\.google\.firebase:firebase-bom:[^"\n]+"\)\)\s*\n/gm,
        '',
      )
      .replace(/^\s*implementation\("com\.google\.firebase:firebase-messaging"\)\s*\n/gm, '');
    writeIfChanged(appGradlePath, source);
  }
}

function addFcmGradleWiring() {
  let projectGradle = read(projectGradlePath);
  if (!projectGradle.includes('com.google.gms:google-services:')) {
    projectGradle = projectGradle.replace(
      /(buildscript\s*\{[\s\S]*?dependencies\s*\{)/,
      '$1\n        classpath("com.google.gms:google-services:4.4.2")',
    );
    writeIfChanged(projectGradlePath, projectGradle);
  }

  let appGradle = read(appGradlePath);
  if (!appGradle.includes('com.google.gms.google-services')) {
    appGradle = appGradle.replace(
      /plugins\s*\{/,
      'plugins {\n    id("com.google.gms.google-services")',
    );
  }
  if (!appGradle.includes('com.google.firebase:firebase-bom:')) {
    appGradle = appGradle.replace(
      /dependencies\s*\{/,
      'dependencies {\n    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))',
    );
  }
  if (!appGradle.includes('com.google.firebase:firebase-messaging')) {
    appGradle = appGradle.replace(
      /dependencies\s*\{/,
      'dependencies {\n    implementation("com.google.firebase:firebase-messaging")',
    );
  }
  writeIfChanged(appGradlePath, appGradle);
}

function stripFcmManifestWiring(source) {
  return source
    .replace(
      /\s*<meta-data\s+android:name="com\.google\.firebase\.messaging\.default_notification_channel_id"\s+android:value="[^"]+"\s*\/>/g,
      '',
    )
    .replace(
      /\s*<service\s+android:name="app\.tauri\.(?:mobilepush|remotepush)\.FCMService"[\s\S]*?<\/service>/g,
      '',
    );
}

function configureManifest() {
  if (!fs.existsSync(manifestPath)) return;

  let manifest = stripFcmManifestWiring(read(manifestPath));
  const permissions = [
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
  ];
  const missingPermissions = permissions.filter(
    (permission) => !manifest.includes(`android:name="${permission}"`),
  );

  if (missingPermissions.length > 0) {
    const declarations = missingPermissions
      .map((permission) => `    <uses-permission android:name="${permission}" />`)
      .join('\n');
    manifest = manifest.replace(/\s*<application/, `\n${declarations}\n\n    <application`);
  }

  if (enablesFcm) {
    manifest = manifest.replace(
      /<application([^>]*)>/,
      `<application$1>\n        <meta-data\n            android:name="com.google.firebase.messaging.default_notification_channel_id"\n            android:value="new-mail" />`,
    );
    manifest = manifest.replace(
      /<\/application>/,
      `        <service\n            android:name="app.tauri.remotepush.FCMService"\n            android:exported="false">\n            <intent-filter>\n                <action android:name="com.google.firebase.MESSAGING_EVENT" />\n            </intent-filter>\n        </service>\n    </application>`,
    );
  }

  writeIfChanged(manifestPath, manifest);
}

function configureCapability() {
  if (!enablesFcm) {
    removeFile(capabilityPath);
    return;
  }

  fs.writeFileSync(
    capabilityPath,
    `${JSON.stringify(
      {
        $schema:
          'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.0.0/crates/tauri-cli/capabilities-schema.json',
        identifier: 'android-fcm-generated',
        description: 'Generated Android-only permissions for the optional FCM transport.',
        windows: ['main'],
        permissions: ['remote-push:default'],
        platforms: ['android'],
      },
      null,
      2,
    )}\n`,
  );
}

stripFcmGradleWiring();
removeFile(googleServicesDest);

if (enablesFcm) {
  if (!fs.existsSync(googleServicesSource)) {
    throw new Error(
      `FCM profile ${provider} requires google-services.json. Set GOOGLE_SERVICES_JSON or place it at ${googleServicesSource}.`,
    );
  }
  fs.copyFileSync(googleServicesSource, googleServicesDest);
  addFcmGradleWiring();
}

if (enablesUnifiedPush && !process.env.VAPID_PUBLIC_KEY) {
  const message =
    'VAPID_PUBLIC_KEY is not set; UnifiedPush registration will be disabled in this bundle.';
  if (requireConfig) throw new Error(message);
  console.warn(`Warning: ${message}`);
}

configureManifest();
configureCapability();

console.log(`Configured Android push profile: ${provider}`);
console.log(`  UnifiedPush: ${enablesUnifiedPush ? 'enabled' : 'runtime-disabled'}`);
console.log(`  FCM: ${enablesFcm ? 'enabled' : 'not linked'}`);
