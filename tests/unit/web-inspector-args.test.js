/**
 * Release builds compile in the web inspector only when WEB_INSPECTOR is
 * true. The build scripts and release workflows call this helper, so these
 * tests run it the same way: as a child process with a given environment.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'web-inspector-args.cjs');
const dirs = [];

function run(args = [], webInspector) {
  const env = { ...process.env };
  delete env.WEB_INSPECTOR;
  if (webInspector !== undefined) env.WEB_INSPECTOR = webInspector;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('web-inspector-args', () => {
  it('prints nothing when WEB_INSPECTOR is unset, so release builds leave the inspector out', () => {
    expect(run()).toMatchObject({ status: 0, stdout: '' });
  });

  it.each(['true', 'TRUE', '1', 'yes', 'on', ' true '])(
    'turns the inspector on for %j',
    (value) => {
      expect(run([], value)).toMatchObject({ status: 0, stdout: '--features devtools' });
    },
  );

  it.each(['', 'false', '0', 'no', 'off', 'devtools'])(
    'keeps the inspector off for %j',
    (value) => {
      expect(run([], value)).toMatchObject({ status: 0, stdout: '' });
    },
  );

  it('prints the bare feature name for joining with other Cargo features', () => {
    expect(run(['--names'], 'true').stdout).toBe('devtools');
    expect(run(['--names']).stdout).toBe('');
  });

  it('appends the flag to a command it runs, after the caller’s own arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-inspector-args-'));
    dirs.push(dir);
    const echo = join(dir, 'echo-args.cjs');
    writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');

    const on = run(['--exec', process.execPath, echo, 'build', '--target', 'x'], 'true');
    expect(on.status).toBe(0);
    expect(JSON.parse(on.stdout)).toEqual(['build', '--target', 'x', '--features', 'devtools']);

    const off = run(['--exec', process.execPath, echo, 'build']);
    expect(JSON.parse(off.stdout)).toEqual(['build']);
  });

  it('passes quoted arguments through unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-inspector-args-'));
    dirs.push(dir);
    const echo = join(dir, 'echo-args.cjs');
    writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');

    const config = '{"app":{"security":{"freezePrototype":false}}}';
    const result = run(['--exec', process.execPath, echo, '--config', config, 'a b']);
    expect(JSON.parse(result.stdout)).toEqual(['--config', config, 'a b']);
  });

  it('runs the project Tauri CLI for tauri', () => {
    const result = run(['--exec', 'tauri', '--version']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^tauri-cli \d+\.\d+\.\d+/);
  });

  it('passes through the exit status of the command it runs', () => {
    const result = run(['--exec', process.execPath, '-e', 'process.exit(3)']);
    expect(result.status).toBe(3);
  });

  it('fails when --exec has no command', () => {
    expect(run(['--exec']).status).toBe(2);
  });
});
