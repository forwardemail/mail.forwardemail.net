import { describe, expect, it } from 'vitest';

import {
  buildScreenshotGallery,
  isIgnorableScreenshotRuntimeError,
  replaceScreenshotGallery,
} from '../../scripts/update-readme-screenshots.mjs';
import { buildTableOfContents, updateTableOfContents } from '../../scripts/update-readme-toc.mjs';

const screenshotMarkers = `# Project

## Screenshots

<!-- readme-screenshots:start -->

old gallery

<!-- readme-screenshots:end -->

## Security

Keep **this formatting** unchanged.
`;

describe('README screenshot automation', () => {
  it('groups screenshots into four collapsible theme and device sections', () => {
    const gallery = buildScreenshotGallery('July 14, 2026', [
      { id: 'login', kind: 'login', label: 'login page' },
    ]);

    expect(gallery.match(/<details>/g)).toHaveLength(4);
    expect(gallery.match(/<\/details>/g)).toHaveLength(4);
    expect(gallery).toContain('<strong>Dark mode — Desktop</strong>');
    expect(gallery).toContain('<strong>Dark mode — Mobile</strong>');
    expect(gallery).toContain('<strong>Light mode — Desktop</strong>');
    expect(gallery).toContain('<strong>Light mode — Mobile</strong>');
    expect(gallery).toContain('docs/screenshots/desktop/login-dark.jpg');
    expect(gallery).toContain('docs/screenshots/mobile/login-light.jpg');
    expect(gallery).toContain('**Screenshots as of July 14, 2026.**');
    expect(gallery).not.toContain('### Screenshots as of');
  });

  it('ignores only the expected sandboxed message-frame service-worker exception', () => {
    expect(
      isIgnorableScreenshotRuntimeError(
        new Error(
          "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag.",
        ),
      ),
    ).toBe(true);
    expect(
      isIgnorableScreenshotRuntimeError(
        new Error(
          "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.",
        ),
      ),
    ).toBe(true);
    expect(
      isIgnorableScreenshotRuntimeError(
        new TypeError('Failed to resolve module specifier "@tauri-apps/api/core".'),
      ),
    ).toBe(false);
  });

  it('replaces only the generated screenshot marker block', () => {
    const gallery = buildScreenshotGallery('July 14, 2026', [
      { id: 'login', kind: 'login', label: 'login page' },
    ]);
    const updated = replaceScreenshotGallery(screenshotMarkers, gallery);

    expect(updated).toContain(gallery);
    expect(updated).not.toContain('old gallery');
    expect(updated).toContain('Keep **this formatting** unchanged.');
    expect(updated.split('<!-- readme-screenshots:start -->')).toHaveLength(2);
    expect(updated.split('<!-- readme-screenshots:end -->')).toHaveLength(2);
  });
});

describe('README table-of-contents automation', () => {
  it('builds GitHub-compatible nested links and ignores fenced headings', () => {
    const readme = `# Project

## Table of Contents

## Alpha & Beta

### Child

## Alpha & Beta

\`\`\`md
## Not a heading
\`\`\`
`;

    expect(buildTableOfContents(readme)).toBe(
      [
        '- [Alpha & Beta](#alpha--beta)',
        '  - [Child](#child)',
        '- [Alpha & Beta](#alpha--beta-1)',
      ].join('\n'),
    );
  });

  it('updates only the generated TOC marker block', () => {
    const readme = `# Project

## Table of Contents

<!-- readme-toc:start -->

stale

<!-- readme-toc:end -->

## Screenshots

Paragraph with  double spaces and **formatting**.
`;
    const updated = updateTableOfContents(readme);

    expect(updated).toContain('- [Screenshots](#screenshots)');
    expect(updated).not.toContain('stale');
    expect(updated).toContain('Paragraph with  double spaces and **formatting**.');
  });
});
