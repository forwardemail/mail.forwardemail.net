#!/usr/bin/env node

import { chromium, devices } from '@playwright/test';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SCREENSHOTS_START = '<!-- readme-screenshots:start -->';
const SCREENSHOTS_END = '<!-- readme-screenshots:end -->';
const DEFAULT_BASE_URL = 'https://mail.forwardemail.net';
const DEFAULT_OUTPUT_DIRECTORY = 'docs/screenshots';
const DEFAULT_PREVIEW_DIRECTORY = '.readme-screenshot-preview';
const DEFAULT_TIMEOUT = 20_000;

const themes = [
  { id: 'dark', label: 'Dark mode' },
  { id: 'light', label: 'Light mode' },
];

const profiles = [
  {
    id: 'desktop',
    label: 'Desktop',
    context: {
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    },
  },
  {
    id: 'mobile',
    label: 'Mobile',
    context: {
      ...devices['iPhone 13'],
      deviceScaleFactor: 2,
    },
  },
];

const settingsSections = [
  { id: 'general', label: 'general settings page' },
  { id: 'appearance', label: 'appearance settings page' },
  { id: 'privacy', label: 'privacy and security page' },
  { id: 'folders', label: 'folders and labels settings page' },
  { id: 'search', label: 'search settings page' },
  { id: 'advanced', label: 'advanced settings page' },
  { id: 'shortcuts', label: 'keyboard shortcuts page' },
  { id: 'help', label: 'about and help page' },
];

const views = [
  { id: 'login', label: 'login page', kind: 'login' },
  { id: 'mail', label: 'mail view', kind: 'mailbox' },
  { id: 'message', label: 'message view', kind: 'message' },
  { id: 'compose', label: 'compose window', kind: 'compose' },
  { id: 'contacts', label: 'contacts page', kind: 'contacts' },
  { id: 'calendar', label: 'calendar page', kind: 'calendar' },
  { id: 'profile', label: 'profile page', kind: 'profile' },
  { id: 'diagnostics', label: 'diagnostics page', kind: 'diagnostics' },
  ...settingsSections.map((section) => ({
    id: `settings-${section.id}`,
    label: section.label,
    kind: 'settings',
    section: section.id,
  })),
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function usage() {
  return `Update the README screenshot gallery from a live Forward Email Mail deployment.

Usage:
  pnpm screenshots:readme -- [options]

Options:
  --base-url <url>          Deployment to capture (default: ${DEFAULT_BASE_URL})
  --date <Month D, YYYY>    Caption date (default: current UTC date)
  --dry-run                 Write an untracked preview without changing README or docs/screenshots
  --preview-dir <path>      Dry-run output directory (default: ${DEFAULT_PREVIEW_DIRECTORY})
  --soft-fail               Exit successfully without tracked changes if validation or capture fails
  --health-attempts <n>     Deployment health-check attempts (default: 12)
  --health-delay-ms <n>     Delay between health checks (default: 10000)
  --help                    Show this help text
`;
}

export function formatCaptionDate(date = new Date(), timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'long',
    timeZone,
    year: 'numeric',
  }).format(date);
}

function validateCaptionDate(value) {
  if (!/^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(value)) {
    throw new Error(`Invalid --date value "${value}"; expected "Month D, YYYY"`);
  }

  return value;
}

function validateBaseUrl(value) {
  const url = new URL(value);
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);

  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    throw new Error('The base URL must use HTTPS, except for localhost development URLs');
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

