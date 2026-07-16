import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const screenshotScript = fs.readFileSync(
  path.resolve(process.cwd(), 'scripts/update-readme-screenshots.mjs'),
  'utf8',
);

describe('README screenshot stabilization', () => {
  it('waits for diagnostics probes to finish before capture', () => {
    expect(screenshotScript).toContain("case 'diagnostics':");
    expect(screenshotScript).toContain('document.querySelector(\'[role="status"]\') === null');
    expect(screenshotScript).toContain('timeout: 30_000');
  });

  it('removes retained SPA state and transient toasts before every capture', () => {
    expect(screenshotScript).toContain('#toasts-root');
    expect(screenshotScript).toContain('[data-testid="toast-list"]');
    expect(screenshotScript).toContain('globalThis.scrollTo(0, 0)');
    expect(screenshotScript).toContain('document.scrollingElement?.scrollTo(0, 0)');
  });
});
