import fs from 'node:fs';

/**
 * Hooks for working on the terminal client, all off unless their variable
 * is set. FORWARDEMAIL_DEBUG_DOM=<file> writes the document's markup to a
 * file every two seconds, for inspecting what the terminal is laying out.
 * FORWARDEMAIL_DEBUG_EXIT_AFTER=<ms> exits after a while, so profilers such
 * as --cpu-prof get to write their output.
 */
export function installDevHooks(env: { document: Document }) {
  // With FORWARDEMAIL_DEBUG, the log shows where keyboard focus goes.
  if (process.env.FORWARDEMAIL_DEBUG) {
    env.document.addEventListener('focusin', (event) => {
      const el = event.target as Element | null;
      console.debug('[focus]', el?.outerHTML?.slice(0, 160));
    });
  }
  const exitAfter = Number(process.env.FORWARDEMAIL_DEBUG_EXIT_AFTER);
  if (exitAfter > 0) setTimeout(() => process.exit(0), exitAfter).unref();

  const domFile = process.env.FORWARDEMAIL_DEBUG_DOM;
  if (domFile) {
    setInterval(() => {
      try {
        fs.writeFileSync(domFile, `<!DOCTYPE html>${env.document.documentElement.outerHTML}`);
      } catch {
        // ignore
      }
    }, 2000).unref();
  }
}
