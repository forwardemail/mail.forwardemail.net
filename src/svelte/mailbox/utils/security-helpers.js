import { trustedAuthResults } from '../../../utils/sender-warnings';

/**
 * Resolve a header value to a string regardless of how simpleParser stored it.
 * Headers may be plain strings, objects with .value/.text, or arrays of either.
 * @param {unknown} val - Raw header value from nodemailer.headers
 * @returns {string|null}
 */
function resolveHeaderValue(val) {
  if (!val) return null;
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) {
    return val.map(resolveHeaderValue).filter(Boolean).join(' ');
  }
  if (typeof val === 'object') {
    return val.value || val.text || val.initial || null;
  }
  return String(val);
}

/**
 * Extract "mailed-by" from received header or DKIM signature domain
 * @param {Object} msg - Message object with nodemailer headers
 * @returns {string|null} Mailed-by domain or null
 */
export const getMailedBy = (msg) => {
  if (!msg?.nodemailer?.headers) return null;
  const headers = msg.nodemailer.headers;

  // Try to get from received header - look for "by <domain>" pattern
  const received = resolveHeaderValue(headers.received);
  if (received) {
    const byMatch = received.match(/by\s+([^\s(]+)/i);
    if (byMatch) return byMatch[1];
  }

  // Fallback to DKIM signature domain
  const dkim = headers['dkim-signature'];
  if (dkim?.params?.d) return dkim.params.d;
  const dkimStr = resolveHeaderValue(dkim);
  if (dkimStr) {
    const dMatch = dkimStr.match(/\bd=([^;\s]+)/i);
    if (dMatch) return dMatch[1];
  }

  return null;
};

/**
 * Extract "signed-by" from DKIM signature domain
 * @param {Object} msg - Message object with nodemailer headers
 * @returns {string|null} DKIM signature domain or null
 */
export const getSignedBy = (msg) => {
  if (!msg?.nodemailer?.headers) return null;
  const dkim = msg.nodemailer.headers['dkim-signature'];
  if (dkim?.params?.d) return dkim.params.d;
  const dkimStr = resolveHeaderValue(dkim);
  if (dkimStr) {
    const dMatch = dkimStr.match(/\bd=([^;\s]+)/i);
    if (dMatch) return dMatch[1];
  }
  return null;
};

// How each result reads in the reader: green only for a pass, red for a
// failure, amber for anything in between (no record, a soft fail, a lookup
// that timed out).
const RESULT_TONES = {
  pass: 'pass',
  fail: 'fail',
  permerror: 'fail',
  softfail: 'caution',
  temperror: 'caution',
  neutral: 'caution',
  none: 'caution',
  policy: 'caution',
};

const CHECKS = [
  ['spf', 'SPF'],
  ['dkim', 'DKIM'],
  ['dmarc', 'DMARC'],
];

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// The result the newest of `values` records for one method. A message with
// several DKIM signatures has several results, and it is signed if any of
// them verifies.
const resultFor = (values, method) => {
  const pattern = new RegExp(`\\b${method}\\s*=\\s*(\\w+)`, 'gi');
  for (const value of values) {
    const found = Array.from(value.matchAll(pattern), (match) => match[1].toLowerCase());
    if (found.length) return found.includes('pass') ? 'pass' : found[0];
  }
  return null;
};

/**
 * The parts of the reader's "security" line: transport encryption and the
 * SPF, DKIM and DMARC results, each with the tone it should be drawn in.
 *
 * The results are read only from the Authentication-Results headers that
 * Forward Email's own servers added (see trustedAuthResults). A sender can
 * write the same headers under another name, and "SPF: Pass" taken from one
 * of those would vouch for a forged message.
 *
 * @param {Object} msg - Message object with nodemailer headers
 * @returns {Array<{label: string, text: string, tone: 'pass'|'fail'|'caution'|'neutral'}>}
 */
export const getSecurityParts = (msg) => {
  const headers = msg?.nodemailer?.headers;
  if (!headers) return [];
  const parts = [];

  const received = resolveHeaderValue(headers.received);
  if (received && /tls/i.test(received)) {
    const version = received.match(/version=(TLSv[\d.]+)/i)?.[1] || 'TLS';
    parts.push({
      label: 'Encryption',
      text: `Standard encryption (${version})`,
      tone: 'neutral',
    });
  }

  const verdicts = trustedAuthResults(msg.nodemailer.headerLines);
  for (const [method, label] of CHECKS) {
    const result = resultFor(verdicts, method);
    if (result) {
      parts.push({
        label,
        text: `${label}: ${capitalize(result)}`,
        tone: RESULT_TONES[result] || 'caution',
      });
    } else if (method === 'dkim' && headers['dkim-signature']) {
      // Signed, but with no verdict from the server on whether it verifies.
      parts.push({ label, text: 'DKIM: Signed', tone: 'neutral' });
    }
  }

  return parts;
};
