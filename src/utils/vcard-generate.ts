/**
 * vCard output for contacts: a fresh card for a new contact, and a merge of
 * the edited fields into the card the server holds for an existing one.
 */

/** The contact fields a vCard is written from. */
export interface VCardContact {
  name: string;
  email: string;
  phone: string;
  notes: string;
  company: string;
  jobTitle: string;
  timezone: string;
  website: string;
  birthday: string;
  photo: string;
  address: string;
  /** The vCard UID: made here for a new contact, the server's for a saved one. */
  uid?: string;
  /** Original vCard content from the server, used for round-trip-safe saves. */
  _originalContent?: string;
}

/**
 * Escape a text value for vCard output.
 */
export const escapeVCardText = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

/**
 * The N (structured name) line for a display name: the last word is the
 * family name and the rest the given name, the same split the API makes when
 * it writes a card itself.
 */
export const structuredNameLine = (name: string): string => {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  const family = parts.length > 1 ? (parts.pop() as string) : '';
  return `N:${escapeVCardText(family)};${escapeVCardText(parts.join(' '))};;;`;
};

/** A UID for a contact created on this device. */
export const newVCardUid = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;

/**
 * Build a fresh minimal vCard from a Contact (used for brand-new contacts).
 *
 * N and UID are always written. vCard 3.0 requires N, and the API stores a
 * card sent to it as is: one without N reached the server and this app but
 * never appeared in Apple Contacts, which drops such a card during its
 * CardDAV sync.
 */
export const buildFreshVCard = (contact: VCardContact): string => {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (contact.uid) lines.push(`UID:${contact.uid}`);
  if (contact.name) lines.push(`FN:${escapeVCardText(contact.name)}`);
  lines.push(structuredNameLine(contact.name));
  if (contact.email) lines.push(`EMAIL;TYPE=INTERNET:${contact.email}`);
  if (contact.phone) lines.push(`TEL:${contact.phone}`);
  if (contact.company) lines.push(`ORG:${escapeVCardText(contact.company)}`);
  if (contact.jobTitle) lines.push(`TITLE:${escapeVCardText(contact.jobTitle)}`);
  if (contact.website) lines.push(`URL:${contact.website}`);
  if (contact.address) lines.push(`ADR:${escapeVCardText(contact.address)}`);
  if (contact.birthday) lines.push(`BDAY:${contact.birthday.replace(/-/g, '')}`);
  if (contact.timezone) lines.push(`TZ:${contact.timezone}`);
  if (contact.notes) lines.push(`NOTE:${escapeVCardText(contact.notes)}`);
  if (contact.photo) {
    const photoData = contact.photo.replace(/^data:image\/[^;]+;base64,/, '');
    lines.push(`PHOTO;ENCODING=b;TYPE=PNG:${photoData}`);
  }
  lines.push('END:VCARD');
  return lines.join('\r\n');
};

/**
 * Extract the vCard property key from a raw line key-part, stripping group
 * prefixes (e.g. "item1.TEL;type=CELL" → "TEL") and parameters.
 */
export const vcardPropKey = (keyPart: string): string => {
  const rawKey = keyPart.split(';')[0].toUpperCase();
  return rawKey.includes('.') ? rawKey.split('.').pop()! : rawKey;
};

/**
 * Round-trip-safe vCard generator.  When the contact has original vCard
 * content from the server (_originalContent), edits are merged back into
 * that content so that all properties the UI does not edit (extra phones,
 * extra emails, addresses, labels, vendor extensions, UID, PRODID, REV,
 * N, X-ABLabel, etc.) are preserved verbatim.
 *
 * For brand-new contacts (no _originalContent), a fresh vCard is built.
 */
