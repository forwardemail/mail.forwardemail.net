#!/usr/bin/env node
/**
 * Windows Authenticode signing through SSL.com eSigner (cloud HSM).
 *
 * The private key never leaves SSL.com. CodeSignTool computes the digest
 * locally, eSigner signs it remotely, and CodeSignTool writes the signature
 * and an RFC 3161 timestamp (ts.ssl.com) back into the file.
 *
 * Commands (see docs/SECRETS.md#windows-code-signing-secrets):
 *
 *   setup [--conf <tauri.conf.json>] [--archive <zip> --sha256 <hex>]
 *     CI only. Checks the eSigner secrets, downloads the pinned CodeSignTool
 *     release and verifies its SHA-256, confirms the credentials with a
 *     `credential_info` call (no signing is spent), and points
 *     bundle.windows.signCommand in tauri.conf.json at `sign` below.
 *
 *   sign <file>
 *     Called by the Tauri bundler for every file it signs: the main binary
 *     (once per installer type), NSIS plugin DLLs, the NSIS uninstaller, and
 *     the finished .msi and -setup.exe. Exits non-zero unless the file ends
 *     up with a valid, timestamped signature from the expected publisher.
 *
 *   verify <path>...
 *     CI only, after the build. Checks every installer (and, where the tools
 *     exist, every executable inside it) and the per-build signing log.
 *
 * Why the checks are this strict: CodeSignTool exits 0 even when signing
 * fails (it only prints "Error: ..."), and NSIS ignores the exit code of the
 * uninstaller signing command. Without verification either failure would
 * ship unsigned files without a red build.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Pinned CodeSignTool release (platform-independent Java build).
// https://github.com/SSLcom/CodeSignTool/releases
const CODESIGNTOOL_VERSION = '1.3.2';
const CODESIGNTOOL_URL = `https://github.com/SSLcom/CodeSignTool/releases/download/v${CODESIGNTOOL_VERSION}/CodeSignTool-v${CODESIGNTOOL_VERSION}.zip`;
const CODESIGNTOOL_SHA256 = 'f14b1e1ef14bfa1fd00279c363aab0debbf5dcfba0e4bcdce5d22bb771de0e3a';

const SECRET_VARS = [
  'ESIGNER_USERNAME',
  'ESIGNER_PASSWORD',
  'ESIGNER_CREDENTIAL_ID',
  'ESIGNER_TOTP_SECRET',
];

// Extensions CodeSignTool signs. It picks the format from the extension, so
// anything else (the NSIS uninstaller arrives as %TEMP%\nstXXXX.tmp) is
// signed through a copy with the right extension.
const SIGNABLE_EXTENSIONS = new Set(['.exe', '.dll', '.msi', '.sys', '.ocx', '.cab']);

// Plugin DLLs the Tauri NSIS bundler signs before packing them into the
// installer (tauri-bundler NSIS_PLUGIN_FILES).
const NSIS_PLUGIN_FILES = new Set([
  'nsisdl.dll',
  'startmenu.dll',
  'system.dll',
  'nsdialogs.dll',
  'nsis_tauri_utils.dll',
]);

const CODESIGNTOOL_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const MAX_AUTH_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class SigningError extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.auth = auth;
  }
}

function annotate(level, message) {
  // GitHub turns these into annotations; locally they read as plain lines.
  const escaped = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${level}::${escaped}`);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function secretValues(env = process.env) {
  return SECRET_VARS.map((name) => env[name])
    .filter((value) => typeof value === 'string' && value.length >= 3)
    .flatMap((value) => [value, value.replace(/\s+/g, '')]);
}

function redact(text, env = process.env) {
  let out = String(text || '');
  for (const secret of secretValues(env)) {
    out = out.split(secret).join('***');
  }
  return out;
}

// CodeSignTool base64-decodes the eSigner TOTP secret, so keep its case and
// only drop the spaces a copy and paste may add.
function normalizeTotpSecret(value) {
  return String(value || '').replace(/\s+/g, '');
}

function isPlausibleTotpSecret(secret) {
  // java.util.Base64's basic decoder, which CodeSignTool uses, rejects the
  // URL-safe alphabet (- and _).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret)) return false;
  // A 6-digit one-time code also fits the alphabet; a real secret decodes to
  // at least 10 bytes.
  return Buffer.from(secret, 'base64').length >= 10;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readTauriConf(confPath) {
  return JSON.parse(fs.readFileSync(confPath, 'utf8'));
}

function expectedPublisher(env = process.env) {
  // Written to GITHUB_ENV by setup, so it must stay on one line.
  if (/[\r\n]/.test(env.WINDOWS_PUBLISHER || '')) {
    throw new SigningError('WINDOWS_PUBLISHER must be a single line.');
  }
  if (env.WINDOWS_PUBLISHER && env.WINDOWS_PUBLISHER.trim()) return env.WINDOWS_PUBLISHER.trim();
  const conf = readTauriConf(path.join(ROOT, 'src-tauri', 'tauri.conf.json'));
  return String(conf.bundle?.publisher || '').trim();
}

/** Split an X.500 subject ("CN=A, O="B, Inc.", C=US") into attribute pairs. */
function parseSubject(subject) {
  const parts = [];
  let current = '';
  let quoted = false;
  for (const ch of String(subject || '')) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts
    .map((part) => {
      const index = part.indexOf('=');
      if (index === -1) return null;
      const key = part.slice(0, index).trim().toUpperCase();
      const value = part
        .slice(index + 1)
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/""/g, '"');
      return [key, value];
    })
    .filter(Boolean);
}

