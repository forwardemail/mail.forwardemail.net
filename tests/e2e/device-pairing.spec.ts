/**
 * QR device pairing, sender side, through a real canvas and a real optical
 * decode.
 *
 * This is the layer the unit tests structurally cannot reach: jsdom has no
 * canvas, so nothing below `encodeFrames` is exercised there. Here the app
 * paints an actual QR, jsQR reads it back out of the pixels, and the decoded
 * strings go through the real frame/seal/plan pipeline.
 *
 * It exists mainly to guard DENSITY. The symbol size was chosen from a measured
 * 60% decode rate on a physical phone, and it is quietly easy to regress -
 * growing the frame header by 13 bytes once pushed it from version 20 to 21
 * with nothing failing. A decode here is the cheap standing proof.
 *
 * jsQR is injected into the page rather than run in Node so only the decoded
 * string crosses the CDP boundary; shipping a 400x400 ImageData per frame is
 * needlessly slow. That injection needs bypassCSP, since the app serves
 * script-src 'self'.
 */
import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { setupAuthenticatedSession } from '../fixtures/calendar-helpers.js';
import { mockApi } from './mockApi.js';
import { FrameCollector, decodeFrame } from '../../src/utils/device-sync/frames';
import { openSealedBundle } from '../../src/utils/device-sync/seal';
import { unwrapSealKey } from '../../src/utils/device-sync/pairing-code';

const require = createRequire(import.meta.url);
const JSQR_PATH = require.resolve('jsqr/dist/jsQR.js');

/**
 * Settings opens on General; the pairing card lives beside App Lock and PGP
 * under Privacy & Security, so the section has to be selected first.
 */
async function openPairingSection(page: import('@playwright/test').Page) {
  await page.goto('/mailbox/settings');
  await page.getByRole('button', { name: 'Privacy & Security' }).click();
  const showButton = page.getByRole('button', { name: /show pairing code/i });
  await showButton.scrollIntoViewIfNeeded();
  return showButton;
}

const ACCOUNT = 'test@example.com';
const ARMORED_KEY =
  '-----BEGIN PGP PRIVATE KEY BLOCK-----\n' +
  'x'.repeat(600) +
  '\n-----END PGP PRIVATE KEY BLOCK-----';

// Argon2id at 256 MiB runs for over a second, and the sender does it before
// the code appears.
test.use({ bypassCSP: true });

