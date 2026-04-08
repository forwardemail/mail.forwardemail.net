#!/usr/bin/env node
/**
 * Sync version from package.json to tauri.conf.json and Cargo.toml.
 * Called automatically by npm's `version` lifecycle hook so that
 * `np` (or `npm version`) keeps all version files in sync.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;

if (!version) {
  console.error('No version found in package.json');
  process.exit(1);
}

// Update tauri.conf.json
const tauriConfPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');

// Update Cargo.toml (first version = line under [package])
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml');
let cargo = fs.readFileSync(cargoPath, 'utf8');
cargo = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
fs.writeFileSync(cargoPath, cargo);

console.log(`Synced version ${version} → tauri.conf.json, Cargo.toml`);
