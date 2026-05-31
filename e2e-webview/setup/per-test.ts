import { afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { currentBrowser } from '../support/browser.js';

const SCREENSHOT_DIR = path.resolve('./screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

afterEach(async (ctx) => {
  if (ctx.task.result?.state !== 'fail') return;
  const browser = currentBrowser();
  if (!browser) return;
  const safe = ctx.task.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);
  try {
    await browser.saveScreenshot(path.join(SCREENSHOT_DIR, `${safe}-${Date.now()}.png`));
  } catch {
    // Session may already be closed; don't mask the original failure.
  }
});
