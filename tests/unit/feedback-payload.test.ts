import { describe, it, expect } from 'vitest';
import {
  buildPayload,
  buildEmailSubject,
  buildEmailBody,
  generateCorrelationId,
  type FeedbackInputs,
} from '../../src/utils/feedback-payload';

const fixedTime = () => '2026-04-14T00:00:00.000Z';

function baseInputs(over: Partial<FeedbackInputs> = {}): FeedbackInputs {
  return {
    type: 'bug',
    subject: 'subj',
    description: 'desc',
    correlationId: 'fb-deadbeef',
    consents: { systemInfo: false, jsErrors: false, nativeLogs: false, networkErrors: false },
    sources: {},
    ...over,
  };
}

describe('buildPayload — consent gating', () => {
  it('omits all optional sections when every consent is false', () => {
    const out = buildPayload(
      baseInputs({
        sources: {
          systemInfo: { userAgent: 'X' },
          jsErrors: [{ message: 'boom' }],
          nativeLogs: 'foo',
          networkErrors: [{ endpoint: '/api' }],
        },
      }),
      fixedTime,
    );
    expect(out.systemInfo).toBeUndefined();
    expect(out.jsErrors).toBeUndefined();
    expect(out.nativeLogs).toBeUndefined();
    expect(out.networkErrors).toBeUndefined();
  });

  it('includes only the sections whose consent is true', () => {
    const out = buildPayload(
      baseInputs({
        consents: {
          systemInfo: true,
          jsErrors: false,
          nativeLogs: true,
          networkErrors: false,
        },
        sources: {
          systemInfo: { userAgent: 'UA' },
          jsErrors: [{ message: 'boom' }],
          nativeLogs: 'tail',
          networkErrors: [{ endpoint: '/api' }],
        },
      }),
      fixedTime,
    );
    expect(out.systemInfo).toEqual({ userAgent: 'UA' });
    expect(out.nativeLogs).toBe('tail');
    expect(out.jsErrors).toBeUndefined();
    expect(out.networkErrors).toBeUndefined();
  });

  it('drops empty arrays even when consent is true', () => {
    const out = buildPayload(
      baseInputs({
        consents: { systemInfo: false, jsErrors: true, nativeLogs: false, networkErrors: true },
        sources: { jsErrors: [], networkErrors: [] },
      }),
      fixedTime,
    );
    expect(out.jsErrors).toBeUndefined();
    expect(out.networkErrors).toBeUndefined();
  });
});

describe('buildPayload — redaction', () => {
  it('redacts subject and description', () => {
    const out = buildPayload(
      baseInputs({
        subject: 'token=abc12345 broken',
        description: 'crash with /Users/alice/notes.txt',
      }),
      fixedTime,
    );
    expect(out.subject).toBe('token=[REDACTED] broken');
    expect(out.description).toBe('crash with ~/notes.txt');
  });

  it('redacts log entry strings field-by-field', () => {
    const out = buildPayload(
      baseInputs({
        consents: { systemInfo: false, jsErrors: true, nativeLogs: false, networkErrors: true },
        sources: {
          jsErrors: [
            {
              message: 'failed for user@example.com',
              stack: 'at /Users/bob/app.js:1',
              other: 'kept verbatim',
            },
          ],
          networkErrors: [{ endpoint: 'https://api/?api_key=secret_xyz', status: 500 }],
        },
      }),
      fixedTime,
    );
    expect(out.jsErrors?.[0].message).toBe('failed for <email:ddaa05fb>');
    expect(out.jsErrors?.[0].stack).toBe('at ~/app.js:1');
    expect(out.jsErrors?.[0].other).toBe('kept verbatim');
    expect(out.networkErrors?.[0].endpoint).toBe('https://api/?api_key=[REDACTED]');
    expect(out.networkErrors?.[0].status).toBe(500);
  });

  it('redacts native log blob as a single string', () => {
    const out = buildPayload(
      baseInputs({
        consents: { systemInfo: false, jsErrors: false, nativeLogs: true, networkErrors: false },
        sources: { nativeLogs: 'panic at /home/eve/main.rs sending Bearer abcdefghij' },
      }),
      fixedTime,
    );
    expect(out.nativeLogs).toBe('panic at ~/main.rs sending Bearer [REDACTED]');
  });
});

describe('buildPayload — determinism', () => {
  it('produces identical output for identical inputs (same now())', () => {
    const a = buildPayload(baseInputs(), fixedTime);
    const b = buildPayload(baseInputs(), fixedTime);
    expect(a).toEqual(b);
  });

  it('always carries the correlation ID and timestamp', () => {
    const out = buildPayload(baseInputs(), fixedTime);
    expect(out.correlationId).toBe('fb-deadbeef');
    expect(out.timestamp).toBe('2026-04-14T00:00:00.000Z');
  });
});

describe('generateCorrelationId', () => {
  it('matches fb- + 8 hex chars', () => {
    const id = generateCorrelationId();
    expect(id).toMatch(/^fb-[0-9a-f]{8}$/);
  });

  it('uses the injected RNG deterministically', () => {
    const id = generateCorrelationId((bytes) => {
      bytes[0] = 0xde;
      bytes[1] = 0xad;
      bytes[2] = 0xbe;
      bytes[3] = 0xef;
    });
    expect(id).toBe('fb-deadbeef');
  });
});

describe('buildEmailSubject', () => {
  it('prefixes correlation ID and uses user subject when provided', () => {
    const payload = buildPayload(
      baseInputs({ subject: 'crash on send', description: 'long description' }),
      fixedTime,
    );
    expect(buildEmailSubject(payload, 'crash on send')).toBe(
      '[fb-deadbeef] Webmail Bug Report: crash on send',
    );
  });

  it('falls back to description when no user subject', () => {
    const payload = buildPayload(
      baseInputs({ subject: '', description: 'something is broken in the inbox' }),
      fixedTime,
    );
    expect(buildEmailSubject(payload)).toBe(
      '[fb-deadbeef] Webmail Bug Report: something is broken in the inbox',
    );
  });

  it('truncates long subject suffix', () => {
    const payload = buildPayload(baseInputs({ description: 'x'.repeat(200) }), fixedTime);
    const subj = buildEmailSubject(payload);
    expect(subj.length).toBeLessThanOrEqual('[fb-deadbeef] Webmail Bug Report: '.length + 60);
  });
});

describe('buildEmailBody', () => {
  it('always includes correlation ID and description', () => {
    const payload = buildPayload(
      baseInputs({ description: 'alice@example.com is missing' }),
      fixedTime,
    );
    const body = buildEmailBody(payload);
    expect(body).toContain('Reference: fb-deadbeef');
    expect(body).toContain('<email:94a4b546>');
    expect(body).not.toContain('alice@example.com');
  });

  it('omits sections that the payload does not include', () => {
    const payload = buildPayload(baseInputs(), fixedTime);
    const body = buildEmailBody(payload);
    expect(body).not.toContain('System Information');
    expect(body).not.toContain('JS Errors');
    expect(body).not.toContain('Native Log');
  });
});
