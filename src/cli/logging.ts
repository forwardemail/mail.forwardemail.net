import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

/**
 * In a browser the console is a developer tool; in a terminal it would write
 * over the interface. While the app runs, console output goes to a log file
 * when FORWARDEMAIL_DEBUG is set, and nowhere otherwise.
 */
export function redirectConsole(dataDir: string, enabled: boolean): string | null {
  const methods = ['log', 'info', 'debug', 'warn', 'error', 'trace', 'dir', 'table'] as const;
  if (!enabled) {
    for (const method of methods)
      (console as unknown as Record<string, unknown>)[method] = () => {};
    return null;
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'forwardemail.log');
  const fd = fs.openSync(file, 'a', 0o600);
  for (const method of methods) {
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      const line = `${new Date().toISOString()} ${method.toUpperCase()} ${format(...args)}\n`;
      try {
        fs.writeSync(fd, line);
      } catch {
        // ignore
      }
    };
  }
  return file;
}