function parsePositiveInteger(value, optionName) {
  const number = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${optionName} must be a positive integer`);
  }

  return number;
}

function captionFor(profile, theme, view) {
  const viewport = profile.id === 'mobile' ? 'mobile ' : '';
  return `${theme.label} ${viewport}${view.label}`;
}

function imagePathFor(profile, theme, view) {
  return `${DEFAULT_OUTPUT_DIRECTORY}/${profile.id}/${view.id}-${theme.id}.jpg`;
}

export function buildScreenshotGallery(date, manifest = views) {
  const lines = [
    `**Screenshots as of ${date}.**`,
    '',
    'These screenshots are captured automatically from the production Demo Account after each successful release. Expand a theme and device group to browse its views.',
    '',
  ];

  for (const theme of themes) {
    for (const profile of profiles) {
      lines.push(
        '<details>',
        `<summary><strong>${theme.label} — ${profile.label}</strong></summary>`,
        '',
        '| View | Screenshot |',
        '| :--- | :---: |',
      );

      for (const view of manifest) {
        const caption = captionFor(profile, theme, view);
        lines.push(`| ${view.label} | ![${caption}](${imagePathFor(profile, theme, view)}) |`);
      }

      lines.push('', '</details>', '');
    }
  }

  return lines.join('\n').trimEnd();
}

export function replaceScreenshotGallery(readme, gallery) {
  const startIndex = readme.indexOf(SCREENSHOTS_START);
  const endIndex = readme.indexOf(SCREENSHOTS_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error('README screenshot markers are missing or out of order');
  }

  if (readme.indexOf(SCREENSHOTS_START, startIndex + SCREENSHOTS_START.length) !== -1) {
    throw new Error('README contains more than one screenshot start marker');
  }

  const before = readme.slice(0, startIndex + SCREENSHOTS_START.length);
  const after = readme.slice(endIndex);
  return `${before}\n\n${gallery}\n\n${after}`;
}

async function probeDeployment(baseUrl, attempts, delayMilliseconds) {
  let lastError;
  const entryUrl = new URL('/index.html', baseUrl);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(entryUrl, {
        headers: { 'user-agent': 'ForwardEmail-README-Screenshot-Bot/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        throw new Error(`unexpected content type "${contentType}"`);
      }

      const body = await response.text();
      if (
        !body ||
        /(?:404|page not found|internal server error|bad gateway)/i.test(body.slice(0, 2_000))
      ) {
        throw new Error('deployment returned an error document');
      }

      console.log(`Deployment health check passed on attempt ${attempt}`);
      return;
    } catch (error) {
      lastError = error;
      console.warn(`Deployment health check ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) await sleep(delayMilliseconds);
    }
  }

  throw new Error(`Deployment health check failed: ${lastError?.message || 'unknown error'}`);
}

async function assertPageIsHealthy(page, label) {
  await page.locator('body').waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

  const state = await page.evaluate(() => ({
    bodyText: document.body?.innerText?.slice(0, 4_000) || '',
    title: document.title,
  }));
  const prominentText = await page.locator('h1, h2, [role="alert"]').allTextContents();
  const errorText = [state.title, ...prominentText].join(' ');

  if (
    /\b(?:404|page not found|internal server error|bad gateway|service unavailable)\b/i.test(
      errorText,
    )
  ) {
    throw new Error(`${label} rendered an error page: ${errorText.slice(0, 300)}`);
  }

  if (!state.bodyText.trim()) {
    throw new Error(`${label} rendered an empty page`);
  }
}

async function navigate(page, baseUrl, pathname, label) {
  const baseOrigin = new URL(baseUrl).origin;

  if (page.url() === 'about:blank') {
    const entryUrl = new URL('/index.html', baseOrigin);
    const response = await page.goto(entryUrl.href, {
      timeout: DEFAULT_TIMEOUT,
      // A committed response is sufficient here. The subsequent view-specific
      // selector waits verify that the SPA has finished rendering without
      // coupling release automation to a transient DOMContentLoaded delay.
      waitUntil: 'commit',
    });

    if (!response) {
      throw new Error(`${label} did not return a navigation response`);
    }

    if (response.status() >= 400) {
      throw new Error(`${label} returned HTTP ${response.status()}`);
    }

    if (pathname === '/') {
      await page.getByTestId('try-demo-btn').waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT,
      });
      await assertPageIsHealthy(page, label);
      return;
    }

    await assertPageIsHealthy(page, label);
  }

  const target = new URL(pathname, baseOrigin);
  if (target.origin !== baseOrigin) {
    throw new Error(`${label} resolved outside the configured deployment origin`);
  }

  await page.evaluate((targetPath) => {
    const previousHash = globalThis.location.hash;
    const previousHref = globalThis.location.href;
    globalThis.history.pushState({}, '', targetPath);

    if (globalThis.location.hash !== previousHash) {
      globalThis.dispatchEvent(
        new HashChangeEvent('hashchange', {
          oldURL: previousHref,
          newURL: globalThis.location.href,
        }),
      );
    }

    globalThis.dispatchEvent(new PopStateEvent('popstate'));
  }, `${target.pathname}${target.search}${target.hash}`);

  await page.waitForURL(target.href, { timeout: DEFAULT_TIMEOUT });
  await assertPageIsHealthy(page, label);
}