function subjectMatchesPublisher(subject, publisher) {
  const wanted = publisher.trim().toLowerCase();
  return parseSubject(subject).some(
    ([key, value]) => (key === 'CN' || key === 'O') && value.trim().toLowerCase() === wanted,
  );
}

// ---------------------------------------------------------------------------
// Signature inspection (Windows: Get-AuthenticodeSignature, signtool fallback)
// ---------------------------------------------------------------------------

const AUTHENTICODE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$s = Get-AuthenticodeSignature -LiteralPath $env:FE_AUTHENTICODE_PATH
$signer = $s.SignerCertificate
$tsa = $s.TimeStamperCertificate
[pscustomobject]@{
  status = [string]$s.Status
  statusMessage = [string]$s.StatusMessage
  subject = if ($signer) { $signer.Subject } else { $null }
  thumbprint = if ($signer) { $signer.Thumbprint } else { $null }
  notAfter = if ($signer) { $signer.NotAfter.ToUniversalTime().ToString('o') } else { $null }
  timestamped = [bool]$tsa
  timestampSubject = if ($tsa) { $tsa.Subject } else { $null }
} | ConvertTo-Json -Compress
`;

function powershellCommand(env = process.env) {
  return env.WINDOWS_SIGN_POWERSHELL || 'powershell.exe';
}

function findSigntool(env = process.env) {
  if (env.TAURI_WINDOWS_SIGNTOOL_PATH && fs.existsSync(env.TAURI_WINDOWS_SIGNTOOL_PATH)) {
    return env.TAURI_WINDOWS_SIGNTOOL_PATH;
  }
  if (process.platform !== 'win32') return null;
  const kits = path.join(
    env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  );
  if (!fs.existsSync(kits)) return null;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const versions = fs
    .readdirSync(kits)
    .filter((name) => /^10\./.test(name))
    .sort()
    .reverse();
  for (const version of versions) {
    for (const dir of [arch, 'x64']) {
      const candidate = path.join(kits, version, dir, 'signtool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Returns { status, subject, thumbprint, timestamped, ... } for a file. */
function inspectSignature(file, env = process.env) {
  const result = spawnSync(
    powershellCommand(env),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      AUTHENTICODE_SCRIPT,
    ],
    {
      encoding: 'utf8',
      env: { ...env, FE_AUTHENTICODE_PATH: file },
      timeout: 60_000,
      windowsHide: true,
    },
  );
  if (result.error) {
    throw new SigningError(`Could not inspect the signature of ${file}: ${result.error.message}`);
  }
  const line = String(result.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop();
  if (result.status !== 0 || !line) {
    throw new SigningError(
      `Could not inspect the signature of ${file}: ${redact(result.stderr || result.stdout, env).trim()}`,
    );
  }
  const info = JSON.parse(line);

  // Belt and braces for the timestamp: fall back to signtool when PowerShell
  // reports a valid signature without a timestamp signer.
  if (info.status === 'Valid' && !info.timestamped) {
    const signtool = findSigntool(env);
    if (signtool) {
      const check = spawnSync(signtool, ['verify', '/pa', '/v', file], {
        encoding: 'utf8',
        timeout: 60_000,
        windowsHide: true,
      });
      if (/The signature is timestamped/i.test(check.stdout || '')) info.timestamped = true;
    }
  }
  return info;
}

/** Throws unless the file carries a valid, timestamped publisher signature. */
function assertSignedByPublisher(file, publisher, env = process.env) {
  const info = inspectSignature(file, env);
  if (info.status !== 'Valid') {
    throw new SigningError(
      `${file} is not validly signed (status: ${info.status}${info.statusMessage ? `, ${info.statusMessage}` : ''}).`,
    );
  }
  if (!subjectMatchesPublisher(info.subject, publisher)) {
    throw new SigningError(
      `${file} is signed by "${info.subject}", not "${publisher}". Set the WINDOWS_PUBLISHER variable if the certificate uses a different legal name.`,
    );
  }
  if (!info.timestamped) {
    throw new SigningError(
      `${file} is signed but not timestamped; the signature would stop validating when the certificate expires.`,
    );
  }
  return info;
}

// ---------------------------------------------------------------------------
// Signing log (one JSON object per line, shared by sign and verify)
// ---------------------------------------------------------------------------

function appendLog(entry, env = process.env) {
  const logPath = env.WINDOWS_SIGN_LOG;
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
}

function readLog(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// CodeSignTool
// ---------------------------------------------------------------------------

function javaCommand(env = process.env) {
  if (env.CODESIGNTOOL_JAVA) return env.CODESIGNTOOL_JAVA;
  if (env.JAVA_HOME) {
    const candidate = path.join(
      env.JAVA_HOME,
      'bin',
      process.platform === 'win32' ? 'java.exe' : 'java',
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'java';
}

function findJar(toolDir) {
  const jarDir = path.join(toolDir, 'jar');
  const jar = fs.existsSync(jarDir)
    ? fs.readdirSync(jarDir).find((name) => /^code_sign_tool-.*\.jar$/.test(name))
    : null;
  if (!jar) throw new SigningError(`CodeSignTool jar not found under ${jarDir}.`);
  return path.join(jarDir, jar);
}

function readCredentials(env = process.env) {
  const missing = SECRET_VARS.filter((name) => !env[name] || !String(env[name]).trim());
  if (missing.length > 0) {
    throw new SigningError(`Missing eSigner secrets: ${missing.join(', ')}.`);
  }
  return {
    username: env.ESIGNER_USERNAME.trim(),
    password: env.ESIGNER_PASSWORD,
    credentialId: env.ESIGNER_CREDENTIAL_ID.trim(),
    totpSecret: normalizeTotpSecret(env.ESIGNER_TOTP_SECRET),
  };
}

function runCodeSignTool(args, env = process.env) {
  const toolDir = env.CODESIGNTOOL_DIR;
  if (!toolDir || !fs.existsSync(toolDir)) {
    throw new SigningError('CODESIGNTOOL_DIR is not set; run `windows-signing.cjs setup` first.');
  }
  const jar = findJar(toolDir);
  const result = spawnSync(javaCommand(env), ['-jar', jar, ...args], {
    cwd: toolDir,
    encoding: 'utf8',
    // CodeSignTool reads conf/code_sign_tool.properties from here.
    env: { ...env, CODE_SIGN_TOOL_PATH: toolDir },
    // Any prompt (overwrite confirmation, SMS one-time password) must fail
    // instead of waiting forever for a keyboard that is not there.
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CODESIGNTOOL_TIMEOUT_MS,
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    status: result.status,
    error: result.error,
    output: redact(output, env),
  };
}

/** The useful part of CodeSignTool output: its "Error: ..." line(s), minus JVM noise. */
function summarizeOutput(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(WARNING:|Picked up JAVA_TOOL_OPTIONS)/.test(line));
  const errors = lines.filter((line) => /^Error:/i.test(line));
  return (errors.length > 0 ? errors : lines).join(' ').trim();
}

function classifyFailure(output) {
  if (
    /Unsupported file format|Invalid input file path|No credential ID found|malware|OTP not provided|Possible value is y\/n|Enter the OTP/i.test(
      output,
    )
  ) {
    return 'fatal';
  }
  // "authorization grant is invalid" comes from the OAuth password grant
  // (username or password).
  if (
    /authorization grant is invalid|invalid_grant|invalid (user ?name|password|credentials)/i.test(
      output,
    )
  ) {
    return 'auth';
  }
  // One-time password errors: usually a wrong ESIGNER_TOTP_SECRET, but
  // possibly a code already used in the same 30-second window by the other
  // Windows row. Every retry waits for a new window.
  if (/\bT?OTP\b|one-time password|Illegal base64/i.test(output)) return 'otp';
  return 'transient';
}

function retryDelayMs(attempt, env = process.env) {
  if (env.WINDOWS_SIGN_RETRY_DELAY_MS !== undefined) return Number(env.WINDOWS_SIGN_RETRY_DELAY_MS);
  // Wait at least into the next 30-second TOTP window so a retry never
  // reuses a one-time code (both Windows rows sign in parallel with the
  // same credential), then back off.
  const intoWindow = Date.now() % 30_000;
  const nextWindow = 30_000 - intoWindow + 2_000;
  return Math.max(nextWindow, attempt * 15_000);
}

// ---------------------------------------------------------------------------
// sign
// ---------------------------------------------------------------------------

function isNsisInstaller(file) {
  return /-setup\.exe$/i.test(path.win32.basename(file));
}

function isUninstaller(file) {
  // makensis passes the uninstaller as %TEMP%\nstXXXX.tmp (GetTempFileName).
  return /^nst.*\.tmp$/i.test(path.win32.basename(file));
}

/**
 * Looks at the log entries written since the previous NSIS installer signing
 * (entries before `end`) and returns why the uninstaller for the installer
 * being built is not signed, or null when it is.
 */
function uninstallerProblem(log, end) {
  let start = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    if (isNsisInstaller(log[i].file)) {
      start = i + 1;
      break;
    }
  }
  const attempts = log.slice(start, end).filter((entry) => isUninstaller(entry.file));
  const last = attempts[attempts.length - 1];
  if (!last) return 'no NSIS uninstaller was signed for it.';
  if (last.status !== 'signed') return `its NSIS uninstaller was not signed (${last.reason}).`;
  return null;
}

function skipReason(file, env = process.env) {
  const base = path.basename(file).toLowerCase();
  // WiX extension assemblies are loaded by candle/light on the build machine
  // only; nothing from them ships as a file, so signing them spends quota
  // for nothing.
  if (/^wix\w*extension\.dll$/.test(base)) return 'WiX build-time extension, not shipped';
  if (
    env.WINDOWS_SIGN_NSIS_PLUGINS === 'false' &&
    NSIS_PLUGIN_FILES.has(base) &&
    /x86-unicode/i.test(path.dirname(file))
  ) {
    return 'NSIS plugin signing disabled (WINDOWS_SIGN_NSIS_PLUGINS=false)';
  }
  return null;
}

function signableExtension(file) {
  const ext = path.extname(file).toLowerCase();
  if (SIGNABLE_EXTENSIONS.has(ext)) return ext;
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(8);
  fs.readSync(fd, head, 0, 8, 0);
  fs.closeSync(fd);
  if (head[0] === 0x4d && head[1] === 0x5a) return '.exe'; // "MZ": PE image
  if (head.readUInt32BE(0) === 0xd0cf11e0) return '.msi'; // OLE compound file
  throw new SigningError(`${file} is neither a PE image nor an MSI; refusing to sign it.`);
}

async function signFile(inputPath, env = process.env) {
  const file = path.resolve(inputPath);
  if (!fs.existsSync(file)) throw new SigningError(`File to sign not found: ${file}`);

  const reason = skipReason(file, env);
  if (reason) {
    console.log(`Skipping ${file}: ${reason}.`);
    appendLog({ file, status: 'skipped', reason }, env);
    return { status: 'skipped' };
  }

  const credentials = readCredentials(env);
  const publisher = expectedPublisher(env);
  if (!publisher)
    throw new SigningError('No expected publisher (WINDOWS_PUBLISHER or bundle.publisher).');

  const log = readLog(env.WINDOWS_SIGN_LOG);
  // One refused login or one-time password stops all signing in this job.
  // The bundler, NSIS and tauri-action retries would otherwise keep trying
  // and could lock the SSL.com account.
  if (log.some((entry) => entry.auth)) {
    throw new SigningError(
      'eSigner refused the login or one-time password earlier in this job, so signing is not retried (repeated failures can lock the SSL.com account). Fix the ESIGNER_* secrets and re-run.',
      { auth: true },
    );
  }
  // NSIS ignores the exit code of the uninstaller signing command, so check
  // the uninstaller here, before the installer that embeds it is signed and
  // uploaded.
  if (env.WINDOWS_SIGN_LOG && isNsisInstaller(file)) {
    const problem = uninstallerProblem(log, log.length);
    if (problem) throw new SigningError(`Refusing to sign ${file}: ${problem}`);
  }

  // Sign a copy when the extension is not one CodeSignTool recognizes.
  const extension = signableExtension(file);
  let workDir = null;
  let target = file;
  if (path.extname(file).toLowerCase() !== extension) {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fe-sign-'));
    target = path.join(workDir, `${path.basename(file, path.extname(file))}${extension}`);
    fs.copyFileSync(file, target);
  }

  try {
    const before = sha256File(target);
    let authFailures = 0;
    let lastOutput = '';
    let attempt = 0;
    let signed = false;

    while (attempt < MAX_ATTEMPTS && !signed) {
      attempt += 1;
      const run = runCodeSignTool(
        [
          'sign',
          `-username=${credentials.username}`,
          `-password=${credentials.password}`,
          `-credential_id=${credentials.credentialId}`,
          `-totp_secret=${credentials.totpSecret}`,
          `-input_file_path=${target}`,
          '-override',
        ],
        env,
      );
      lastOutput = run.output.trim();
      const reported =
        !run.error &&
        run.status === 0 &&
        /Code signed successfully/i.test(lastOutput) &&
        !/^\s*Error:/im.test(lastOutput);
      const changed = fs.existsSync(target) && sha256File(target) !== before;

      if (reported && changed) {
        signed = true;
        break;
      }

      const detail = run.error
        ? `${run.error.message}`
        : reported
          ? 'CodeSignTool reported success but the file did not change'
          : summarizeOutput(lastOutput) || `CodeSignTool exited with ${run.status}`;
      const kind = run.error ? 'transient' : classifyFailure(lastOutput);
      if (kind === 'auth') authFailures += 1;
      const canRetry =
        kind !== 'fatal' &&
        attempt < MAX_ATTEMPTS &&
        (kind !== 'auth' || authFailures < MAX_AUTH_ATTEMPTS);
      console.log(
        `Signing attempt ${attempt} for ${path.basename(file)} failed: ${detail}${canRetry ? ' Retrying.' : ''}`,
      );
      if (!canRetry) {
        const hints = {
          auth: ' Check ESIGNER_USERNAME and ESIGNER_PASSWORD.',
          otp: ' Check ESIGNER_TOTP_SECRET.',
        };
        // A login or one-time password refused after the retries stops all
        // signing in this job (see the check at the top of signFile).
        throw new SigningError(`eSigner could not sign ${file}: ${detail}${hints[kind] || ''}`, {
          auth: kind === 'auth' || kind === 'otp',
        });
      }
      await sleep(retryDelayMs(attempt, env));
    }

    if (!signed) {
      throw new SigningError(`eSigner could not sign ${file}: ${summarizeOutput(lastOutput)}`);
    }

    const info = assertSignedByPublisher(target, publisher, env);
    if (target !== file) fs.copyFileSync(target, file);

    appendLog(
      {
        file,
        status: 'signed',
        attempts: attempt,
        subject: info.subject,
        thumbprint: info.thumbprint,
        timestampSubject: info.timestampSubject,
        sha256: sha256File(file),
      },
      env,
    );
    console.log(
      `Signed ${file} as "${info.subject}" (timestamped by ${info.timestampSubject || 'TSA'}).`,
    );
    return { status: 'signed', info };
  } finally {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function writeGithubFile(name, lines, env = process.env) {
  const target = env[name];
  if (!target) return;
  fs.appendFileSync(target, `${lines.join('\n')}\n`);
}

async function download(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      await sleep(attempt * 5_000);
    }
  }
  throw new SigningError(`Could not download ${url}: ${lastError?.message}`);
}

function extractZip(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  // On Windows, call System32's bsdtar (reads zip) by full path: Git Bash
  // puts GNU tar first on PATH, and GNU tar cannot read zip files.
  // Expand-Archive is the fallback. unzip covers Linux and macOS.
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const attempts =
    process.platform === 'win32'
      ? [
          [path.join(system32, 'tar.exe'), ['-xf', archive, '-C', destination], {}],
          [
            path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Expand-Archive -LiteralPath $env:FE_ZIP -DestinationPath $env:FE_ZIP_DEST -Force',
            ],
            { FE_ZIP: archive, FE_ZIP_DEST: destination },
          ],
        ]
      : [
          ['unzip', ['-q', '-o', archive, '-d', destination], {}],
          ['tar', ['-xf', archive, '-C', destination], {}],
        ];
  for (const [cmd, args, extraEnv] of attempts) {
    const result = spawnSync(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
      timeout: 5 * 60_000,
    });
    if (!result.error && result.status === 0) return;
  }
  throw new SigningError(`Could not extract ${archive}.`);
}

function parseArgs(argv) {
  const options = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      options[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  return { options, rest };
}

async function setup(argv, env = process.env) {
  const { options } = parseArgs(argv);
  const confPath = path.resolve(options.conf || path.join(ROOT, 'src-tauri', 'tauri.conf.json'));
  const present = SECRET_VARS.filter((name) => env[name] && String(env[name]).trim());

  if (present.length === 0) {
    if (env.ALLOW_UNSIGNED_WINDOWS === 'true') {
      annotate(
        'warning',
        'eSigner secrets are not set and ALLOW_UNSIGNED_WINDOWS=true: the Windows installers will ship UNSIGNED and Windows will show SmartScreen warnings.',
      );
      writeGithubFile('GITHUB_OUTPUT', ['enabled=false'], env);
      return;
    }
    throw new SigningError(
      `Windows signing secrets are not set (${SECRET_VARS.join(', ')}). Add them to the "release" environment (docs/SECRETS.md#windows-code-signing-secrets), or set the repository variable ALLOW_UNSIGNED_WINDOWS=true to ship an unsigned build on purpose.`,
    );
  }
  const credentials = readCredentials(env);
  if (!isPlausibleTotpSecret(credentials.totpSecret)) {
    throw new SigningError(
      'ESIGNER_TOTP_SECRET does not look like the eSigner secret code. Use the secret code shown with the eSigner QR code, not a 6-digit one-time code or the 4-digit PIN.',
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      credentials.credentialId,
    )
  ) {
    annotate(
      'warning',
      'ESIGNER_CREDENTIAL_ID does not look like an eSigner credential ID (a UUID). Signing will fail if it is wrong.',
    );
  }
  const publisher = expectedPublisher(env);
  if (!publisher)
    throw new SigningError('No expected publisher (WINDOWS_PUBLISHER or bundle.publisher).');

  // CodeSignTool, pinned and hash-checked.
  const workRoot = env.RUNNER_TEMP || os.tmpdir();
  const toolDir = path.join(workRoot, `codesigntool-${CODESIGNTOOL_VERSION}`);
  const expectedHash = (options.sha256 || CODESIGNTOOL_SHA256).toLowerCase();
  let archive = options.archive ? path.resolve(options.archive) : null;
  if (!archive) {
    archive = path.join(workRoot, `CodeSignTool-v${CODESIGNTOOL_VERSION}.zip`);
    console.log(`Downloading CodeSignTool ${CODESIGNTOOL_VERSION}...`);
    await download(CODESIGNTOOL_URL, archive);
  }
  const actualHash = sha256File(archive);
  if (actualHash !== expectedHash) {
    throw new SigningError(
      `CodeSignTool archive hash mismatch (expected ${expectedHash}, got ${actualHash}). Refusing to use it.`,
    );
  }
  fs.rmSync(toolDir, { recursive: true, force: true });
  extractZip(archive, toolDir);
  findJar(toolDir);
  const properties = path.join(toolDir, 'conf', 'code_sign_tool.properties');
  if (!fs.existsSync(properties) || !/cs\.ssl\.com/.test(fs.readFileSync(properties, 'utf8'))) {
    throw new SigningError(`${properties} does not point at the eSigner production service.`);
  }

  const toolEnv = { ...env, CODESIGNTOOL_DIR: toolDir };
  const java = spawnSync(javaCommand(toolEnv), ['-version'], { encoding: 'utf8' });
  if (java.error || java.status !== 0) {
    throw new SigningError(
      `Java is required for CodeSignTool: ${java.error?.message || java.stderr}`,
    );
  }

  // Fail fast on bad credentials before a 20-minute build. credential_info
  // authenticates and reads the certificate; it does not spend a signing.
  const info = runCodeSignTool(
    [
      'credential_info',
      `-username=${credentials.username}`,
      `-password=${credentials.password}`,
      `-credential_id=${credentials.credentialId}`,
    ],
    toolEnv,
  );
  if (info.error || info.status !== 0 || /^\s*Error:/im.test(info.output)) {
    throw new SigningError(
      `eSigner rejected the credentials: ${info.error?.message || summarizeOutput(info.output)} Check ESIGNER_USERNAME, ESIGNER_PASSWORD and ESIGNER_CREDENTIAL_ID.`,
    );
  }
  console.log('eSigner credential:');
  console.log(info.output.trim());

  // Point the Tauri bundler at `sign`. Absolute paths: the NSIS uninstaller
  // hook runs from a different working directory.
  const conf = readTauriConf(confPath);
  conf.bundle = conf.bundle || {};
  conf.bundle.windows = conf.bundle.windows || {};
  conf.bundle.windows.certificateThumbprint = null;
  conf.bundle.windows.signCommand = {
    cmd: process.execPath,
    args: [path.join(ROOT, 'scripts', 'windows-signing.cjs'), 'sign', '%1'],
  };
  fs.writeFileSync(confPath, `${JSON.stringify(conf, null, 2)}\n`);

  const logPath = path.join(workRoot, 'windows-signing-log.jsonl');
  fs.writeFileSync(logPath, '');
  writeGithubFile(
    'GITHUB_ENV',
    [
      `CODESIGNTOOL_DIR=${toolDir}`,
      `CODESIGNTOOL_JAVA=${javaCommand(toolEnv)}`,
      `WINDOWS_SIGN_LOG=${logPath}`,
      `WINDOWS_PUBLISHER=${publisher}`,
    ],
    env,
  );
  writeGithubFile('GITHUB_OUTPUT', ['enabled=true'], env);
  console.log(
    `Windows signing ready: SSL.com eSigner, publisher "${publisher}", CodeSignTool ${CODESIGNTOOL_VERSION}.`,
  );
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function listFiles(target, predicate) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return predicate(target) ? [target] : [];
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => listFiles(path.join(target, entry.name), predicate));
}

