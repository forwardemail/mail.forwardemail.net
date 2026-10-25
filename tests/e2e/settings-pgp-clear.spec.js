import { expect, test } from '@playwright/test';
import * as openpgp from 'openpgp';
import { setupAuthenticatedMailbox, isMobileProject } from '../fixtures/mailbox-helpers.js';
import {
  ACCOUNT,
  buildMessage,
  installMailServer,
  installMockSocket,
  openMailbox,
} from '../fixtures/state-helpers.js';

// "Clear saved data" under PGP encryption removes this account's saved keys
// and passphrases. Builds before 0.15.0 cleared all of local storage instead,
// which signed the user out (and dropped every setting), keys or no keys.

const KEY_NAME = 'Synthetic test key';
const KEYS_ITEM = `webmail_pgp_keys_${ACCOUNT}`;
const PASSPHRASES_ITEM = `webmail_pgp_passphrases_${ACCOUNT}`;

// A synthetic encrypted message (not decryptable: there is no key)
const PGP_RAW = [
  'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
  'From: Sender <sender@example.org>',
  `To: ${ACCOUNT}`,
  'Subject: Encrypted',
  'MIME-Version: 1.0',
  '',
  '--b',
  'Content-Type: application/pgp-encrypted',
  '',
  'Version: 1',
  '--b',
  'Content-Type: application/octet-stream',
  '',
  '-----BEGIN PGP MESSAGE-----',
  '',
  'hQEMA0dummydummydummyAQf/dummy',
  '=abcd',
  '-----END PGP MESSAGE-----',
  '--b--',
].join('\r\n');

const storedItems = (page) => page.evaluate(() => ({ ...localStorage, ...sessionStorage }));

async function openPrivacy(page) {
  await page.goto('/mailbox/settings#privacy');
  await expect(page.getByRole('button', { name: 'Clear saved data' })).toBeVisible({
    timeout: 15_000,
  });
}

