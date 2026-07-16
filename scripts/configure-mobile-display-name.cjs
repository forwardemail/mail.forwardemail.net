#!/usr/bin/env node

/**
 * Enforce the user-facing mobile launcher name after Tauri generates native
 * Android/iOS projects. Tauri may derive native target names from the binary
 * name, so this keeps the launcher label independent from executable naming.
 */

const fs = require('fs');
const path = require('path');

const DISPLAY_NAME = 'Forward Email';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function setAndroidString(xml, key, value) {
  const keyPattern = escapeRegExp(key);
  const existing = new RegExp(
    `(<string\\s+name=["']${keyPattern}["'][^>]*>)[\\s\\S]*?(<\\/string>)`,
  );
  if (existing.test(xml)) return xml.replace(existing, `$1${value}$2`);
  return xml.replace(
    /<\/resources>\s*$/,
    `    <string name="${key}">${value}</string>\n</resources>\n`,
  );
}

function setPlistString(plist, key, value) {
  const keyPattern = escapeRegExp(key);
  const existing = new RegExp(`(<key>${keyPattern}<\\/key>\\s*<string>)[^<]*(<\\/string>)`);
  if (existing.test(plist)) return plist.replace(existing, `$1${value}$2`);
  return plist.replace(
    /<\/dict>(\s*<\/plist>\s*)$/m,
    `  <key>${key}</key>\n  <string>${value}</string>\n</dict>$1`,
  );
}

function writeIfChanged(filePath, content) {
  const current = fs.readFileSync(filePath, 'utf8');
  if (current === content) return false;
  fs.writeFileSync(filePath, content);
  return true;
}

function findInfoPlists(directory) {
  if (!fs.existsSync(directory)) return [];
  const results = [];
  const visit = (current, depth) => {
    if (depth > 3) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!['build', 'DerivedData', '.git'].includes(entry.name)) visit(fullPath, depth + 1);
      } else if (entry.name === 'Info.plist') {
        results.push(fullPath);
      }
    }
  };
  visit(directory, 0);
  return results;
}

function configureMobileDisplayName(root = path.resolve(__dirname, '..')) {
  const changed = [];
  const inspected = [];

  const androidStrings = path.join(
    root,
    'src-tauri',
    'gen',
    'android',
    'app',
    'src',
    'main',
    'res',
    'values',
    'strings.xml',
  );
  if (fs.existsSync(androidStrings)) {
    inspected.push(androidStrings);
    let xml = fs.readFileSync(androidStrings, 'utf8');
    xml = setAndroidString(xml, 'app_name', DISPLAY_NAME);
    xml = setAndroidString(xml, 'main_activity_title', DISPLAY_NAME);
    if (writeIfChanged(androidStrings, xml)) changed.push(androidStrings);
  }

  const appleDir = path.join(root, 'src-tauri', 'gen', 'apple');
  for (const infoPlist of findInfoPlists(appleDir)) {
    inspected.push(infoPlist);
    const plist = fs.readFileSync(infoPlist, 'utf8');
    const updated = setPlistString(plist, 'CFBundleDisplayName', DISPLAY_NAME);
    if (writeIfChanged(infoPlist, updated)) changed.push(infoPlist);
  }

  return { changed, inspected, displayName: DISPLAY_NAME };
}

if (require.main === module) {
  const result = configureMobileDisplayName();
  if (result.inspected.length === 0) {
    console.warn(
      'No generated Android/iOS launcher metadata found; run the Tauri mobile init first.',
    );
  } else if (result.changed.length === 0) {
    console.log(`Mobile launcher name already set to "${DISPLAY_NAME}".`);
  } else {
    for (const filePath of result.changed) {
      console.log(`Set mobile launcher name to "${DISPLAY_NAME}" in ${filePath}`);
    }
  }
}

module.exports = {
  DISPLAY_NAME,
  configureMobileDisplayName,
  findInfoPlists,
  setAndroidString,
  setPlistString,
};
