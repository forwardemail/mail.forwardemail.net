/**
 * Account setup QR codes from forwardemail.net's alias password modal.
 *
 * Fixtures mirror what the server actually emits: the Thunderbird string is the
 * template from helpers/get-alias-password-swal.js, and the profile is the XML
 * that plist.build produces, wrapped in DER bytes the way a CMS signature
 * embeds it.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  allowedProfileHosts,
  fetchAppleProfileCredentials,
  parseAccountQr,
  readMobileconfigCredentials,
} from '../../src/utils/device-sync/account-qr';
import { encodeFrames } from '../../src/utils/device-sync/frames';

const HOSTS = allowedProfileHosts('https://api.forwardemail.net');

const thunderbirdQr = (username: string, password: string) =>
  `[1,[1,1],[0,"imap.forwardemail.net",993,3,1,"${username}","${username}","${password}"],[[[0,"smtp.forwardemail.net",465,3,1,"${username}","${password}"],["${username}","Support"]]]]`;

const APPLE_URL =
  'https://forwardemail.net/c/support@example.com.mobileconfig?a=4fGZc8Ueu&p=0a1b2c3d4e5f';

const profileXml = (username: string, password: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>PayloadDescription</key>
    <string>Forward Email Settings</string>
    <key>PayloadContent</key>
    <array>
      <dict>
        <key>EmailAccountName</key>
        <string>${username}</string>
        <key>EmailAddress</key>
        <string>${username}</string>
        <key>IncomingMailServerPortNumber</key>
        <integer>993</integer>
        <key>IncomingMailServerUseSSL</key>
        <true/>
        <key>IncomingMailServerUsername</key>
        <string>${username}</string>
        <key>IncomingPassword</key>
        <string>${password}</string>
        <key>PayloadType</key>
        <string>com.apple.mail.managed</string>
      </dict>
      <dict>
        <key>CalDAVUsername</key>
        <string>${username}</string>
        <key>PayloadType</key>
        <string>com.apple.caldav.account</string>
      </dict>
    </array>
    <key>PayloadType</key>
    <string>Configuration</string>
  </dict>
</plist>`;

const signed = (xml: string): Uint8Array => {
  const body = new TextEncoder().encode(xml);
  const prefix = Uint8Array.from([
    0x30, 0x82, 0x1f, 0x3a, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x04, 0x82,
  ]);
  const suffix = Uint8Array.from([0xa0, 0x82, 0x05, 0x10, 0x30, 0x82, 0x3c, 0x3f, 0x78]);
  const out = new Uint8Array(prefix.length + body.length + suffix.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  out.set(suffix, prefix.length + body.length);
  return out;
};

describe('parseAccountQr', () => {
  it('reads credentials from the Thunderbird Mobile code', () => {
    expect(parseAccountQr(thunderbirdQr('support@example.com', 'xY9z0AbC'), HOSTS)).toEqual({
      kind: 'thunderbird',
      email: 'support@example.com',
      password: 'xY9z0AbC',
    });
  });

  it('recognises the Apple profile link without touching the network', () => {
    expect(parseAccountQr(APPLE_URL, HOSTS)).toEqual({
      kind: 'apple-profile',
      email: 'support@example.com',
      url: APPLE_URL,
    });
  });

  it('refuses profile links on hosts we do not run', () => {
    expect(parseAccountQr(APPLE_URL.replace('forwardemail.net', 'evil.example'), HOSTS)).toBeNull();
    expect(parseAccountQr(APPLE_URL.replace('https:', 'http:'), HOSTS)).toBeNull();
  });

  it('follows a self-hosted API base to its web host', () => {
    const hosts = allowedProfileHosts('https://api.mail.example.org');
    const url = APPLE_URL.replace('forwardemail.net', 'mail.example.org');
    expect(parseAccountQr(url, hosts)?.kind).toBe('apple-profile');
  });

  it('rejects profile links missing the alias or password parameters', () => {
    expect(parseAccountQr(APPLE_URL.replace('&p=0a1b2c3d4e5f', ''), HOSTS)).toBeNull();
  });

  it('leaves pairing frames and unrelated codes to the frame collector', async () => {
    const [frame] = encodeFrames({
      sealed: new Uint8Array(40),
      key: new Uint8Array(32),
      sessionId: new Uint8Array(16),
      codeProtected: false,
    });
    expect(parseAccountQr(frame, HOSTS)).toBeNull();
    expect(parseAccountQr('WIFI:S:home;T:WPA;P:secret;;', HOSTS)).toBeNull();
    expect(parseAccountQr('[1,2,3]', HOSTS)).toBeNull();
    expect(parseAccountQr('https://forwardemail.net/en/faq', HOSTS)).toBeNull();
  });
});

describe('readMobileconfigCredentials', () => {
  it('extracts the mail account from a signed profile', () => {
    const creds = readMobileconfigCredentials(
      signed(profileXml('support@example.com', 'a&amp;b&lt;c')),
    );
    expect(creds).toEqual({ email: 'support@example.com', password: 'a&b<c' });
  });

  it('extracts the mail account from an unsigned profile', () => {
    const bytes = new TextEncoder().encode(profileXml('support@example.com', 'pw123'));
    expect(readMobileconfigCredentials(bytes)?.password).toBe('pw123');
  });

  it('returns null when there is no mail payload', () => {
    const xml = profileXml('support@example.com', 'pw').replace(
      'com.apple.mail.managed',
      'com.apple.other',
    );
    expect(readMobileconfigCredentials(signed(xml))).toBeNull();
  });
});

describe('fetchAppleProfileCredentials', () => {
  const qr = { kind: 'apple-profile' as const, email: 'support@example.com', url: APPLE_URL };

  it('downloads the profile and returns its credentials', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(signed(profileXml('support@example.com', 'pw123'))),
    );
    await expect(fetchAppleProfileCredentials(qr, fetchImpl)).resolves.toEqual({
      email: 'support@example.com',
      password: 'pw123',
    });
    expect(fetchImpl).toHaveBeenCalledWith(APPLE_URL, { credentials: 'omit', redirect: 'error' });
  });

  it('explains a stale link', async () => {
    const fetchImpl = vi.fn(async () => new Response('Not Found', { status: 404 }));
    await expect(fetchAppleProfileCredentials(qr, fetchImpl)).rejects.toThrow(/regenerated/);
  });

  it('refuses a profile for a different account than the link named', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(signed(profileXml('someone@else.example', 'pw123'))),
    );
    await expect(fetchAppleProfileCredentials(qr, fetchImpl)).rejects.toThrow(/did not match/);
  });
});