function findSevenZip(env = process.env) {
  if (env.WINDOWS_SIGN_7Z) return env.WINDOWS_SIGN_7Z;
  if (process.platform !== 'win32') return null;
  for (const base of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
    if (!base) continue;
    const candidate = path.join(base, '7-Zip', '7z.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  const which = spawnSync('where', ['7z'], { encoding: 'utf8' });
  return which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : null;
}

/** Unpacks an installer so the executables inside it can be checked. */
function unpackInstaller(installer, env = process.env) {
  const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'fe-unpack-'));
  if (installer.toLowerCase().endsWith('.msi')) {
    if (process.platform !== 'win32') return { dir, ok: false, why: 'msiexec is Windows-only' };
    const result = spawnSync('msiexec', ['/a', installer, '/qn', `TARGETDIR=${dir}`], {
      timeout: 5 * 60_000,
    });
    return { dir, ok: result.status === 0, why: `msiexec exited ${result.status}` };
  }
  const sevenZip = findSevenZip(env);
  if (!sevenZip) return { dir, ok: false, why: '7-Zip not found' };
  const result = spawnSync(sevenZip, ['x', '-y', `-o${dir}`, installer], {
    encoding: 'utf8',
    timeout: 5 * 60_000,
  });
  return { dir, ok: result.status === 0, why: `7-Zip exited ${result.status}` };
}

