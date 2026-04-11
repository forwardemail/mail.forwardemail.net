#!/usr/bin/env node
/**
 * Inject signing config into the Tauri-generated build.gradle.kts.
 *
 * Called in CI after `tauri android init` regenerates gen/android/.
 * Reads keystore path and credentials from environment variables so
 * the same build.gradle.kts works unsigned locally and signed in CI.
 */

const fs = require('fs');
const path = require('path');

const gradlePath = path.resolve(
  __dirname,
  '..',
  'src-tauri',
  'gen',
  'android',
  'app',
  'build.gradle.kts',
);

if (!fs.existsSync(gradlePath)) {
  console.error('build.gradle.kts not found — run `tauri android init` first');
  process.exit(1);
}

let gradle = fs.readFileSync(gradlePath, 'utf8');

// Check if signing config is already present
if (gradle.includes('signingConfigs')) {
  console.log('Signing config already present in build.gradle.kts — skipping');
  process.exit(0);
}

// Add signingConfigs block before defaultConfig
const signingBlock = `
    signingConfigs {
        create("release") {
            storeFile = file(System.getenv("ANDROID_KEYSTORE") ?: "/dev/null")
            storePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
            keyAlias = System.getenv("ANDROID_KEY_ALIAS") ?: ""
            keyPassword = System.getenv("ANDROID_KEY_PASSWORD") ?: ""
        }
    }`;

gradle = gradle.replace(/defaultConfig\s*\{/, signingBlock + '\n    defaultConfig {');

// Wire signing config to release buildType
gradle = gradle.replace(
  /getByName\("release"\)\s*\{/,
  'getByName("release") {\n            signingConfig = signingConfigs.getByName("release")',
);

fs.writeFileSync(gradlePath, gradle);
console.log('Injected signing config into build.gradle.kts');