async function expectStillSignedIn(page, before) {
  await expect(page).toHaveURL(/\/mailbox\/settings#privacy$/);
  await expect(page.locator('#login-root')).toBeHidden();
  const after = await storedItems(page);
  const lost = Object.keys(before).filter(
    (k) => !(k in after) && k !== KEYS_ITEM && k !== PASSPHRASES_ITEM,
  );
  expect(lost).toEqual([]);
  // and still signed in after a reload
  await page.reload();
  await expect(page.getByRole('button', { name: 'Clear saved data' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#login-root')).toBeHidden();
}

test.describe('PGP "Clear saved data"', () => {
  let server;

  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop settings layout');
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    server = await installMailServer(page, {
      messages: Array.from({ length: 3 }, (_, i) => buildMessage(i + 1)),
      detailBody: () => ({ raw: PGP_RAW, nodemailer: null }),
    });
  });

  test('with no keys saved, keeps the session and says there was nothing to clear', async ({
    page,
  }) => {
    await openPrivacy(page);
    const before = await storedItems(page);

    await page.getByRole('button', { name: 'Clear saved data' }).click();

    await expect(page.getByText('No encryption keys are saved on this device.')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expectStillSignedIn(page, before);
  });

  test('with keys saved, asks first, then removes only the keys', async ({ page }) => {
    await openPrivacy(page);
    await page.evaluate(
      ({ keys, passphrases, name }) => {
        localStorage.setItem(keys, JSON.stringify([{ name, value: 'not a real key' }]));
        localStorage.setItem(passphrases, JSON.stringify({ [name]: 'synthetic' }));
      },
      { keys: KEYS_ITEM, passphrases: PASSPHRASES_ITEM, name: KEY_NAME },
    );
    await page.reload();
    await expect(page.getByText(KEY_NAME)).toBeVisible({ timeout: 15_000 });
    const before = await storedItems(page);

    // Cancel leaves them
    await page.getByRole('button', { name: 'Clear saved data' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove saved PGP keys?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(KEY_NAME)).toBeVisible();
    expect((await storedItems(page))[KEYS_ITEM]).toBeTruthy();

    await page.getByRole('button', { name: 'Clear saved data' }).click();
    await dialog.getByRole('button', { name: 'Remove keys' }).click();

    await expect(page.getByText('Saved encryption keys cleared.')).toBeVisible();
    await expect(page.getByText(KEY_NAME)).toHaveCount(0);
    const after = await storedItems(page);
    expect(after[KEYS_ITEM]).toBeUndefined();
    expect(after[PASSPHRASES_ITEM]).toBeUndefined();
    await expectStillSignedIn(page, before);
  });

  // The mailbox stays mounted behind Settings. It used to read a Settings hash
  // (#privacy) as a folder, select it and load "its" messages.
  const listedFolders = (since) =>
    server.log
      .slice(since)
      .filter((r) => r.method === 'GET' && r.path === '/v1/messages')
      .map((r) => r.params.folder);

  async function openEncryptedMessage(page) {
    await openMailbox(page, 'Message 0001');
    await page.evaluate(() => {
      window.location.hash = '#INBOX/msg-1';
    });
    const prompt = page.getByRole('alertdialog', { name: 'PGP encrypted message detected' });
    await expect(prompt).toBeVisible({ timeout: 15_000 });
    // the page as loaded; a full reload loses it
    await page.evaluate(() => {
      window.__sameDocument = true;
    });
    return prompt;
  }

  async function expectOnPgpSettings(page, since) {
    await expect(page).toHaveURL(/\/mailbox\/settings#privacy$/);
    await expect(page.getByRole('button', { name: 'Clear saved data' })).toBeVisible();
    expect(await page.evaluate(() => window.__sameDocument)).toBe(true);
    await page.waitForLoadState('networkidle');
    expect(listedFolders(since)).not.toContain('privacy');
  }

  test('"Go to settings" in the missing-key prompt opens the keys without reloading', async ({
    page,
  }) => {
    const prompt = await openEncryptedMessage(page);
    const mark = server.log.length;

    await prompt.getByRole('button', { name: 'Go to settings' }).click();

    await expectOnPgpSettings(page, mark);
  });

  test('"Add PGP Key" in the reader opens the keys, and Back returns to the message', async ({
    page,
  }) => {
    const prompt = await openEncryptedMessage(page);
    await prompt.getByRole('button', { name: 'Not now' }).click();
    const mark = server.log.length;

    await page.locator('.fe-reader').getByRole('button', { name: 'Add PGP Key' }).click();

    await expectOnPgpSettings(page, mark);
    await page.goBack();
    await expect(page).toHaveURL(/\/mailbox#INBOX\/msg-1$/);
    await expect(page.locator('.fe-reader').getByText('Message 0001').first()).toBeVisible();
    expect(listedFolders(mark)).not.toContain('privacy');
  });
});

// A real key and a message encrypted to it, made for the test. The sender
// encrypts the subject (protected headers): the server only has "...".
const HIDDEN_SUBJECT = 'Synthetic protected subject';
const HIDDEN_TEXT = 'Synthetic decrypted body text';

async function encryptedFixture() {
  const { privateKey, publicKey } = await openpgp.generateKey({
    type: 'ecc',
    curve: 'curve25519Legacy',
    userIDs: [{ email: ACCOUNT }],
    format: 'armored',
  });
  const inner = [
    `Subject: ${HIDDEN_SUBJECT}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    HIDDEN_TEXT,
  ].join('\r\n');
  const armored = await openpgp.encrypt({
    message: await openpgp.createMessage({ text: inner }),
    encryptionKeys: await openpgp.readKey({ armoredKey: publicKey }),
  });
  const raw = [
    'Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="b"',
    'From: Sender <sender@example.org>',
    `To: ${ACCOUNT}`,
    'Subject: ...',
    'MIME-Version: 1.0',
    '',
    '--b',
    'Content-Type: application/pgp-encrypted',
    '',
    'Version: 1',
    '--b',
    'Content-Type: application/octet-stream',
    '',
    armored.trim(),
    '--b--',
  ].join('\r\n');
  return { privateKey, raw };
}

// What the cache holds for one message: its row and its body
async function cachedCopy(page, id) {
  return page.evaluate(
    async ({ account, id }) => {
      const read = (db, store) =>
        new Promise((resolve) => {
          if (!db.objectStoreNames.contains(store)) return resolve(null);
          const req = db.transaction(store, 'readonly').objectStore(store).get([account, id]);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      for (const info of await indexedDB.databases()) {
        if (!info.name?.startsWith('webmail-cache')) continue;
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open(info.name);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        try {
          const message = await read(db, 'messages');
          const body = await read(db, 'messageBodies');
          if (message || body) return { message, body: body ? JSON.stringify(body) : null };
        } finally {
          db.close();
        }
      }
      return { message: null, body: null };
    },
    { account: ACCOUNT, id },
  );
}

test.describe('Removing the saved keys', () => {
  test.setTimeout(120_000);

  test('removes what they decrypted: the body and the protected subject', async ({
    page,
  }, testInfo) => {
    test.skip(isMobileProject(testInfo), 'Desktop settings layout');
    const { privateKey, raw } = await encryptedFixture();
    await setupAuthenticatedMailbox(page);
    await installMockSocket(page);
    await installMailServer(page, {
      messages: [buildMessage(1, { subject: '...' }), buildMessage(2)],
      detailBody: (msg) => (msg.id === 'msg-1' ? { raw, nodemailer: null } : null),
    });

    // Save the key
    await openPrivacy(page);
    await page.getByRole('button', { name: 'Add key' }).click();
    await page.getByPlaceholder('Key name (e.g., Personal)').fill(KEY_NAME);
    await page.getByPlaceholder('PGP private key (ASCII armor)').fill(privateKey);
    await page.getByRole('button', { name: 'Save key' }).click();
    await expect(page.getByText(KEY_NAME)).toBeVisible({ timeout: 15_000 });

    // Read the message: decrypted, with its real subject, and cached so
    await page.goto('/mailbox#INBOX/msg-1');
    const reader = page.locator('.fe-reader');
    await expect(reader.frameLocator('iframe').getByText(HIDDEN_TEXT)).toBeVisible({
      timeout: 20_000,
    });
    await expect
      .poll(async () => (await cachedCopy(page, 'msg-1')).body || '', { timeout: 15_000 })
      .toContain(HIDDEN_TEXT);
    await expect
      .poll(async () => (await cachedCopy(page, 'msg-1')).message?.subject)
      .toBe(HIDDEN_SUBJECT);

    // Remove the keys
    await openPrivacy(page);
    await page.getByRole('button', { name: 'Clear saved data' }).click();
    await page
      .getByRole('dialog', { name: 'Remove saved PGP keys?' })
      .getByRole('button', { name: 'Remove keys' })
      .click();
    await expect(page.getByText('Saved encryption keys cleared.')).toBeVisible();

    // Nothing decrypted is left on this device
    await expect
      .poll(async () => (await cachedCopy(page, 'msg-1')).body, { timeout: 15_000 })
      .toBeNull();
    await expect.poll(async () => (await cachedCopy(page, 'msg-1')).message?.subject).toBe('...');
    // and the ordinary message is untouched
    expect((await cachedCopy(page, 'msg-2')).message?.subject).toBe('Message 0002');
  });
});