test.describe('QR device pairing (sender)', () => {
  let signedOut = false;

  test.beforeEach(async ({ page }) => {
    signedOut = false;
    await setupAuthenticatedSession(page);
    await page.addInitScript(
      ({ account, key }) => {
        localStorage.setItem(
          `webmail_pgp_keys_${account}`,
          JSON.stringify([{ name: 'work', value: key }]),
        );
        localStorage.setItem(`webmail_pgp_passphrases_${account}`, JSON.stringify({ work: 'pw' }));
        localStorage.setItem('webmail_theme', 'dark');
      },
      { account: ACCOUNT, key: ARMORED_KEY },
    );
    // Anything mockApi does not cover would otherwise reach the real API and
    // 401, which trips auth recovery and drops the app back to the sign-in
    // screen mid-test. Registered BEFORE mockApi so its specific routes still
    // win - Playwright prefers the most recently added matching route.
    await page.route('**/api.forwardemail.net/**', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Result: [] }),
      }),
    );
    await mockApi(page);

    // If the app does sign itself out, fail with that fact rather than an
    // opaque timeout waiting for a control that will never appear.
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && new URL(frame.url()).pathname === '/') {
        signedOut = true;
      }
    });
  });

  test('renders a scannable code that round-trips through a real optical decode', async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const showButton = await openPairingSection(page);
    await showButton.click();

    // The sender derives an Argon2id key before painting anything.
    await expect(page.getByText(/expires in/i)).toBeVisible({ timeout: 60_000 });

    // Pin the code visible rather than simulating press-and-hold: the pointer
    // path is covered by the component tests, and this keeps the canvas painted
    // while frames are captured.
    expect(signedOut, 'the app signed itself out mid-test').toBe(false);
    await page.getByRole('checkbox', { name: /keep the code visible/i }).click();

    const pairingCode = (await page
      .getByText(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/)
      .textContent()) as string;
    expect(pairingCode).toMatch(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/);

    await page.addScriptTag({ path: JSQR_PATH });

    const collector = new FrameCollector();
    const seenVersions = new Set<number>();
    const deadline = Date.now() + 60_000;

    // The code animates when the payload needs more than one frame, so keep
    // sampling until every chunk has been seen.
    while (!collector.complete && Date.now() < deadline) {
      const result = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '[data-testid="pairing-qr-canvas"]',
        );
        if (!canvas) return null;
        const context = canvas.getContext('2d');
        if (!context) return null;
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const jsQR = (globalThis as unknown as { jsQR: (...args: unknown[]) => unknown }).jsQR;
        const found = jsQR(image.data, image.width, image.height) as {
          data: string;
          version: number;
        } | null;
        return found ? { data: found.data, version: found.version } : null;
      });

      if (result) {
        seenVersions.add(result.version);
        collector.accept(result.data);
      }
      await page.waitForTimeout(120);
    }

    expect(
      collector.complete,
      `never captured a full frame set (got ${collector.progress.received}/${collector.progress.total})`,
    ).toBe(true);

    // A `for ... of` over an empty set passes without checking anything, which
    // is precisely how the reveal test above once passed while reading a blank
    // canvas. Prove something was actually decoded before trusting the guard.
    expect(seenVersions.size, 'no QR symbol was ever decoded').toBeGreaterThan(0);

    // THE density guard. Version 20 is 97 modules, the density measured at a
    // 60% decode rate on a real phone. Going above it silently costs scan
    // reliability on hardware no test can see.
    for (const version of seenVersions) {
      expect(version, 'QR symbol grew past the measured-scannable density').toBeLessThanOrEqual(20);
    }

    // Every captured frame must parse as one of ours, and declare that a
    // pairing code is required.
    const assembled = collector.assemble();
    expect(assembled.codeProtected).toBe(true);

    // Full round trip: the code shown on screen must open what the QR carried.
    const sealKey = await unwrapSealKey(assembled.key, pairingCode, assembled.sessionSalt);
    const bundle = await openSealedBundle(assembled.sealed, sealKey);

    expect(bundle.account?.email).toBe(ACCOUNT);
    expect(bundle.pgp?.keys?.[0]?.value).toBe(ARMORED_KEY);
    expect(bundle.pgp?.passphrases?.work).toBe('pw');
    expect(bundle.settings?.theme).toBe('dark');
  });

  test('keeps the code out of the pixels until it is revealed', async ({ page }) => {
    test.setTimeout(120_000);

    const showButton = await openPairingSection(page);
    await showButton.click();
    await expect(page.getByText(/expires in/i)).toBeVisible({ timeout: 60_000 });

    await page.addScriptTag({ path: JSQR_PATH });

    const readCanvas = () =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '[data-testid="pairing-qr-canvas"]',
        );
        if (!canvas) return { found: 'no-canvas' as const };
        const context = canvas.getContext('2d');
        if (!context) return { found: 'no-context' as const };
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        const jsQR = (globalThis as unknown as { jsQR: (...args: unknown[]) => unknown }).jsQR;
        const result = jsQR(image.data, image.width, image.height) as { data: string } | null;
        return { found: result ? result.data : null, pixels: image.width * image.height };
      });

    const hidden = await readCanvas();
    expect(hidden.found, 'the pairing payload was readable before it was revealed').toBeNull();

    // Reveal, and require the SAME canvas to decode. Without this the check
    // above passes against any blank canvas - which is exactly how an earlier
    // version of this test passed while reading the wrong element entirely.
    expect(signedOut, 'the app signed itself out mid-test').toBe(false);
    await page.getByRole('checkbox', { name: /keep the code visible/i }).click();
    await expect.poll(async () => (await readCanvas()).found, { timeout: 15_000 }).not.toBeNull();

    const revealed = await readCanvas();
    expect(decodeFrame(revealed.found as string)).not.toBeNull();
  });
});
