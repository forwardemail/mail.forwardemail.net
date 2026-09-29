/**
 * End-to-end tests for scripts/windows-signing.cjs.
 *
 * The script runs as a real child process, exactly as the Tauri bundler and
 * the release workflow run it. Only the external programs are stand-ins:
 * `java` plays CodeSignTool (including its habit of exiting 0 on errors),
 * PowerShell answers Get-AuthenticodeSignature, and 7-Zip unpacks an
 * installer payload.
 */
// @vitest-environment node
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve(process.cwd(), 'scripts', 'windows-signing.cjs');
const SIGNED_MARK = '\nFAKE-SIGNATURE';

// A stand-in eSigner TOTP secret: base64, as SSL.com issues it. Built at run
// time so no secret-shaped literal sits in the source for scanners to flag.
const FAKE_TOTP = Buffer.from('forward email test fixture').toString('base64');
// The same value as it arrives when pasted with spaces.
const FAKE_TOTP_PASTED = FAKE_TOTP.replace(/(.{8})/g, '$1 ').trim();
// The URL-safe alphabet, which CodeSignTool's decoder rejects.
const FAKE_TOTP_URL_SAFE = `${FAKE_TOTP.slice(0, 10)}-${FAKE_TOTP.slice(10, 20)}_`;

const FAKE_JAVA = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '-version') { console.error('openjdk version "21"'); process.exit(0); }
const state = process.env.FAKE_STATE;
fs.appendFileSync(state + '/calls.jsonl', JSON.stringify({ args, cwd: process.cwd(), tool: process.env.CODE_SIGN_TOOL_PATH }) + '\\n');
const command = args[2];
const plan = JSON.parse(fs.readFileSync(state + '/plan.json', 'utf8'));
const outcome = (plan[command] || []).shift() || plan[command + ':default'] || 'ok';
fs.writeFileSync(state + '/plan.json', JSON.stringify(plan));
const input = (args.find((a) => a.startsWith('-input_file_path=')) || '').slice('-input_file_path='.length);
console.log('WARNING: sun.reflect.Reflection.getCallerClass is not supported.');
if (command === 'credential_info') {
  if (outcome === 'ok') console.log('Subject: CN=Forward Email LLC, O=Forward Email LLC');
  else console.log('Error: The provided authorization grant is invalid, expired, revoked.');
  process.exit(0);
}
switch (outcome) {
  case 'ok':
    fs.appendFileSync(input, ${JSON.stringify(SIGNED_MARK)});
    console.log('Code signed successfully: ' + input);
    break;
  case 'auth':
    console.log('Error: The provided authorization grant is invalid, expired, revoked.');
    break;
  case 'otp':
    console.log('Error: Invalid OTP');
    break;
  case 'network':
    console.log('Error: Connection reset');
    break;
  case 'claims-success':
    console.log('Code signed successfully: ' + input);
    break;
  case 'malware':
    console.log('Error: code object is a malware. This code object cannot be signed using eSigner');
    break;
}
process.exit(0);
`;

const FAKE_POWERSHELL = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.FE_AUTHENTICODE_PATH;
const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const signed = text.includes(${JSON.stringify(SIGNED_MARK.trim())});
const other = text.includes('OTHER-SIGNATURE');
console.log(JSON.stringify({
  status: signed || other ? 'Valid' : 'NotSigned',
  subject: other ? 'CN=Someone Else Inc' : signed ? (process.env.FAKE_SUBJECT || 'CN=Forward Email LLC, O=Forward Email LLC, L=Wilmington, S=Delaware, C=US') : null,
  thumbprint: signed ? 'ABCDEF' : null,
  notAfter: '2027-09-01T00:00:00.0000000Z',
  timestamped: signed && process.env.FAKE_TIMESTAMP !== 'no',
  timestampSubject: 'CN=SSL.com Timestamping Unit 2025',
}));
`;

