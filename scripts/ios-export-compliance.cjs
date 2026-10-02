/**
 * App Store export-compliance keys for the generated iOS Info.plist.
 *
 * Besides the system's own TLS and Web Crypto, the app ships standard,
 * published algorithms: OpenPGP.js (encrypting, decrypting and signing mail),
 * libsodium (XSalsa20-Poly1305 and BLAKE2b for App Lock) and Argon2id (App
 * Lock PIN and device pairing keys). None is proprietary. In App Store Connect
 * that is "Standard encryption algorithms instead of, or in addition to, using
 * or accessing the encryption within Apple's operating system", which needs
 * documentation only for distribution in France. The app is not offered in
 * France, so App Store Connect treats it as exempt: ITSAppUsesNonExemptEncryption
 * is false, which also stops the per-build "Missing Compliance" prompt.
 *
 * To add France: upload the French encryption declaration under App Encryption
 * Documentation in App Store Connect, then build with
 * IOS_ENCRYPTION_COMPLIANCE_CODE set to the code Apple issues. The flag becomes
 * true and ITSEncryptionExportComplianceCode carries the code.
 *
 * Called by scripts/inject-ios-signing.cjs, the only place these keys are set:
 * tauri ios build merges src-tauri/Info.ios.plist over the generated
 * Info.plist, so a value there would replace the one written here. Uses plutil
 * on macOS and falls back to editing the XML when plutil is unavailable.
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const FLAG_KEY = 'ITSAppUsesNonExemptEncryption';
const CODE_KEY = 'ITSEncryptionExportComplianceCode';

/**
 * The compliance code from the environment, or '' when none is set.
 * @param {Record<string, string|undefined>} [env]
 */
function complianceCode(env = process.env) {
  const code = String(env.IOS_ENCRYPTION_COMPLIANCE_CODE || '').trim();
  if (code && !/^[A-Za-z0-9-]+$/.test(code)) {
    throw new Error('IOS_ENCRYPTION_COMPLIANCE_CODE may only contain letters, digits and hyphens');
  }
  return code;
}

function insertBeforeEnd(plist, entry) {
  return plist.replace(/<\/dict>(\s*<\/plist>\s*)$/, `  ${entry}\n</dict>$1`);
}

/**
 * Set or remove the two keys in plist XML text.
 * @param {string} plist
 * @param {string} code
 */
function setComplianceKeys(plist, code) {
  const flag = code ? '<true/>' : '<false/>';
  const flagPattern = new RegExp(`<key>${FLAG_KEY}</key>\\s*<(?:true|false)\\s*/>`);
  let out = flagPattern.test(plist)
    ? plist.replace(flagPattern, `<key>${FLAG_KEY}</key>\n  ${flag}`)
    : insertBeforeEnd(plist, `<key>${FLAG_KEY}</key>\n  ${flag}`);

  const codePattern = new RegExp(`[ \\t]*<key>${CODE_KEY}</key>\\s*<string>[^<]*</string>\\n?`);
  out = out.replace(codePattern, '');
  if (code) {
    out = insertBeforeEnd(out, `<key>${CODE_KEY}</key>\n  <string>${code}</string>`);
  }
  return out;
}

/**
 * Write the export-compliance keys into an Info.plist.
 *
 * @param {string} infoPlistPath
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {boolean} [options.plutil] - false forces the XML fallback
 * @returns {{ usesNonExemptEncryption: boolean, code: string }}
 */
function applyExportCompliance(infoPlistPath, { env = process.env, plutil = true } = {}) {
  const code = complianceCode(env);
  let viaPlutil = false;

  if (plutil) {
    try {
      execFileSync('plutil', [
        '-replace',
        FLAG_KEY,
        '-bool',
        code ? 'true' : 'false',
        infoPlistPath,
      ]);
      if (code) {
        execFileSync('plutil', ['-replace', CODE_KEY, '-string', code, infoPlistPath]);
      } else {
        try {
          execFileSync('plutil', ['-remove', CODE_KEY, infoPlistPath], { stdio: 'ignore' });
        } catch {
          // The key was not there.
        }
      }
      viaPlutil = true;
    } catch {
      // plutil is macOS-only; fall back to editing the XML.
    }
  }

  if (!viaPlutil) {
    const plist = fs.readFileSync(infoPlistPath, 'utf8');
    fs.writeFileSync(infoPlistPath, setComplianceKeys(plist, code));
  }

  return { usesNonExemptEncryption: Boolean(code), code };
}

module.exports = { applyExportCompliance, complianceCode, setComplianceKeys };