async function waitForFonts(page) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
  });
}

async function stabilizePage(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
      #toasts-root, [data-testid="toast-list"],
      [data-sonner-toaster], .svelte-sonner-toaster { display: none !important; }
    `,
  });
  await page.evaluate(() => {
    globalThis.scrollTo(0, 0);
    document.scrollingElement?.scrollTo(0, 0);
    for (const element of document.querySelectorAll('*')) {
      if (element.scrollTop !== 0) element.scrollTop = 0;
      if (element.scrollLeft !== 0) element.scrollLeft = 0;
    }
  });
  await waitForFonts(page);
  await page.waitForTimeout(250);
}

async function waitForMailbox(page) {
  await page
    .locator('[data-conversation-row], .fe-message-list-wrapper, .fe-mailbox-wrapper')
    .first()
    .waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
}

async function enterDemoAccount(page) {
  const demoButton = page.getByTestId('try-demo-btn');
  await demoButton.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
  await demoButton.click();
  await page.waitForURL(/\/mailbox(?:$|[/?#])/, { timeout: DEFAULT_TIMEOUT });
  await waitForMailbox(page);
  await assertPageIsHealthy(page, 'Demo Account mailbox');
}

async function openCompose(page, isMobile) {
  await navigate(page, page.url(), '/mailbox#INBOX', 'mailbox');
  await waitForMailbox(page);

  const candidates = isMobile
    ? [
        page.locator('.fe-mobile-tab', { hasText: 'Compose' }).first(),
        page.getByLabel('Compose').first(),
        page.getByRole('button', { name: /^Compose$/i }).first(),
      ]
    : [
        page.locator('[data-testid="compose-button"]').first(),
        page.getByRole('button', { name: /^Compose$/i }).first(),
        page.getByLabel('Compose').first(),
      ];

  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      await page.getByPlaceholder('To', { exact: true }).waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT,
      });
      return;
    }
  }

  // The desktop sidebar remains mounted behind the mobile reader. Invoking its
  // stable test control provides the same compose action when responsive
  // navigation has not finished reappearing after a message transition.
  const composeButton = page.locator('[data-testid="compose-button"]').first();
  if ((await composeButton.count()) > 0) {
    await composeButton.evaluate((button) => button.click());
    await page.getByPlaceholder('To', { exact: true }).waitFor({
      state: 'visible',
      timeout: DEFAULT_TIMEOUT,
    });
    return;
  }

  throw new Error('No Compose control was found');
}

async function prepareView(page, baseUrl, view, isMobile) {
  switch (view.kind) {
    case 'mailbox': {
      await navigate(page, baseUrl, '/mailbox#INBOX', 'mailbox');
      await waitForMailbox(page);
      break;
    }
    case 'message': {
      await navigate(page, baseUrl, '/mailbox#INBOX', 'mailbox');
      await waitForMailbox(page);
      const firstMessage = page.locator('[data-conversation-row]').first();
      await firstMessage.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await firstMessage.click();
      await page
        .locator(isMobile ? '.mobile-reader .fe-reader, .fe-reader' : '.fe-reader')
        .first()
        .waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      break;
    }
    case 'compose': {
      await openCompose(page, isMobile);
      break;
    }
    case 'contacts': {
      await navigate(page, baseUrl, '/contacts', 'contacts');
      const list = page.locator('[data-testid="contact-list"]');
      await list.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="contact-list"]')?.getAttribute('data-loading') ===
          'false',
        undefined,
        { timeout: DEFAULT_TIMEOUT },
      );
      break;
    }
    case 'calendar': {
      await navigate(page, baseUrl, '/calendar', 'calendar');
      await page
        .locator('[data-testid="calendar-ready"]')
        .waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });
      break;
    }
    case 'profile': {
      await navigate(page, baseUrl, '/mailbox/profile', 'profile');
      await page.getByText('Profile', { exact: true }).first().waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT,
      });
      break;
    }
    case 'diagnostics': {
      await navigate(page, baseUrl, '/mailbox/diagnostics', 'diagnostics');
      await page.getByText('Diagnostics', { exact: true }).first().waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT,
      });
      await page.getByRole('button', { name: 'Run again' }).waitFor({
        state: 'visible',
        timeout: DEFAULT_TIMEOUT,
      });
      await page.waitForFunction(
        () => document.querySelector('[role="status"]') === null,
        undefined,
        { timeout: 30_000 },
      );
      break;
    }
    case 'settings': {
      await navigate(page, baseUrl, `/mailbox/settings#${view.section}`, view.label);
      await page.waitForFunction(
        (section) => globalThis.location.hash === `#${section}`,
        view.section,
        {
          timeout: DEFAULT_TIMEOUT,
        },
      );
      const sectionLabel = settingsSections.find((entry) => entry.id === view.section)?.label;
      const visibleLabel = sectionLabel
        ?.replace('privacy and security page', 'Privacy & Security')
        .replace('folders and labels settings page', 'Folders & Labels')
        .replace('keyboard shortcuts page', 'Keyboard Shortcuts')
        .replace('about and help page', 'About & Help')
        .replace(' settings page', '')
        .replace(' page', '');
      if (visibleLabel) {
        const normalizedLabel = visibleLabel.replace(/^./, (character) => character.toUpperCase());
        const sectionButton = page
          .locator('aside button')
          .filter({ hasText: normalizedLabel })
          .first();
        await sectionButton.waitFor({ state: 'attached', timeout: DEFAULT_TIMEOUT });
        await sectionButton.evaluate((button) => button.click());
        await page.waitForFunction(
          (section) => globalThis.location.hash === `#${section}`,
          view.section,
          { timeout: DEFAULT_TIMEOUT },
        );
      }
      break;
    }
    default:
      throw new Error(`Unsupported screenshot view: ${view.kind}`);
  }

  await assertPageIsHealthy(page, view.label);
}

