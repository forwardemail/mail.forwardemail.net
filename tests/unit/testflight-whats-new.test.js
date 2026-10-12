// @vitest-environment node
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { createToken, setWhatsNew } from '../../scripts/testflight-whats-new.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = {
  key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  keyId: 'KEY123',
  issuer: 'issuer-uuid',
};

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

// Routes requests by method + path prefix; each route returns responses in order.
const fakeApi = (routes) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = url.replace('https://api.appstoreconnect.apple.com/v1', '');
    calls.push({ method: init.method, path, body: init.body && JSON.parse(init.body) });
    const key = Object.keys(routes).find((k) => `${init.method} ${path}`.startsWith(k));
    if (!key) throw new Error(`Unexpected ${init.method} ${path}`);
    const queue = routes[key];
    return queue.length > 1 ? queue.shift() : queue[0];
  };
  return { fetchImpl, calls };
};

const baseArgs = {
  credentials,
  bundleId: 'net.forwardemail.mail',
  appVersion: '0.14.30',
  buildNumber: '812.1',
  whatsNew: 'Fixes:\n• Threads stay together',
  sleep: async () => {},
  log: () => {},
};

describe('createToken', () => {
  it('makes an ES256 token App Store Connect can verify', () => {
    const token = createToken({ ...credentials, now: 1_700_000_000_000 });
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url'))).toEqual({
      alg: 'ES256',
      kid: 'KEY123',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url'));
    expect(claims).toMatchObject({ iss: 'issuer-uuid', aud: 'appstoreconnect-v1' });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(20 * 60);

    const verifier = createVerify('SHA256');
    verifier.update(`${header}.${payload}`);
    expect(
      verifier.verify(
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('setWhatsNew', () => {
  it('waits for the build to appear, then creates the en-US localization', async () => {
    const { fetchImpl, calls } = fakeApi({
      'GET /apps': [json(200, { data: [{ id: 'app1' }] })],
      'GET /builds?': [json(200, { data: [] }), json(200, { data: [{ id: 'build9' }] })],
      'GET /builds/build9/betaBuildLocalizations': [json(200, { data: [] })],
      'POST /betaBuildLocalizations': [json(201, { data: { id: 'loc1' } })],
    });

    await expect(setWhatsNew({ ...baseArgs, fetchImpl })).resolves.toBe('build9');

    const buildQuery = calls.find((c) => c.path.startsWith('/builds?')).path;
    expect(decodeURIComponent(buildQuery)).toContain('filter[version]=812.1');
    expect(decodeURIComponent(buildQuery)).toContain('filter[preReleaseVersion.version]=0.14.30');
    expect(calls.filter((c) => c.path.startsWith('/builds?'))).toHaveLength(2);
    expect(calls.at(-1).body.data).toEqual({
      type: 'betaBuildLocalizations',
      attributes: { locale: 'en-US', whatsNew: baseArgs.whatsNew },
      relationships: { build: { data: { type: 'builds', id: 'build9' } } },
    });
  });

  it('updates an existing localization and retries while Apple says 409', async () => {
    const { fetchImpl, calls } = fakeApi({
      'GET /apps': [json(200, { data: [{ id: 'app1' }] })],
      'GET /builds?': [json(200, { data: [{ id: 'build9' }] })],
      'GET /builds/build9/betaBuildLocalizations': [
        json(200, { data: [{ id: 'loc7', attributes: { locale: 'en-US' } }] }),
      ],
      'PATCH /betaBuildLocalizations/loc7': [json(409, { errors: [] }), json(200, {})],
    });

    await setWhatsNew({ ...baseArgs, fetchImpl });
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches).toHaveLength(2);
    expect(patches[1].body.data.attributes).toEqual({ whatsNew: baseArgs.whatsNew });
  });

  it('fails at once on an auth error instead of waiting out the timeout', async () => {
    const { fetchImpl, calls } = fakeApi({ 'GET /apps': [json(401, { errors: [] })] });
    await expect(setWhatsNew({ ...baseArgs, fetchImpl })).rejects.toThrow('401');
    expect(calls).toHaveLength(1);
  });

  it('gives up when the build never appears', async () => {
    const { fetchImpl } = fakeApi({
      'GET /apps': [json(200, { data: [{ id: 'app1' }] })],
      'GET /builds?': [json(200, { data: [] })],
    });
    await expect(
      setWhatsNew({ ...baseArgs, fetchImpl, timeoutMs: 0, intervalMs: 1 }),
    ).rejects.toThrow('Gave up');
  });
});
