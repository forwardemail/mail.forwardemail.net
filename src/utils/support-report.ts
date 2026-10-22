/**
 * Sending a diagnostics report to support.
 *
 * A mailto: link set on window.location does nothing in the iOS and Android
 * apps (the webview does not hand it to the system), so the report goes out
 * the best way the device allows:
 *  1. Our own composer, signed in, with the report and the app log attached.
 *  2. The system share sheet (Mail, Messages, AirDrop, Files), when not
 *     signed in or the composer is unavailable.
 *  3. A mailto: link opened through the system, with the text report in the
 *     body, cut to a length mail apps accept.
 */
import { mailtoToPrefill } from './mailto.js';

export const SUPPORT_ADDRESS = 'support@forwardemail.net';
export const SUPPORT_SUBJECT = 'Forward Email diagnostics report';

// Mail apps and OS link handlers cut or refuse very long mailto: URLs
const MAILTO_BODY_LIMIT = 1800;

export interface ReportAttachment {
  name: string;
  filename: string;
  size: number;
  contentType: string;
  /** Base64 of the UTF-8 file */
  content: string;
}

const utf8Base64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const attachment = (filename: string, contentType: string, text: string): ReportAttachment => ({
  name: filename,
  filename,
  size: new TextEncoder().encode(text).length,
  contentType,
  content: utf8Base64(text),
});

export function buildReportAttachments(reportJson: string, nativeLog = ''): ReportAttachment[] {
  const files = [attachment('diagnostics.json', 'application/json', reportJson)];
  if (nativeLog.trim()) files.push(attachment('app-log.txt', 'text/plain', nativeLog));
  return files;
}

export const supportBody = (reportText: string) =>
  `Hi Forward Email support,\n\nWhat happened:\n\n\n--- Diagnostics ---\n${reportText}\n`;

export function buildSupportPrefill(reportText: string, attachments: ReportAttachment[]) {
  return {
    ...mailtoToPrefill({
      to: [SUPPORT_ADDRESS],
      subject: SUPPORT_SUBJECT,
      body: supportBody(reportText),
    }),
    attachments,
  };
}

export function buildSupportMailto(reportText: string) {
  let body = supportBody(reportText);
  if (body.length > MAILTO_BODY_LIMIT) {
    body = `${body.slice(0, MAILTO_BODY_LIMIT)}\n\n[Report cut short. Use Copy report on the diagnostics page and paste the rest here.]`;
  }
  return `mailto:${SUPPORT_ADDRESS}?subject=${encodeURIComponent(SUPPORT_SUBJECT)}&body=${encodeURIComponent(body)}`;
}

export interface ShareInput {
  title?: string;
  text?: string;
  files?: File[];
}

export interface SendDeps {
  /** Opens the in-app composer; false when it cannot (signed out, locked) */
  openComposer?: (prefill: ReturnType<typeof buildSupportPrefill>) => boolean;
  share?: (data: ShareInput) => Promise<void>;
  canShare?: (data: ShareInput) => boolean;
  openMailto: (url: string) => Promise<unknown> | void;
}

export type SendRoute = 'composer' | 'share' | 'mailto' | 'cancelled';

export async function sendSupportReport(
  reportText: string,
  attachments: ReportAttachment[],
  deps: SendDeps,
): Promise<SendRoute> {
  if (deps.openComposer?.(buildSupportPrefill(reportText, attachments))) return 'composer';

  if (deps.share && typeof File !== 'undefined') {
    const files = attachments.map(
      (a) =>
        new File([Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))], a.filename, {
          type: a.contentType,
        }),
    );
    // A share sheet cannot fill in the address, so the text says where to send it
    const text = `Please send to ${SUPPORT_ADDRESS}\n\n${supportBody(reportText)}`;
    const data: ShareInput = { title: SUPPORT_SUBJECT, text, files };
    if (!deps.canShare || deps.canShare(data)) {
      try {
        await deps.share(data);
        return 'share';
      } catch (err) {
        // Closing the share sheet is a choice, not a failure
        if ((err as { name?: string })?.name === 'AbortError') return 'cancelled';
      }
    }
  }

  await deps.openMailto(buildSupportMailto(reportText));
  return 'mailto';
}
