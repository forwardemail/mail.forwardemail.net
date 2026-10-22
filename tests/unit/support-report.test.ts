import { describe, expect, it, vi } from 'vitest';
import {
  buildReportAttachments,
  buildSupportMailto,
  sendSupportReport,
  SUPPORT_ADDRESS,
} from '../../src/utils/support-report';

const reportText = 'Forward Email Diagnostics\n[WARN] Page reloads (0ms): 4 loads in the last hour';
const reportJson = JSON.stringify({ results: [{ id: 'page-reloads', message: 'Ünïcode ✓' }] });

const decode = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));

describe('buildReportAttachments', () => {
  it('attaches the JSON report, and the app log when there is one', () => {
    const [json, log] = buildReportAttachments(reportJson, 'line one\nline two');
    expect(json.filename).toBe('diagnostics.json');
    expect(json.contentType).toBe('application/json');
    // Non-ASCII survives the base64 round trip
    expect(JSON.parse(decode(json.content)).results[0].message).toBe('Ünïcode ✓');
    expect(json.size).toBe(new TextEncoder().encode(reportJson).length);
    expect(log.filename).toBe('app-log.txt');
    expect(decode(log.content)).toBe('line one\nline two');
  });

  it('leaves out an empty log', () => {
    expect(buildReportAttachments(reportJson, '  \n')).toHaveLength(1);
  });
});

describe('sendSupportReport', () => {
  const attachments = buildReportAttachments(reportJson, 'log');

  it('opens our composer to support with the report attached when signed in', async () => {
    const openComposer = vi.fn(() => true);
    const share = vi.fn();
    const openMailto = vi.fn();
    const route = await sendSupportReport(reportText, attachments, {
      openComposer,
      share,
      openMailto,
    });
    expect(route).toBe('composer');
    const prefill = openComposer.mock.calls[0][0];
    expect(prefill.to).toEqual([SUPPORT_ADDRESS]);
    expect(prefill.subject).toBe('Forward Email diagnostics report');
    expect(prefill.text).toContain(reportText);
    expect(prefill.attachments.map((a) => a.filename)).toEqual(['diagnostics.json', 'app-log.txt']);
    expect(share).not.toHaveBeenCalled();
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('uses the share sheet with the files when the composer cannot open', async () => {
    const share = vi.fn(async () => {});
    const openMailto = vi.fn();
    const route = await sendSupportReport(reportText, attachments, {
      openComposer: () => false,
      share,
      canShare: () => true,
      openMailto,
    });
    expect(route).toBe('share');
    const data = share.mock.calls[0][0];
    expect(data.files.map((f: File) => f.name)).toEqual(['diagnostics.json', 'app-log.txt']);
    expect(data.text).toContain(`Please send to ${SUPPORT_ADDRESS}`);
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('stops when the user closes the share sheet', async () => {
    const openMailto = vi.fn();
    const route = await sendSupportReport(reportText, attachments, {
      share: async () => {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
      },
      openMailto,
    });
    expect(route).toBe('cancelled');
    expect(openMailto).not.toHaveBeenCalled();
  });

  it('falls back to a mailto link when files cannot be shared', async () => {
    const openMailto = vi.fn();
    const route = await sendSupportReport(reportText, attachments, {
      share: vi.fn(),
      canShare: () => false,
      openMailto,
    });
    expect(route).toBe('mailto');
    expect(openMailto.mock.calls[0][0]).toMatch(/^mailto:support@forwardemail\.net\?subject=/);
  });

  it('falls back to a mailto link when sharing fails', async () => {
    const openMailto = vi.fn();
    await sendSupportReport(reportText, attachments, {
      share: async () => {
        throw new Error('NotAllowedError');
      },
      openMailto,
    });
    expect(openMailto).toHaveBeenCalledOnce();
  });
});

describe('buildSupportMailto', () => {
  it('cuts a long report and says how to send the rest', () => {
    const url = buildSupportMailto('x'.repeat(10_000));
    const body = decodeURIComponent(url.split('&body=')[1]);
    expect(body.length).toBeLessThan(2100);
    expect(body).toContain('Use Copy report');
  });
});