async function captureScreenshot(page, outputFile, caption) {
  await stabilizePage(page);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await page.screenshot({
    animations: 'disabled',
    fullPage: false,
    path: outputFile,
    quality: 82,
    type: 'jpeg',
  });
  const stats = await fs.stat(outputFile);
  if (stats.size < 10_000) {
    throw new Error(`${caption} screenshot is unexpectedly small (${stats.size} bytes)`);
  }
}

async function captureProfileTheme(browser, options, profile, theme, imageRoot) {
  const context = await browser.newContext({
    ...profile.context,
    colorScheme: theme.id,
    locale: 'en-US',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    timezoneId: options.timeZone,
  });
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem('webmail_theme', selectedTheme);
  }, theme.id);

  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT);

  try {
    await navigate(page, options.baseUrl, '/', 'login page');
    const demoButton = page.getByTestId('try-demo-btn');
    await demoButton.waitFor({ state: 'visible', timeout: DEFAULT_TIMEOUT });

    const loginView = views.find((view) => view.kind === 'login');
    const loginCaption = captionFor(profile, theme, loginView);
    await captureScreenshot(
      page,
      path.join(imageRoot, profile.id, `${loginView.id}-${theme.id}.jpg`),
      loginCaption,
    );
    console.log(`Captured ${loginCaption}`);

    await enterDemoAccount(page);

    for (const view of views.filter((entry) => entry.kind !== 'login')) {
      await prepareView(page, options.baseUrl, view, profile.id === 'mobile');
      const caption = captionFor(profile, theme, view);
      await captureScreenshot(
        page,
        path.join(imageRoot, profile.id, `${view.id}-${theme.id}.jpg`),
        caption,
      );
      console.log(`Captured ${caption}`);
    }
  } finally {
    await context.close();
  }
}