// Unpacks "<installer>" by copying the directory "<installer>.payload".
const FAKE_7Z = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('-o')).slice(2);
fs.cpSync(args[args.length - 1] + '.payload', out, { recursive: true });
`;

const fixtures = [];

function tool(dir, name, source) {
  const file = join(dir, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}

function createFixture({ plan = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fe-windows-signing-'));
  fixtures.push(root);
  const state = join(root, 'state');
  const bin = join(root, 'bin');
  const toolDir = join(root, 'codesigntool');
  mkdirSync(state);
  mkdirSync(bin);
  mkdirSync(join(toolDir, 'jar'), { recursive: true });
  mkdirSync(join(toolDir, 'conf'));
  writeFileSync(join(toolDir, 'jar', 'code_sign_tool-1.3.2.jar'), 'jar');
  writeFileSync(
    join(toolDir, 'conf', 'code_sign_tool.properties'),
    'CSC_API_ENDPOINT=https://cs.ssl.com\n',
  );
  writeFileSync(join(state, 'plan.json'), JSON.stringify(plan));

  const env = {
    PATH: process.env.PATH,
    HOME: root,
    FAKE_STATE: state,
    ESIGNER_USERNAME: 'release@forwardemail.net',
    ESIGNER_PASSWORD: 'p@ss "word" 1',
    ESIGNER_CREDENTIAL_ID: '8b072e22-7685-4771-b5c6-48e46614915f',
    // Base64, as SSL.com issues it; spaces from a copy and paste are dropped.
    ESIGNER_TOTP_SECRET: FAKE_TOTP_PASTED,
    CODESIGNTOOL_DIR: toolDir,
    CODESIGNTOOL_JAVA: tool(bin, 'java', FAKE_JAVA),
    WINDOWS_SIGN_POWERSHELL: tool(bin, 'powershell', FAKE_POWERSHELL),
    WINDOWS_SIGN_7Z: tool(bin, '7z', FAKE_7Z),
    WINDOWS_SIGN_LOG: join(root, 'signing-log.jsonl'),
    WINDOWS_SIGN_RETRY_DELAY_MS: '0',
    RUNNER_TEMP: join(root, 'runner-temp'),
  };
  mkdirSync(env.RUNNER_TEMP);

  return {
    root,
    env,
    toolDir,
    run(args, extraEnv = {}) {
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: { ...env, ...extraEnv },
      });
      return { ...result, output: `${result.stdout}${result.stderr}` };
    },
    calls() {
      const file = join(state, 'calls.jsonl');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
    },
    log() {
      if (!existsSync(env.WINDOWS_SIGN_LOG)) return [];
      return readFileSync(env.WINDOWS_SIGN_LOG, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    file(name, content = 'MZ binary') {
      const path = join(root, name);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
      return path;
    },
  };
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('windows-signing sign', () => {
  it('signs a binary, checks the signature, and logs it', () => {
    const fx = createFixture();
    const exe = fx.file('forwardemail-desktop.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status, result.output).toBe(0);
    expect(readFileSync(exe, 'utf8')).toContain('FAKE-SIGNATURE');
    const [call] = fx.calls();
    expect(call.args.slice(2)).toEqual([
      'sign',
      '-username=release@forwardemail.net',
      '-password=p@ss "word" 1',
      '-credential_id=8b072e22-7685-4771-b5c6-48e46614915f',
      `-totp_secret=${FAKE_TOTP}`,
      `-input_file_path=${exe}`,
      '-override',
    ]);
    // CodeSignTool finds its conf/ through this.
    expect(call.tool).toBe(fx.toolDir);
    const [entry] = fx.log();
    expect(entry).toMatchObject({ file: exe, status: 'signed', attempts: 1 });
    expect(entry.subject).toContain('Forward Email LLC');
    // The Tauri bundler prints this output; secrets must not be in it.
    expect(result.output).not.toContain('p@ss');
    expect(result.output).not.toContain(FAKE_TOTP);
  });

  it('fails when CodeSignTool prints an error but exits 0', () => {
    const fx = createFixture({ plan: { 'sign:default': 'malware' } });
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('::error::eSigner could not sign');
    expect(result.output).toContain('code object is a malware');
    expect(readFileSync(exe, 'utf8')).toBe('MZ binary');
    // A malware verdict is final; no retry.
    expect(fx.calls()).toHaveLength(1);
    expect(fx.log()).toEqual([expect.objectContaining({ file: exe, status: 'failed' })]);
  });

  it('retries a transient error and then succeeds', () => {
    const fx = createFixture({ plan: { sign: ['network', 'network', 'ok'] } });
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status, result.output).toBe(0);
    expect(fx.calls()).toHaveLength(3);
    expect(fx.log()).toEqual([expect.objectContaining({ status: 'signed', attempts: 3 })]);
  });

  it('stops after one retry on a login error so the account is not locked', () => {
    const fx = createFixture({ plan: { 'sign:default': 'auth' } });
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status).toBe(1);
    expect(fx.calls()).toHaveLength(2);
    expect(result.output).toContain('Check ESIGNER_USERNAME and ESIGNER_PASSWORD');

    // Every later signing in the job stops without contacting eSigner.
    const other = fx.file('other.exe');
    const again = fx.run(['sign', other]);
    expect(again.status).toBe(1);
    expect(again.output).toContain('not retried');
    expect(fx.calls()).toHaveLength(2);
  });

  it('retries a one-time password error with fresh codes, then stops the job', () => {
    const fx = createFixture({ plan: { 'sign:default': 'otp' } });
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status).toBe(1);
    // A code reused by the parallel Windows row gets new windows to recover in.
    expect(fx.calls()).toHaveLength(4);
    expect(result.output).toContain('Check ESIGNER_TOTP_SECRET');
    expect(fx.log()).toEqual([expect.objectContaining({ status: 'failed', auth: true })]);
  });

  it('recovers when a one-time code collides once', () => {
    const fx = createFixture({ plan: { sign: ['otp', 'ok'] } });
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status, result.output).toBe(0);
    expect(fx.calls()).toHaveLength(2);
  });

  it('will not sign an NSIS installer whose uninstaller signing failed', () => {
    const fx = createFixture({ plan: { sign: ['network', 'network', 'network', 'network'] } });
    // NSIS runs the uninstaller signing command and ignores its exit code.
    const uninstaller = fx.file('Temp/nst7F3A.tmp');
    expect(fx.run(['sign', uninstaller]).status).toBe(1);
    const setup = fx.file('bundle/nsis/Forward Email_1.0.0_x64-setup.exe');

    const result = fx.run(['sign', setup]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('its NSIS uninstaller was not signed');
    // The installer never reached eSigner, so the build stops before upload.
    expect(fx.calls()).toHaveLength(4);
    expect(readFileSync(setup, 'utf8')).toBe('MZ binary');
  });

  it('signs an NSIS installer once its uninstaller is signed', () => {
    const fx = createFixture();
    expect(fx.run(['sign', fx.file('Temp/nst7F3A.tmp')]).status).toBe(0);
    const setup = fx.file('bundle/nsis/Forward Email_1.0.0_x64-setup.exe');

    const result = fx.run(['sign', setup]);

    expect(result.status, result.output).toBe(0);
    expect(fx.log().map((e) => e.status)).toEqual(['signed', 'signed']);
  });

  it('does not trust a success message when the file did not change', () => {
    const fx = createFixture({ plan: { 'sign:default': 'claims-success' } });
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('reported success but the file did not change');
  });

  it('signs the NSIS uninstaller through a copy with an .exe extension', () => {
    const fx = createFixture();
    // makensis hands over the uninstaller as %TEMP%\\nstXXXX.tmp, and
    // CodeSignTool refuses extensions it does not know.
    const uninstaller = fx.file('Temp/nst7F3A.tmp');

    const result = fx.run(['sign', uninstaller]);

    expect(result.status, result.output).toBe(0);
    const [call] = fx.calls();
    const input = call.args.find((a) => a.startsWith('-input_file_path='));
    expect(input).toMatch(/nst7F3A\.exe$/);
    expect(readFileSync(uninstaller, 'utf8')).toContain('FAKE-SIGNATURE');
    expect(fx.log()).toEqual([expect.objectContaining({ file: uninstaller, status: 'signed' })]);
  });

  it('refuses to sign a file that is neither a PE image nor an MSI', () => {
    const fx = createFixture();
    const text = fx.file('notes.tmp', 'plain text');

    const result = fx.run(['sign', text]);

    expect(result.status).toBe(1);
    expect(fx.calls()).toHaveLength(0);
  });

  it('skips WiX build-time extensions without spending a signing', () => {
    const fx = createFixture();
    const wix = fx.file('wix/x64/wix/WixUIExtension.dll');

    const result = fx.run(['sign', wix]);

    expect(result.status, result.output).toBe(0);
    expect(fx.calls()).toHaveLength(0);
    expect(fx.log()).toEqual([expect.objectContaining({ file: wix, status: 'skipped' })]);
  });

  it('signs NSIS plugins unless plugin signing is switched off', () => {
    const fx = createFixture();
    const plugin = fx.file('nsis/x64/Plugins/x86-unicode/System.dll');

    expect(fx.run(['sign', plugin]).status).toBe(0);
    expect(fx.calls()).toHaveLength(1);

    const off = fx.run(['sign', plugin], { WINDOWS_SIGN_NSIS_PLUGINS: 'false' });
    expect(off.status).toBe(0);
    expect(fx.calls()).toHaveLength(1);
  });

  it('fails when the signature has no timestamp', () => {
    const fx = createFixture();
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe], { FAKE_TIMESTAMP: 'no' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('not timestamped');
  });

  it('fails when the certificate belongs to someone else', () => {
    const fx = createFixture();
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe], { FAKE_SUBJECT: 'CN=Forward Email Imposters' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('not "Forward Email LLC"');
    expect(result.output).toContain('WINDOWS_PUBLISHER');
  });

  it('accepts a quoted legal name set through WINDOWS_PUBLISHER', () => {
    const fx = createFixture();
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe], {
      FAKE_SUBJECT: 'CN="Forward Email, LLC", O="Forward Email, LLC", C=US',
      WINDOWS_PUBLISHER: 'Forward Email, LLC',
    });

    expect(result.status, result.output).toBe(0);
  });

  it('fails without calling CodeSignTool when a secret is missing', () => {
    const fx = createFixture();
    const exe = fx.file('app.exe');

    const result = fx.run(['sign', exe], { ESIGNER_TOTP_SECRET: '' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('Missing eSigner secrets: ESIGNER_TOTP_SECRET');
    expect(fx.calls()).toHaveLength(0);
  });
});

/** A stored (uncompressed) zip, enough for the setup step's extractor. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content);
    const fileName = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += local.length + fileName.length + data.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

describe('windows-signing setup', () => {
  function setupFixture(plan) {
    const fx = createFixture({ plan });
    const conf = join(fx.root, 'tauri.conf.json');
    cpSync(resolve(process.cwd(), 'src-tauri', 'tauri.conf.json'), conf);
    const archive = join(fx.root, 'CodeSignTool.zip');
    writeFileSync(
      archive,
      zip({
        'jar/code_sign_tool-1.3.2.jar': 'jar',
        'conf/code_sign_tool.properties': 'CSC_API_ENDPOINT=https://cs.ssl.com\n',
      }),
    );
    const sha = spawnSync('sha256sum', [archive], { encoding: 'utf8' }).stdout.split(' ')[0];
    const githubEnv = join(fx.root, 'github-env');
    const githubOutput = join(fx.root, 'github-output');
    writeFileSync(githubEnv, '');
    writeFileSync(githubOutput, '');
    const env = { GITHUB_ENV: githubEnv, GITHUB_OUTPUT: githubOutput, CODESIGNTOOL_DIR: '' };
    return {
      fx,
      conf,
      original: readFileSync(conf, 'utf8'),
      run: (extra = {}, args = []) =>
        fx.run(['setup', '--conf', conf, '--archive', archive, '--sha256', sha, ...args], {
          ...env,
          ...extra,
        }),
      githubEnv: () => readFileSync(githubEnv, 'utf8'),
      githubOutput: () => readFileSync(githubOutput, 'utf8'),
    };
  }

  it('points the Tauri bundler at the signing script', () => {
    const s = setupFixture({});

    const result = s.run();

    expect(result.status, result.output).toBe(0);
    const windows = JSON.parse(readFileSync(s.conf, 'utf8')).bundle.windows;
    expect(windows.certificateThumbprint).toBeNull();
    expect(windows.signCommand).toEqual({
      cmd: process.execPath,
      args: [script, 'sign', '%1'],
    });
    // The credentials were checked with credential_info, which spends no signing.
    expect(s.fx.calls().map((c) => c.args[2])).toEqual(['credential_info']);
    const githubEnv = s.githubEnv();
    expect(githubEnv).toContain(
      `CODESIGNTOOL_DIR=${join(s.fx.env.RUNNER_TEMP, 'codesigntool-1.3.2')}`,
    );
    expect(githubEnv).toContain('WINDOWS_PUBLISHER=Forward Email LLC');
    expect(githubEnv).toMatch(/WINDOWS_SIGN_LOG=.*windows-signing-log\.jsonl/);
    expect(s.githubOutput()).toBe('enabled=true\n');
    expect(result.output).not.toContain('p@ss');
  });

  it('fails before the build when eSigner rejects the credentials', () => {
    const s = setupFixture({ credential_info: ['bad'] });

    const result = s.run();

    expect(result.status).toBe(1);
    expect(result.output).toContain('eSigner rejected the credentials');
    expect(readFileSync(s.conf, 'utf8')).toBe(s.original);
    expect(s.githubOutput()).toBe('');
  });

  it('fails closed when the secrets are missing', () => {
    const s = setupFixture({});
    const none = {
      ESIGNER_USERNAME: '',
      ESIGNER_PASSWORD: '',
      ESIGNER_CREDENTIAL_ID: '',
      ESIGNER_TOTP_SECRET: '',
    };

    const result = s.run(none);

    expect(result.status).toBe(1);
    expect(result.output).toContain('ALLOW_UNSIGNED_WINDOWS=true');
    expect(readFileSync(s.conf, 'utf8')).toBe(s.original);

    const allowed = s.run({ ...none, ALLOW_UNSIGNED_WINDOWS: 'true' });
    expect(allowed.status).toBe(0);
    expect(allowed.output).toContain('::warning::');
    expect(s.githubOutput()).toBe('enabled=false\n');
    expect(readFileSync(s.conf, 'utf8')).toBe(s.original);
  });

  it('rejects a partial secret set even when unsigned builds are allowed', () => {
    const s = setupFixture({});

    const result = s.run({ ESIGNER_PASSWORD: '', ALLOW_UNSIGNED_WINDOWS: 'true' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('Missing eSigner secrets: ESIGNER_PASSWORD');
  });

  it('rejects a 6-digit code in place of the TOTP secret', () => {
    const s = setupFixture({});

    const result = s.run({ ESIGNER_TOTP_SECRET: '123456' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not look like the eSigner secret code');
    expect(s.fx.calls()).toHaveLength(0);
  });

  it('rejects a URL-safe secret that CodeSignTool cannot decode', () => {
    const s = setupFixture({});

    const result = s.run({ ESIGNER_TOTP_SECRET: FAKE_TOTP_URL_SAFE });

    expect(result.status).toBe(1);
    expect(result.output).toContain('does not look like the eSigner secret code');
  });

  it('rejects a multi-line WINDOWS_PUBLISHER', () => {
    const s = setupFixture({});

    const result = s.run({ WINDOWS_PUBLISHER: 'Forward Email LLC\nNODE_OPTIONS=--require=/tmp/x' });

    expect(result.status).toBe(1);
    expect(result.output).toContain('WINDOWS_PUBLISHER must be a single line');
    expect(readFileSync(s.conf, 'utf8')).toBe(s.original);
  });

  it('refuses a CodeSignTool archive whose hash does not match', () => {
    const s = setupFixture({});

    const result = s.run({}, ['--sha256', '0'.repeat(64)]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('hash mismatch');
    expect(readFileSync(s.conf, 'utf8')).toBe(s.original);
  });
});

describe('windows-signing verify', () => {
  const signed = `MZ app${SIGNED_MARK}`;

  function bundle(fx, { payload = { 'forwardemail-desktop.exe': signed } } = {}) {
    const dir = join(fx.root, 'bundle');
    const setup = fx.file('bundle/nsis/Forward Email_1.0.0_x64-setup.exe', signed);
    for (const [name, content] of Object.entries(payload)) {
      fx.file(`bundle/nsis/Forward Email_1.0.0_x64-setup.exe.payload/${name}`, content);
    }
    return { dir, setup };
  }

  function log(fx, entries) {
    writeFileSync(fx.env.WINDOWS_SIGN_LOG, entries.map((e) => JSON.stringify(e)).join('\n'));
  }

  const SETUP = 'C:\\target\\release\\bundle\\nsis\\Forward Email_1.0.0_x64-setup.exe';
  const EXE = 'C:\\target\\release\\forwardemail-desktop.exe';

  it('passes when the installer, its contents and the uninstaller are signed', () => {
    const fx = createFixture();
    const { dir } = bundle(fx, {
      payload: {
        'forwardemail-desktop.exe': signed,
        '$PLUGINSDIR/System.dll': signed,
        // A third-party file signed by its own vendor is fine.
        '$PLUGINSDIR/vendor.dll': 'MZ OTHER-SIGNATURE',
        // A stock NSIS plugin Tauri does not sign; it is never installed.
        '$PLUGINSDIR/LangDLL.dll': 'MZ unsigned',
      },
    });
    log(fx, [
      { file: EXE, status: 'signed' },
      { file: 'C:\\Temp\\nst12AB.tmp', status: 'signed' },
      { file: SETUP, status: 'signed' },
    ]);

    const result = fx.run(['verify', dir]);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('eSigner signings used by this build: 3');
  });

  it('fails when the installer itself is unsigned', () => {
    const fx = createFixture();
    const { dir, setup } = bundle(fx);
    writeFileSync(setup, 'MZ unsigned');
    log(fx, [
      { file: 'C:\\Temp\\nst12AB.tmp', status: 'signed' },
      { file: SETUP, status: 'signed' },
    ]);

    const result = fx.run(['verify', dir]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('is not validly signed (status: NotSigned)');
  });

  it('fails when an app executable inside the installer is unsigned', () => {
    const fx = createFixture();
    const { dir } = bundle(fx, { payload: { 'forwardemail-desktop.exe': 'MZ unsigned' } });
    log(fx, [
      { file: 'C:\\Temp\\nst12AB.tmp', status: 'signed' },
      { file: SETUP, status: 'signed' },
    ]);

    const result = fx.run(['verify', dir]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('forwardemail-desktop.exe inside');
  });

  it('fails when the shipped installer carries an unsigned uninstaller', () => {
    const fx = createFixture();
    const { dir } = bundle(fx);
    // NSIS ignored the failed signing command and embedded the unsigned file.
    log(fx, [
      { file: 'C:\\Temp\\nst12AB.tmp', status: 'failed', reason: 'Error: Connection reset' },
      { file: SETUP, status: 'signed' },
    ]);

    const result = fx.run(['verify', dir]);

    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'its NSIS uninstaller was not signed (Error: Connection reset)',
    );
  });

  it('passes when a retried build signed everything after an earlier attempt failed', () => {
    const fx = createFixture();
    const { dir } = bundle(fx);
    log(fx, [
      // Attempt 1: eSigner outage. NSIS carried on, then the installer failed.
      { file: EXE, status: 'signed' },
      { file: 'C:\\Temp\\nstA1B2.tmp', status: 'failed', reason: 'Error: Connection reset' },
      { file: SETUP, status: 'failed', reason: 'Refusing to sign' },
      // Attempt 2 (tauri-action retry): everything signed.
      { file: EXE, status: 'signed' },
      { file: 'C:\\Temp\\nstC3D4.tmp', status: 'signed' },
      { file: SETUP, status: 'signed' },
    ]);

    const result = fx.run(['verify', dir]);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('earlier signing failure');
  });

  it('fails when the log has no signed NSIS installer', () => {
    const fx = createFixture();
    const { dir } = bundle(fx);
    log(fx, [{ file: EXE, status: 'signed' }]);

    const result = fx.run(['verify', dir]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('no signed NSIS installer');
  });

  it('fails when there is nothing to verify', () => {
    const fx = createFixture();
    mkdirSync(join(fx.root, 'empty'));

    const result = fx.run(['verify', join(fx.root, 'empty')]);

    expect(result.status).toBe(1);
    expect(result.output).toContain('No Windows installers found');
  });
});