function verify(argv, env = process.env) {
  const { rest } = parseArgs(argv);
  const publisher = expectedPublisher(env);
  const isInstaller = (file) => /\.msi$|-setup\.exe$/i.test(file);
  const installers = rest.flatMap((target) => listFiles(path.resolve(target), isInstaller));
  const problems = [];

  if (installers.length === 0) {
    throw new SigningError(`No Windows installers found under: ${rest.join(', ')}`);
  }

  for (const installer of installers) {
    try {
      const info = assertSignedByPublisher(installer, publisher, env);
      console.log(`OK  ${installer} (${info.subject}, expires ${info.notAfter})`);
    } catch (error) {
      problems.push(error.message);
      continue;
    }

    // Every executable the installer carries must be signed too. Ours must
    // be signed by the publisher; anything else must at least be validly
    // signed by someone. NSIS plugin DLLs may be unsigned only when plugin
    // signing is switched off.
    const unpacked = unpackInstaller(installer, env);
    try {
      if (!unpacked.ok) {
        annotate(
          'warning',
          `Could not unpack ${installer} to check its contents (${unpacked.why}).`,
        );
        continue;
      }
      const inner = listFiles(unpacked.dir, (file) => /\.(exe|dll)$/i.test(file));
      if (inner.length === 0) {
        problems.push(
          `${installer} unpacked to no executables; cannot confirm its contents are signed.`,
        );
      }
      for (const file of inner) {
        const base = path.basename(file).toLowerCase();
        const relative = path.relative(unpacked.dir, file);
        const info = inspectSignature(file, env);
        if (info.status === 'Valid' && subjectMatchesPublisher(info.subject, publisher)) {
          if (!info.timestamped)
            problems.push(`${relative} inside ${installer} is not timestamped.`);
          continue;
        }
        if (NSIS_PLUGIN_FILES.has(base) && env.WINDOWS_SIGN_NSIS_PLUGINS === 'false') continue;
        // Stock NSIS plugins that Tauri does not sign (LangDLL, UserInfo, ...)
        // run from a temporary folder while the installer is open and are
        // never installed.
        if (info.status !== 'Valid' && /^\$PLUGINSDIR[\\/][^\\/]+\.dll$/i.test(relative)) {
          console.log(`    ${relative} is an unsigned NSIS plugin (not installed)`);
          continue;
        }
        if (info.status === 'Valid') {
          console.log(`    ${relative} is signed by ${info.subject}`);
          continue;
        }
        problems.push(`${relative} inside ${installer} is not signed (${info.status}).`);
      }
      console.log(`    ${inner.length} executables inside checked`);
    } finally {
      fs.rmSync(unpacked.dir, { recursive: true, force: true });
    }
  }

  // The signing log covers what the installers hide: NSIS ignores the exit
  // code of the uninstaller signing command. `sign` already refuses to sign
  // an installer whose uninstaller failed; this repeats the check for the
  // installer that shipped. Failures from an earlier tauri-action attempt
  // are listed but do not fail a later attempt that signed everything.
  const log = readLog(env.WINDOWS_SIGN_LOG);
  for (const entry of log.filter((e) => e.status === 'failed')) {
    console.log(`    earlier signing failure: ${entry.file}: ${entry.reason}`);
  }
  if (installers.some(isNsisInstaller)) {
    let lastSetup = -1;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      if (isNsisInstaller(log[i].file) && log[i].status === 'signed') {
        lastSetup = i;
        break;
      }
    }
    if (lastSetup === -1) {
      problems.push('The signing log has no signed NSIS installer.');
    } else {
      const problem = uninstallerProblem(log, lastSetup);
      if (problem) problems.push(`${log[lastSetup].file}: ${problem}`);
    }
  }

  const signings = log.filter((e) => e.status === 'signed').length;
  console.log(`eSigner signings used by this build: ${signings}`);

  if (problems.length > 0) {
    throw new SigningError(problems.join('\n'));
  }
  console.log(`All Windows installers are signed by "${publisher}" and timestamped.`);
}

// ---------------------------------------------------------------------------

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'setup') return setup(rest);
  if (command === 'sign') {
    if (!rest[0]) throw new SigningError('Usage: windows-signing.cjs sign <file>');
    try {
      return await signFile(rest[0]);
    } catch (error) {
      appendLog({
        file: path.resolve(rest[0]),
        status: 'failed',
        reason: redact(error.message),
        ...(error.auth ? { auth: true } : {}),
      });
      throw error;
    }
  }
  if (command === 'verify') return verify(rest);
  throw new SigningError('Usage: windows-signing.cjs <setup|sign|verify> [...]');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    const message = redact(error instanceof SigningError ? error.message : error.stack);
    for (const line of message.split('\n').filter(Boolean)) annotate('error', line);
    process.exit(1);
  });
}

module.exports = { parseSubject, subjectMatchesPublisher, redact, CODESIGNTOOL_SHA256 };
