import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const screenshotWorkflow = readFileSync(
  join(repositoryRoot, '.github/workflows/readme-screenshots.yml'),
  'utf8',
);
const releaseWorkflow = readFileSync(join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
const screenshotScript = readFileSync(
  join(repositoryRoot, 'scripts/update-readme-screenshots.mjs'),
  'utf8',
);
const releaseAssetPublisher = join(repositoryRoot, 'scripts/publish-release-screenshots.sh');

describe('release screenshot workflow', () => {
  it('is a required release stage that captures from the exact release revision', () => {
    expect(screenshotWorkflow).toContain('workflow_call:');
    expect(screenshotWorkflow).not.toContain('workflow_run:');
    expect(screenshotWorkflow).toContain('ref: ${{ inputs.source_ref }}');
    expect(screenshotWorkflow).toContain('pnpm screenshots:readme "${args[@]}"');
    expect(screenshotWorkflow).not.toContain('pnpm screenshots:readme --');
    expect(screenshotWorkflow).not.toContain('continue-on-error:');

    expect(releaseWorkflow).toContain('release-screenshots:');
    expect(releaseWorkflow).toContain('uses: ./.github/workflows/readme-screenshots.yml');
    expect(releaseWorkflow).toContain("base_url: 'https://mail.forwardemail.net'");
    expect(releaseWorkflow).toContain('source_ref: ${{ github.sha }}');
    expect(releaseWorkflow).toContain('release-screenshots:$SHOTS');
    expect(releaseWorkflow).toContain("needs.release-screenshots.result == 'success'");
  });

  it('publishes the complete tracked screenshot set through README.md', () => {
    expect(screenshotWorkflow).toContain("screenshot_root='docs/screenshots'");
    expect(screenshotWorkflow).toContain('Expected 64 screenshots');
    expect(screenshotWorkflow).toContain('<!-- readme-screenshots:start -->');
    expect(screenshotWorkflow).toContain('<!-- readme-screenshots:end -->');
    expect(screenshotWorkflow).toContain('README does not reference $image');
    expect(screenshotWorkflow).toContain('Expected 64 unique README screenshot references');
    expect(screenshotWorkflow).toContain('git status --porcelain -- README.md docs/screenshots');
    expect(screenshotWorkflow).toContain('git add README.md docs/screenshots');
    expect(screenshotWorkflow).toContain('git rebase origin/main');
    expect(screenshotWorkflow).toContain('git push origin HEAD:main');

    expect(screenshotScript).toContain("const DEFAULT_OUTPUT_DIRECTORY = 'docs/screenshots'");
    expect(screenshotScript).toContain('replaceScreenshotGallery');
    expect(screenshotScript).toContain('pnpm screenshots:readme [options]');
    expect(screenshotScript).not.toContain('pnpm screenshots:readme -- [options]');
  });

  it('formats generated README Markdown before validation and commit', () => {
    const generationIndex = screenshotWorkflow.indexOf('pnpm screenshots:readme "${args[@]}"');
    const formattingIndex = screenshotWorkflow.indexOf('pnpm exec prettier README.md --write');
    const validationIndex = screenshotWorkflow.indexOf(
      '- name: Validate the complete README screenshot set',
    );
    const changeDetectionIndex = screenshotWorkflow.indexOf(
      'git status --porcelain -- README.md docs/screenshots',
    );
    const stagingIndex = screenshotWorkflow.indexOf('git add README.md docs/screenshots');

    expect(screenshotWorkflow).toContain(
      '- name: Format generated README Markdown\n        if: ${{ !inputs.dry_run }}',
    );
    expect(generationIndex).toBeGreaterThanOrEqual(0);
    expect(formattingIndex).toBeGreaterThan(generationIndex);
    expect(validationIndex).toBeGreaterThan(formattingIndex);
    expect(changeDetectionIndex).toBeGreaterThan(formattingIndex);
    expect(stagingIndex).toBeGreaterThan(changeDetectionIndex);
  });

  it('does not publish screenshots as Actions or GitHub Release assets', () => {
    expect(screenshotWorkflow).not.toContain('actions/upload-artifact');
    expect(screenshotWorkflow).not.toContain('gh release');
    expect(screenshotWorkflow).not.toContain('uploads.github.com');
    expect(screenshotWorkflow).not.toContain('SHA256SUMS.txt');
    expect(screenshotWorkflow).not.toContain('Forward-Email-screenshots');
    expect(releaseWorkflow).not.toContain('release_tag:');
    expect(existsSync(releaseAssetPublisher)).toBe(false);
  });
});
