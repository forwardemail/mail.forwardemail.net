// CI entry point: run the suite, then run any spec files that failed once
// more, on their own, with a new driver and a new app.
//
// The WebKit page in the app sometimes stops answering scripts on CI runners
// (software-GL Linux, the macos-x64 runner): every command then times out
// and no in-test recovery is reliable, so the job went red on a different
// spec each time. A real regression fails both runs; a wedged runner almost
// never wedges the same spec twice. Specs that only passed the second time
// are listed as a warning on the job, so they stay visible.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const REPORT = 'reports/junit.xml';

const vitest = (files) =>
  spawnSync('pnpm', ['exec', 'vitest', 'run', ...files], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  }).status ?? 1;

/** Spec files with a failing test or an error, from the JUnit report. */
function failedSpecs() {
  if (!fs.existsSync(REPORT)) return [];
  const xml = fs.readFileSync(REPORT, 'utf8');
  const files = [];
  for (const [tag] of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const attr = (name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] || '';
    if (Number(attr('failures')) > 0 || Number(attr('errors')) > 0) files.push(attr('name'));
  }
  return files.filter(Boolean);
}

if (vitest([]) === 0) process.exit(0);

const failed = failedSpecs();
// Nothing to rerun means the run broke before reporting (driver setup, a
// build problem): that is not a flaky spec, so fail as is.
if (!failed.length) process.exit(1);

fs.copyFileSync(REPORT, 'reports/junit-first-run.xml');
console.log(`\nRunning the failed spec files again: ${failed.join(', ')}\n`);
if (vitest(failed) !== 0) process.exit(1);

const message = `Passed only on a second run (the first run's page stopped answering or another flake): ${failed.join(', ')}`;
console.log(process.env.GITHUB_ACTIONS ? `::warning::${message}` : message);
