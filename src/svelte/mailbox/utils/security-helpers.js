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

/**
 * Parse authentication-results headers for security info.
 * Handles multiple header formats: plain strings, structured objects,
 * and arrays. Also falls back to dkim-signature and received-spf headers
 * when authentication-results is absent.
 * @param {Object} msg - Message object with nodemailer headers
 * @returns {Object|null} Security info object with spf, dkim, dmarc, encryption
 */
export const getSecurityInfo = (msg) => {
  if (!msg?.nodemailer?.headers) return null;
  const headers = msg.nodemailer.headers;

  const results = { spf: null, dkim: null, dmarc: null, encryption: null };
  let hasAnyInfo = false;

  // Try arc-authentication-results first, then fall back to authentication-results
  const rawAuthResults = headers['arc-authentication-results'] || headers['authentication-results'];
  const authResults = resolveHeaderValue(rawAuthResults);

  if (authResults) {
    // Parse SPF
    const spfMatch = authResults.match(/spf=(\w+)/i);
    if (spfMatch) {
      results.spf = spfMatch[1].toLowerCase();
      hasAnyInfo = true;
    }

    // Parse DKIM
    const dkimMatch = authResults.match(/dkim=(\w+)/i);
    if (dkimMatch) {
      results.dkim = dkimMatch[1].toLowerCase();
      hasAnyInfo = true;
    }

    // Parse DMARC
    const dmarcMatch = authResults.match(/dmarc=(\w+)/i);
    if (dmarcMatch) {
      results.dmarc = dmarcMatch[1].toLowerCase();
      hasAnyInfo = true;
    }
  }

  // Fallback: check received-spf header if SPF not found in authentication-results
  if (!results.spf) {
    const receivedSpf = resolveHeaderValue(headers['received-spf']);
    if (receivedSpf) {
      const spfMatch = receivedSpf.match(/^(\w+)/i);
      if (spfMatch) {
        results.spf = spfMatch[1].toLowerCase();
        hasAnyInfo = true;
      }
    }
  }

  // Fallback: infer DKIM presence from dkim-signature header
  if (!results.dkim) {
    const dkimSig = headers['dkim-signature'];
    if (dkimSig) {
      results.dkim = 'present';
      hasAnyInfo = true;
    }
  }

  // Check for TLS in received header
  const received = resolveHeaderValue(headers.received);
  if (received) {
    if (received.includes('TLS') || received.includes('tls')) {
      const tlsMatch = received.match(/version=(TLSv[\d.]+)/i);
      results.encryption = tlsMatch ? tlsMatch[1] : 'TLS';
      hasAnyInfo = true;
    }
  }

  return hasAnyInfo ? results : null;
};

/**
 * Format security status for display
 * @param {Object} securityInfo - Security info object from getSecurityInfo
 * @returns {string} Formatted security status string
 */
export const formatSecurityStatus = (securityInfo) => {
  if (!securityInfo) return 'Unknown';
  const parts = [];

  if (securityInfo.encryption) {
    parts.push(`Standard encryption (${securityInfo.encryption})`);
  }

  // Show SPF, DKIM, DMARC results with proper capitalization
  if (securityInfo.spf) {
    const spfStatus = securityInfo.spf.charAt(0).toUpperCase() + securityInfo.spf.slice(1);
    parts.push(`SPF: ${spfStatus}`);
  }
  if (securityInfo.dkim) {
    const dkimStatus =
      securityInfo.dkim === 'present'
        ? 'Signed'
        : securityInfo.dkim.charAt(0).toUpperCase() + securityInfo.dkim.slice(1);
    parts.push(`DKIM: ${dkimStatus}`);
  }
  if (securityInfo.dmarc) {
    const dmarcStatus = securityInfo.dmarc.charAt(0).toUpperCase() + securityInfo.dmarc.slice(1);
    parts.push(`DMARC: ${dmarcStatus}`);
  }

  return parts.length ? parts.join(' · ') : 'Unknown';
};
