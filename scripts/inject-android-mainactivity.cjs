#!/usr/bin/env node
/**
 * Replace the default Tauri-generated MainActivity.kt with our custom version.
 *
 * Called in CI after `tauri android init` regenerates gen/android/.
 * The custom version adds: edge-to-edge display, safe area insets injection
 * via CSS custom properties, and share intent handling.
 */

const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, 'android', 'MainActivity.kt');
const target = path.resolve(
  __dirname,
  '..',
  'src-tauri',
  'gen',
  'android',
  'app',
  'src',
  'main',
  'java',
  'net',
  'forwardemail',
  'mail',
  'MainActivity.kt',
);

if (!fs.existsSync(source)) {
  console.error('Source MainActivity.kt not found at', source);
  process.exit(1);
}

if (!fs.existsSync(path.dirname(target))) {
  console.error('Target directory not found — run `tauri android init` first');
  process.exit(1);
}

fs.copyFileSync(source, target);
console.log('Injected custom MainActivity.kt');
