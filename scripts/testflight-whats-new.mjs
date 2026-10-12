#!/usr/bin/env node
/**
 * Sets TestFlight's "What to Test" text on a build uploaded by altool, which
 * has no option for it. Uses the App Store Connect API with the same key as
 * the upload.
 *
 * The build only shows up in the API a few minutes after the upload, and
 * Apple can refuse the change while the build is still processing, so both
 * are retried until TIMEOUT_MINUTES runs out.
 *
 * Env: ASC_KEY (the .p8 contents), ASC_KEY_ID, ASC_ISSUER, BUNDLE_ID,
 *      APP_VERSION (CFBundleShortVersionString), BUILD_NUMBER (CFBundleVersion),
 *      WHATS_NEW_FILE, TIMEOUT_MINUTES (default 30).
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com/v1';
const LOCALE = 'en-US';

const base64url = (value) => Buffer.from(value).toString('base64url');

/** A short-lived App Store Connect token (Apple allows at most 20 minutes). */
export const createToken = ({ key, keyId, issuer, now = Date.now() }) => {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({ iss: issuer, iat, exp: iat + 15 * 60, aud: 'appstoreconnect-v1' }),
  );
  const signer = createSign('SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${header}.${payload}.${signature}`;
};

export class AscError extends Error {
  constructor(status, body) {
    super(`App Store Connect returned ${status}: ${body}`);
    this.status = status;
  }
}

export const setWhatsNew = async ({
  credentials,
  bundleId,
  appVersion,
  buildNumber,
  whatsNew,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 30 * 60 * 1000,
  intervalMs = 60 * 1000,
  log = console.log,
}) => {
  const request = async (method, path, body) => {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${createToken(credentials)}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await response.text();
    if (!response.ok) throw new AscError(response.status, text);
    return text ? JSON.parse(text) : {};
  };

  const apps = await request('GET', `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  const appId = apps.data?.[0]?.id;
  if (!appId) throw new Error(`No App Store Connect app for ${bundleId}`);

  const query = new URLSearchParams({
    'filter[app]': appId,
    'filter[version]': buildNumber,
    'filter[preReleaseVersion.version]': appVersion,
    limit: '1',
  });

  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const builds = await request('GET', `/builds?${query}`);
      const buildId = builds.data?.[0]?.id;
      if (buildId) {
        const existing = await request('GET', `/builds/${buildId}/betaBuildLocalizations`);
        const localization = existing.data?.find((item) => item.attributes?.locale === LOCALE);
        if (localization) {
          await request('PATCH', `/betaBuildLocalizations/${localization.id}`, {
            data: { type: 'betaBuildLocalizations', id: localization.id, attributes: { whatsNew } },
          });
        } else {
          await request('POST', '/betaBuildLocalizations', {
            data: {
              type: 'betaBuildLocalizations',
              attributes: { locale: LOCALE, whatsNew },
              relationships: { build: { data: { type: 'builds', id: buildId } } },
            },
          });
        }
        log(`Set What to Test on ${appVersion} (${buildNumber})`);
        return buildId;
      }
      log(`Build ${appVersion} (${buildNumber}) not in App Store Connect yet (attempt ${attempt})`);
    } catch (error) {
      // 409 is Apple refusing the edit while the build processes; anything
      // else (bad key, no access) will not get better by waiting.
      if (!(error instanceof AscError) || error.status !== 409) throw error;
      log(`Build still processing (attempt ${attempt})`);
    }
    if (Date.now() + intervalMs > deadline) {
      throw new Error(`Gave up waiting for build ${appVersion} (${buildNumber})`);
    }
    await sleep(intervalMs);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  const missing = [
    'ASC_KEY',
    'ASC_KEY_ID',
    'ASC_ISSUER',
    'BUNDLE_ID',
    'APP_VERSION',
    'BUILD_NUMBER',
    'WHATS_NEW_FILE',
  ].filter((name) => !env[name]);
  if (missing.length) {
    console.error(`Missing env: ${missing.join(', ')}`);
    process.exit(1);
  }
  setWhatsNew({
    credentials: { key: env.ASC_KEY, keyId: env.ASC_KEY_ID, issuer: env.ASC_ISSUER },
    bundleId: env.BUNDLE_ID,
    appVersion: env.APP_VERSION.replace(/^v/, ''),
    buildNumber: env.BUILD_NUMBER,
    whatsNew: readFileSync(env.WHATS_NEW_FILE, 'utf8').trim(),
    timeoutMs: Number(env.TIMEOUT_MINUTES || 30) * 60 * 1000,
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