export const generateVCard = (contact: VCardContact): string => {
  if (!contact._originalContent) return buildFreshVCard(contact);

  // Unfold the original content
  const rawLines = contact._originalContent.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

  // Track which editable properties we've seen so we know what to insert
  let fnSeen = false;
  let firstEmailSeen = false;
  let firstTelSeen = false;
  let noteSeen = false;
  let orgSeen = false;
  let titleSeen = false;
  let urlSeen = false;
  let adrSeen = false;
  let bdaySeen = false;
  let tzSeen = false;
  let photoSeen = false;
  let nSeen = false;
  let uidSeen = false;

  const result: string[] = [];

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) {
      result.push(line);
      continue;
    }

    const keyPart = line.slice(0, colonIndex);
    const key = vcardPropKey(keyPart);

    if (key === 'BEGIN' || key === 'END' || key === 'VERSION') {
      result.push(line);
      continue;
    }

    if (key === 'N') nSeen = true;
    if (key === 'UID') uidSeen = true;

    if (key === 'FN') {
      if (!fnSeen) {
        fnSeen = true;
        if (contact.name) {
          result.push(`FN:${escapeVCardText(contact.name)}`);
        }
        // If name is empty, drop the FN line
      } else {
        result.push(line); // preserve additional FN lines
      }
    } else if (key === 'EMAIL') {
      if (!firstEmailSeen) {
        firstEmailSeen = true;
        if (contact.email) {
          // Preserve the original parameters (TYPE=INTERNET, etc.)
          result.push(`${keyPart}:${contact.email}`);
        }
        // If email cleared, drop this line
      } else {
        result.push(line); // preserve additional emails verbatim
      }
    } else if (key === 'TEL') {
      if (!firstTelSeen) {
        firstTelSeen = true;
        if (contact.phone) {
          result.push(`${keyPart}:${contact.phone}`);
        }
      } else {
        result.push(line); // preserve additional phones verbatim
      }
    } else if (key === 'NOTE') {
      if (!noteSeen) {
        noteSeen = true;
        if (contact.notes) {
          result.push(`NOTE:${escapeVCardText(contact.notes)}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'ORG') {
      if (!orgSeen) {
        orgSeen = true;
        if (contact.company) {
          result.push(`ORG:${escapeVCardText(contact.company)}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'TITLE') {
      if (!titleSeen) {
        titleSeen = true;
        if (contact.jobTitle) {
          result.push(`TITLE:${escapeVCardText(contact.jobTitle)}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'URL') {
      if (!urlSeen) {
        urlSeen = true;
        if (contact.website) {
          result.push(`${keyPart}:${contact.website}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'ADR') {
      if (!adrSeen) {
        adrSeen = true;
        if (contact.address) {
          result.push(`${keyPart}:${contact.address}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'BDAY') {
      if (!bdaySeen) {
        bdaySeen = true;
        if (contact.birthday) {
          result.push(`BDAY:${contact.birthday.replace(/-/g, '')}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'TZ') {
      if (!tzSeen) {
        tzSeen = true;
        if (contact.timezone) {
          result.push(`TZ:${contact.timezone}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'PHOTO') {
      if (!photoSeen) {
        photoSeen = true;
        if (contact.photo) {
          const photoData = contact.photo.replace(/^data:image\/[^;]+;base64,/, '');
          result.push(`PHOTO;ENCODING=b;TYPE=PNG:${photoData}`);
        }
      } else {
        result.push(line);
      }
    } else {
      // Preserve ALL unknown/unedited properties verbatim:
      // N, PRODID, UID, REV, X-ABLabel, X-ABADR, X-ABUID, etc.
      result.push(line);
    }
  }

  // Insert any new fields the user added that weren't in the original
  const insertBefore = result.findIndex((l) => l.toUpperCase().startsWith('END:VCARD'));
  const insertAt = insertBefore >= 0 ? insertBefore : result.length;
  const toInsert: string[] = [];

  // A card saved before N and UID were always written gets them on its next
  // save, so it starts to sync to strict CardDAV clients too. The UID is the
  // one the server already holds for the contact.
  if (!uidSeen && contact.uid) toInsert.push(`UID:${contact.uid}`);
  if (!fnSeen && contact.name) toInsert.push(`FN:${escapeVCardText(contact.name)}`);
  if (!nSeen) toInsert.push(structuredNameLine(contact.name));
  if (!firstEmailSeen && contact.email) toInsert.push(`EMAIL;TYPE=INTERNET:${contact.email}`);
  if (!firstTelSeen && contact.phone) toInsert.push(`TEL:${contact.phone}`);
  if (!orgSeen && contact.company) toInsert.push(`ORG:${escapeVCardText(contact.company)}`);
  if (!titleSeen && contact.jobTitle) toInsert.push(`TITLE:${escapeVCardText(contact.jobTitle)}`);
  if (!urlSeen && contact.website) toInsert.push(`URL:${contact.website}`);
  if (!adrSeen && contact.address) toInsert.push(`ADR:${escapeVCardText(contact.address)}`);
  if (!bdaySeen && contact.birthday) toInsert.push(`BDAY:${contact.birthday.replace(/-/g, '')}`);
  if (!tzSeen && contact.timezone) toInsert.push(`TZ:${contact.timezone}`);
  if (!noteSeen && contact.notes) toInsert.push(`NOTE:${escapeVCardText(contact.notes)}`);
  if (!photoSeen && contact.photo) {
    const photoData = contact.photo.replace(/^data:image\/[^;]+;base64,/, '');
    toInsert.push(`PHOTO;ENCODING=b;TYPE=PNG:${photoData}`);
  }

  if (toInsert.length) {
    result.splice(insertAt, 0, ...toInsert);
  }

  return result.join('\r\n');
};