async function verifyCaptureSet(imageRoot) {
  const expected = [];
  for (const profile of profiles) {
    for (const theme of themes) {
      for (const view of views) {
        expected.push(path.join(imageRoot, profile.id, `${view.id}-${theme.id}.jpg`));
      }
    }
  }

  const missing = [];
  for (const file of expected) {
    try {
      const stats = await fs.stat(file);
      if (!stats.isFile() || stats.size < 10_000) missing.push(file);
    } catch {
      missing.push(file);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Capture set is incomplete; ${missing.length} required screenshot(s) are missing`,
    );
  }

  return expected.length;
}

async function copyDirectory(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.cp(source, destination, { recursive: true });
}

async function publishTrackedChanges(
  root,
  temporaryImages,
  generatedReadme,
  outputDirectory,
  readmePath,
) {
  const backupDirectory = path.join(root, `.readme-screenshots-backup-${process.pid}`);
  const previousReadme = await fs.readFile(readmePath, 'utf8');
  let hadPreviousImages = false;

  try {
    try {
      await fs.access(outputDirectory);
      hadPreviousImages = true;
      await copyDirectory(outputDirectory, backupDirectory);
    } catch {
      // The first successful release has no existing screenshot directory.
    }

    await fs.rm(outputDirectory, { force: true, recursive: true });
    await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
    await fs.rename(temporaryImages, outputDirectory);
    await fs.writeFile(readmePath, generatedReadme);
  } catch (error) {
    await fs.writeFile(readmePath, previousReadme);
    await fs.rm(outputDirectory, { force: true, recursive: true });
    if (hadPreviousImages) await fs.rename(backupDirectory, outputDirectory);
    throw error;
  } finally {
    await fs.rm(backupDirectory, { force: true, recursive: true });
  }
}

async function run() {
  const { values } = parseArgs({
    options: {
      'base-url': { default: process.env.SCREENSHOT_BASE_URL || DEFAULT_BASE_URL, type: 'string' },
      date: { type: 'string' },
      'dry-run': { default: false, type: 'boolean' },
      help: { default: false, type: 'boolean' },
      'health-attempts': { default: '12', type: 'string' },
      'health-delay-ms': { default: '10000', type: 'string' },
      'preview-dir': { default: DEFAULT_PREVIEW_DIRECTORY, type: 'string' },
      'soft-fail': { default: false, type: 'boolean' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(usage());
    return;
  }

  const root = process.cwd();
  const readmePath = path.join(root, 'README.md');
  const outputDirectory = path.join(root, DEFAULT_OUTPUT_DIRECTORY);
  const temporaryRoot = path.join(root, `.readme-screenshots-tmp-${process.pid}`);
  const temporaryImages = path.join(temporaryRoot, 'images');
  const timeZone = process.env.SCREENSHOT_TIME_ZONE || 'UTC';
  const options = {
    baseUrl: validateBaseUrl(values['base-url']),
    captionDate: validateCaptionDate(values.date || formatCaptionDate(new Date(), timeZone)),
    dryRun: values['dry-run'],
    healthAttempts: parsePositiveInteger(values['health-attempts'], '--health-attempts'),
    healthDelayMilliseconds: parsePositiveInteger(values['health-delay-ms'], '--health-delay-ms'),
    previewDirectory: path.resolve(root, values['preview-dir']),
    softFail: values['soft-fail'],
    timeZone,
  };

  let browser;

  try {
    await fs.access(readmePath);
    await probeDeployment(options.baseUrl, options.healthAttempts, options.healthDelayMilliseconds);
    await fs.mkdir(temporaryImages, { recursive: true });
    browser = await chromium.launch({ headless: true });

    for (const profile of profiles) {
      for (const theme of themes) {
        await captureProfileTheme(browser, options, profile, theme, temporaryImages);
      }
    }

    const screenshotCount = await verifyCaptureSet(temporaryImages);
    const readme = await fs.readFile(readmePath, 'utf8');
    const gallery = buildScreenshotGallery(options.captionDate);
    const generatedReadme = replaceScreenshotGallery(readme, gallery);

    if (options.dryRun) {
      await fs.rm(options.previewDirectory, { force: true, recursive: true });
      await copyDirectory(
        temporaryImages,
        path.join(options.previewDirectory, DEFAULT_OUTPUT_DIRECTORY),
      );
      await fs.writeFile(path.join(options.previewDirectory, 'README.md'), generatedReadme);
      console.log(`Dry run captured ${screenshotCount} screenshots.`);
      console.log(`Preview written to ${path.relative(root, options.previewDirectory) || '.'}`);
      return;
    }

    await publishTrackedChanges(
      root,
      temporaryImages,
      generatedReadme,
      outputDirectory,
      readmePath,
    );
    console.log(
      `Updated README.md and ${DEFAULT_OUTPUT_DIRECTORY} with ${screenshotCount} screenshots.`,
    );
  } catch (error) {
    const prefix = options.softFail ? 'Screenshot update skipped' : 'Screenshot update failed';
    console.error(`${prefix}: ${error.stack || error.message}`);
    if (!options.softFail) throw error;
  } finally {
    if (browser) await browser.close();
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
