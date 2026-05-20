import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 4444;
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const STATUS_URL = `http://${HOST}:${PORT}/status`;

const REPORTS_DIR = path.resolve('./reports');
fs.mkdirSync(REPORTS_DIR, { recursive: true });

export default async function globalSetup() {
  const stdoutPath = path.join(REPORTS_DIR, 'tauri-webdriver.stdout.log');
  const stderrPath = path.join(REPORTS_DIR, 'tauri-webdriver.stderr.log');
  const stdoutLog = fs.createWriteStream(stdoutPath);
  const stderrLog = fs.createWriteStream(stderrPath);

  const driver: ChildProcess = spawn('tauri-webdriver', [], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  driver.stdout?.on('data', (chunk: Buffer) => {
    stdoutLog.write(chunk);
    process.stdout.write(chunk);
  });
  driver.stderr?.on('data', (chunk: Buffer) => {
    stderrLog.write(chunk);
    process.stderr.write(chunk);
  });

  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  const exitState: { value: ExitInfo | null } = { value: null };
  driver.once('exit', (code, signal) => {
    exitState.value = { code, signal };
  });

  const spawnFailed = new Promise<never>((_, reject) => {
    driver.once('error', (err) =>
      reject(new Error(`tauri-webdriver failed to spawn: ${(err as Error).message}`)),
    );
  });

  const ready = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const exited = exitState.value;
      if (exited) {
        throw new Error(
          `tauri-webdriver exited during startup (code=${exited.code}, signal=${exited.signal}). ` +
            `See ${path.relative(process.cwd(), stderrPath)} for driver output.`,
        );
      }
      try {
        const res = await fetch(STATUS_URL, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) return;
      } catch {
        // not yet — keep polling
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(
      `tauri-webdriver did not become ready on ${STATUS_URL} within ${READY_TIMEOUT_MS}ms. ` +
        `See ${path.relative(process.cwd(), stderrPath)} for driver output.`,
    );
  })();

  try {
    await Promise.race([ready, spawnFailed]);
  } catch (err) {
    if (driver.exitCode === null && !driver.killed) driver.kill('SIGTERM');
    stdoutLog.end();
    stderrLog.end();
    throw err;
  }

  return async () => {
    if (driver.exitCode === null && !driver.killed) driver.kill('SIGTERM');
    stdoutLog.end();
    stderrLog.end();
  };
}
