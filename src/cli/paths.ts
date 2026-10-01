import os from 'node:os';
import path from 'node:path';

/**
 * Where the CLI keeps its state (the terminal equivalent of the browser's
 * origin storage). Follows each platform's convention and can be moved with
 * FORWARDEMAIL_HOME (or --data-dir, which sets it).
 */
export function getDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FORWARDEMAIL_HOME) return resolveUserPath(env.FORWARDEMAIL_HOME);

  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'forwardemail');
  }

  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'forwardemail');
  }

  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'forwardemail');
}

/** An absolute path, with a leading ~ meaning the home directory. */
export function resolveUserPath(value: string): string {
  return path.resolve(value.replace(/^~(?=$|[\\/])/, os.homedir()));
}
