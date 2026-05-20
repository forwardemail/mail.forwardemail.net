import path from 'node:path';
import fs from 'node:fs';

const CRATE = 'forwardemail-desktop';

export function resolveAppBinary(): string {
  if (process.env.TAURI_E2E_BINARY) {
    return path.resolve(process.env.TAURI_E2E_BINARY);
  }

  const target = process.env.TAURI_TARGET;
  const repoRoot = path.resolve(process.cwd(), '..');
  const binaryName = process.platform === 'win32' ? `${CRATE}.exe` : CRATE;

  // Cargo writes to target/<triple>/debug when --target is passed and the
  // triple differs from the host. On some CI configurations (notably the
  // macos-15-intel runner with --target x86_64-apple-darwin matching the
  // host triple) the output lands at target/debug instead. Probe both.
  const candidates = [
    ...(target ? [path.join(repoRoot, 'src-tauri', 'target', target, 'debug', binaryName)] : []),
    path.join(repoRoot, 'src-tauri', 'target', 'debug', binaryName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    [
      `Tauri debug binary not found. Searched:`,
      ...candidates.map((c) => `  - ${c}`),
      `Build it first from the repo root:`,
      `  pnpm tauri build --debug --no-bundle --features webdriver${target ? ` --target ${target}` : ''}`,
      `(plain "cargo build" produces a binary with no embedded frontendDist —`,
      ` use the tauri CLI so index.html is registered.)`,
      `Or set TAURI_E2E_BINARY to an explicit path.`,
    ].join('\n'),
  );
}
