import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildIframeSrcdoc } from '../../src/utils/iframe-srcdoc';

const readSource = (relativePath: string) =>
  readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('Windows WebView session startup regression', () => {
  it('retries the existing session request without repeatedly killing the app', () => {
    const source = readSource('e2e-webview/support/browser.ts');
    const newBrowser = source.slice(
      source.indexOf('export async function newBrowser'),
      source.indexOf('export function currentBrowser'),
    );

    expect(source).toContain('const WIN_SESSION_RETRY_COUNT = 6;');
    expect(newBrowser).toContain('connectionRetryCount: WIN_SESSION_RETRY_COUNT');
    expect(newBrowser.match(/await forceKillApp\(\)/g)).toHaveLength(1);
    expect(source).not.toContain('WIN_WINDOW_RACE');
    expect(newBrowser).not.toContain('warm-relaunching');
  });
});

describe('theme-aware scrollbar contract', () => {
  it('styles every app scroll surface in both themes with a transparent track', () => {
    const css = readSource('src/styles/main.css');
    const trackRule = css.match(/\*::-webkit-scrollbar-track,[\s\S]*?\{[\s\S]*?\}/)?.[0];

    expect(css.match(/--scrollbar-thumb:/g)).toHaveLength(2);
    expect(css.match(/--scrollbar-thumb-hover:/g)).toHaveLength(2);
    expect(css.match(/--scrollbar-thumb-active:/g)).toHaveLength(2);
    expect(css).toContain('scrollbar-color: var(--scrollbar-thumb) transparent');
    expect(css).toContain('scrollbar-width: thin');
    expect(css).toContain('*::-webkit-scrollbar-thumb:hover');
    expect(css).toContain('*::-webkit-scrollbar-thumb:active');
    expect(trackRule).toContain('background: transparent');
    expect(trackRule).not.toMatch(/white|#fff|255\s*,\s*255\s*,\s*255/i);
  });

  it('carries the same mode-specific scrollbar treatment into email iframes', () => {
    const light = buildIframeSrcdoc('<div>Light</div>', false);
    const dark = buildIframeSrcdoc('<div>Dark</div>', true);

    expect(light).toContain('<html class="fe-iframe-light">');
    expect(dark).toContain('<html class="fe-iframe-dark">');
    for (const document of [light, dark]) {
      expect(document).toContain('scrollbar-color: var(--fe-scrollbar-thumb) transparent');
      expect(document).toContain('*::-webkit-scrollbar-thumb:hover');
      expect(document).toContain('*::-webkit-scrollbar-thumb:active');
      expect(document).toContain('background: transparent !important');
    }
  });
});
