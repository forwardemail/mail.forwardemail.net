import { describe, it, expect } from 'vitest';

/**
 * Standalone copies of the vCard generation logic from Contacts.svelte.
 * Kept in sync so we can unit-test without mounting the Svelte component.
 */

const escapeVCardText = (value) =>
  value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

function buildFreshVCard(contact) {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (contact.name) lines.push(`FN:${escapeVCardText(contact.name)}`);
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
}

const vcardPropKey = (keyPart) => {
  const rawKey = keyPart.split(';')[0].toUpperCase();
  return rawKey.includes('.') ? rawKey.split('.').pop() : rawKey;
};

function generateVCard(contact) {
  if (!contact._originalContent) return buildFreshVCard(contact);

  const rawLines = contact._originalContent.split(/\r?\n/);
  const lines = [];
  for (const line of rawLines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }

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

  const result = [];

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

    if (key === 'FN') {
      if (!fnSeen) {
        fnSeen = true;
        if (contact.name) {
          result.push(`FN:${escapeVCardText(contact.name)}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'EMAIL') {
      if (!firstEmailSeen) {
        firstEmailSeen = true;
        if (contact.email) {
          result.push(`${keyPart}:${contact.email}`);
        }
      } else {
        result.push(line);
      }
    } else if (key === 'TEL') {
      if (!firstTelSeen) {
        firstTelSeen = true;
        if (contact.phone) {
          result.push(`${keyPart}:${contact.phone}`);
        }
      } else {
        result.push(line);
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
      result.push(line);
    }
  }

  const insertBefore = result.findIndex((l) => l.toUpperCase().startsWith('END:VCARD'));
  const insertAt = insertBefore >= 0 ? insertBefore : result.length;
  const toInsert = [];

  if (!fnSeen && contact.name) toInsert.push(`FN:${escapeVCardText(contact.name)}`);
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
}

// Helper to create a minimal contact object
function makeContact(overrides = {}) {
  return {
    id: null,
    name: '',
    email: '',
    phone: '',
    notes: '',
    company: '',
    jobTitle: '',
    timezone: '',
    website: '',
    birthday: '',
    photo: '',
    address: '',
    ...overrides,
  };
}

describe('generateVCard', () => {
  describe('fresh vCard (no _originalContent)', () => {
    it('should generate a minimal vCard for a new contact', () => {
      const contact = makeContact({ name: 'John Doe', email: 'john@example.com' });
      const result = generateVCard(contact);
      expect(result).toContain('BEGIN:VCARD');
      expect(result).toContain('VERSION:3.0');
      expect(result).toContain('FN:John Doe');
      expect(result).toContain('EMAIL;TYPE=INTERNET:john@example.com');
      expect(result).toContain('END:VCARD');
    });

    it('should include phone when provided', () => {
      const contact = makeContact({ name: 'Jane', email: 'j@x.com', phone: '+15551234567' });
      const result = generateVCard(contact);
      expect(result).toContain('TEL:+15551234567');
    });

    it('should include address when provided', () => {
      const contact = makeContact({
        name: 'Jane',
        email: 'j@x.com',
        address: ';;123 Main St;City;ST;12345;US',
      });
      const result = generateVCard(contact);
      expect(result).toContain('ADR:');
      expect(result).toContain('123 Main St');
    });

    it('should include all optional fields', () => {
      const contact = makeContact({
        name: 'Full Contact',
        email: 'full@test.com',
        phone: '555-1234',
        company: 'Acme Corp',
        jobTitle: 'Engineer',
        website: 'https://acme.com',
        birthday: '1990-05-22',
        timezone: 'America/Chicago',
        notes: 'A note',
        address: ';;456 Oak Ave;Town;CA;90210;US',
      });
      const result = generateVCard(contact);
      expect(result).toContain('ORG:Acme Corp');
      expect(result).toContain('TITLE:Engineer');
      expect(result).toContain('URL:https://acme.com');
      expect(result).toContain('BDAY:19900522');
      expect(result).toContain('TZ:America/Chicago');
      expect(result).toContain('NOTE:A note');
      expect(result).toContain('ADR:');
    });

    it('should escape special characters in text fields', () => {
      const contact = makeContact({
        name: "O'Brien, Jr.",
        email: 'ob@test.com',
        notes: 'Line one\nLine two; semicolon',
      });
      const result = generateVCard(contact);
      expect(result).toContain("FN:O'Brien\\, Jr.");
      expect(result).toContain('NOTE:Line one\\nLine two\\; semicolon');
    });

    it('should omit empty fields', () => {
      const contact = makeContact({ name: 'Minimal', email: 'min@test.com' });
      const result = generateVCard(contact);
      expect(result).not.toContain('TEL:');
      expect(result).not.toContain('ORG:');
      expect(result).not.toContain('TITLE:');
      expect(result).not.toContain('URL:');
      expect(result).not.toContain('BDAY:');
      expect(result).not.toContain('TZ:');
      expect(result).not.toContain('NOTE:');
      expect(result).not.toContain('ADR:');
    });
  });

  describe('merge mode (with _originalContent)', () => {
    it('should preserve unknown properties verbatim', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'PRODID:-//Apple Inc.//iOS 17.0//EN',
        'UID:abc-123-def',
        'N:Doe;John;;;',
        'FN:John Doe',
        'EMAIL;TYPE=INTERNET:john@example.com',
        'REV:20240101T000000Z',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'John Doe',
        email: 'john@example.com',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).toContain('PRODID:-//Apple Inc.//iOS 17.0//EN');
      expect(result).toContain('UID:abc-123-def');
      expect(result).toContain('N:Doe;John;;;');
      expect(result).toContain('REV:20240101T000000Z');
    });

    it('should update the first FN when name changes', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Old Name',
        'EMAIL:old@test.com',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'New Name',
        email: 'old@test.com',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).toContain('FN:New Name');
      expect(result).not.toContain('FN:Old Name');
    });

    it('should update the first email while preserving its parameters', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'item1.EMAIL;type=INTERNET;type=HOME;type=pref:old@home.com',
        'item2.EMAIL;type=INTERNET;type=WORK:work@office.com',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        email: 'new@home.com',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      // First email updated with original parameters preserved
      expect(result).toContain('item1.EMAIL;type=INTERNET;type=HOME;type=pref:new@home.com');
      // Second email preserved verbatim
      expect(result).toContain('item2.EMAIL;type=INTERNET;type=WORK:work@office.com');
    });

    it('should update the first phone while preserving additional phones', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'item1.TEL;type=CELL;type=VOICE;type=pref:+1 (555) 111-1111',
        'item2.TEL;type=HOME;type=VOICE:+1 (555) 222-2222',
        'item3.TEL;type=WORK;type=VOICE:+1 (555) 333-3333',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        phone: '+1 (555) 999-9999',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      // First phone updated with original parameters
      expect(result).toContain('item1.TEL;type=CELL;type=VOICE;type=pref:+1 (555) 999-9999');
      // Additional phones preserved verbatim
      expect(result).toContain('item2.TEL;type=HOME;type=VOICE:+1 (555) 222-2222');
      expect(result).toContain('item3.TEL;type=WORK;type=VOICE:+1 (555) 333-3333');
    });

    it('should preserve X-ABLabel and other vendor extensions', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'item1.TEL;type=pref:+15551234567',
        'item1.X-ABLabel:mobile',
        'item2.TEL:+15559876543',
        'item2.X-ABLabel:home',
        'X-ABADR:us',
        'X-ABUID:abc-123:ABPerson',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        phone: '+15551234567',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).toContain('item1.X-ABLabel:mobile');
      expect(result).toContain('item2.X-ABLabel:home');
      expect(result).toContain('X-ABADR:us');
      expect(result).toContain('X-ABUID:abc-123:ABPerson');
    });

    it('should preserve multiple addresses when only the first is editable', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'item1.ADR;type=HOME:;;123 Home St;City;ST;12345;US',
        'item1.X-ABLabel:Home',
        'item2.ADR;type=WORK:;;456 Work Ave;Town;CA;90210;US',
        'item2.X-ABLabel:Work',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        address: ';;789 New St;Village;NY;10001;US',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      // First address updated
      expect(result).toContain('item1.ADR;type=HOME:;;789 New St;Village;NY;10001;US');
      // Second address preserved
      expect(result).toContain('item2.ADR;type=WORK:;;456 Work Ave;Town;CA;90210;US');
    });

    it('should insert new fields that were not in the original', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'EMAIL:test@example.com',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        email: 'test@example.com',
        phone: '+15551234567',
        company: 'New Corp',
        address: ';;123 Main St;City;ST;12345;US',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).toContain('TEL:+15551234567');
      expect(result).toContain('ORG:New Corp');
      expect(result).toContain('ADR:');
      // New fields should be before END:VCARD
      const endIndex = result.indexOf('END:VCARD');
      expect(result.indexOf('TEL:')).toBeLessThan(endIndex);
      expect(result.indexOf('ORG:')).toBeLessThan(endIndex);
    });

    it('should remove a field when the user clears it', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'EMAIL:test@example.com',
        'TEL:+15551234567',
        'ORG:Old Corp',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        email: 'test@example.com',
        phone: '',
        company: '',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).not.toContain('TEL:');
      expect(result).not.toContain('ORG:');
    });

    it('should handle a full iOS vCard round-trip without data loss', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'PRODID:-//Apple Inc.//iOS 17.4.1//EN',
        'N:Appleseed;Johnny;;;',
        'FN:Johnny Appleseed',
        'item1.ORG:Apple Inc.;Engineering',
        'TITLE:Chief Seed Officer',
        'item1.TEL;type=CELL;type=VOICE;type=pref:+1 (555) 123-4567',
        'item1.X-ABLabel:mobile',
        'item2.TEL;type=HOME;type=VOICE:+1 (555) 987-6543',
        'item2.X-ABLabel:home',
        'item3.TEL;type=WORK;type=VOICE:+1 (555) 456-7890',
        'item3.X-ABLabel:work',
        'item4.EMAIL;type=INTERNET;type=HOME;type=pref:johnny@icloud.com',
        'item4.X-ABLabel:home',
        'item5.EMAIL;type=INTERNET;type=WORK:johnny@apple.com',
        'item5.X-ABLabel:work',
        'item6.URL;type=pref:https://www.apple.com',
        'item6.X-ABLabel:homepage',
        'item7.ADR;type=HOME:;;1 Infinite Loop;Cupertino;CA;95014;United States',
        'item7.X-ABADR:us',
        'BDAY:19850224',
        'NOTE:Met at WWDC 2024.\\nGreat conversation about trees.',
        'X-ABUID:abc-123:ABPerson',
        'REV:20240615T120000Z',
        'END:VCARD',
      ].join('\r\n');

      // Simulate editing only the name — everything else should be preserved
      const contact = makeContact({
        name: 'Johnny B. Appleseed',
        email: 'johnny@icloud.com',
        phone: '+1 (555) 123-4567',
        company: 'Apple Inc.;Engineering',
        jobTitle: 'Chief Seed Officer',
        website: 'https://www.apple.com',
        birthday: '1985-02-24',
        notes: 'Met at WWDC 2024.\nGreat conversation about trees.',
        address: ';;1 Infinite Loop;Cupertino;CA;95014;United States',
        _originalContent: original,
      });

      const result = generateVCard(contact);

      // Updated field
      expect(result).toContain('FN:Johnny B. Appleseed');
      expect(result).not.toContain('FN:Johnny Appleseed');

      // All other properties preserved
      expect(result).toContain('PRODID:-//Apple Inc.//iOS 17.4.1//EN');
      expect(result).toContain('N:Appleseed;Johnny;;;');
      // ORG is regenerated through escapeVCardText, so semicolons get escaped
      expect(result).toContain('ORG:Apple Inc.\\;Engineering');
      expect(result).toContain('TITLE:Chief Seed Officer');

      // All three phones preserved
      expect(result).toContain('item1.TEL;type=CELL;type=VOICE;type=pref:+1 (555) 123-4567');
      expect(result).toContain('item2.TEL;type=HOME;type=VOICE:+1 (555) 987-6543');
      expect(result).toContain('item3.TEL;type=WORK;type=VOICE:+1 (555) 456-7890');

      // All labels preserved
      expect(result).toContain('item1.X-ABLabel:mobile');
      expect(result).toContain('item2.X-ABLabel:home');
      expect(result).toContain('item3.X-ABLabel:work');
      expect(result).toContain('item4.X-ABLabel:home');
      expect(result).toContain('item5.X-ABLabel:work');
      expect(result).toContain('item6.X-ABLabel:homepage');

      // Both emails preserved
      expect(result).toContain('item4.EMAIL;type=INTERNET;type=HOME;type=pref:johnny@icloud.com');
      expect(result).toContain('item5.EMAIL;type=INTERNET;type=WORK:johnny@apple.com');

      // URL, address, birthday, notes, vendor extensions
      expect(result).toContain('item6.URL;type=pref:https://www.apple.com');
      expect(result).toContain(
        'item7.ADR;type=HOME:;;1 Infinite Loop;Cupertino;CA;95014;United States',
      );
      expect(result).toContain('item7.X-ABADR:us');
      expect(result).toContain('BDAY:19850224');
      expect(result).toContain('X-ABUID:abc-123:ABPerson');
      expect(result).toContain('REV:20240615T120000Z');
    });

    it('should handle folded lines in original content', () => {
      const original = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Test',
        'NOTE:This is a very long note that has been',
        '  folded across multiple lines in the',
        '  original vCard content',
        'END:VCARD',
      ].join('\r\n');

      const contact = makeContact({
        name: 'Test',
        notes: 'Updated note',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).toContain('NOTE:Updated note');
      expect(result).not.toContain('very long note');
    });

    it('should handle \\n line endings in original content', () => {
      const original = 'BEGIN:VCARD\nVERSION:3.0\nFN:Test\nEMAIL:test@test.com\nEND:VCARD';

      const contact = makeContact({
        name: 'Test Updated',
        email: 'test@test.com',
        _originalContent: original,
      });
      const result = generateVCard(contact);
      expect(result).toContain('FN:Test Updated');
      expect(result).toContain('EMAIL:test@test.com');
    });
  });

  describe('escapeVCardText', () => {
    it('should escape backslashes', () => {
      expect(escapeVCardText('a\\b')).toBe('a\\\\b');
    });

    it('should escape semicolons', () => {
      expect(escapeVCardText('a;b')).toBe('a\\;b');
    });

    it('should escape commas', () => {
      expect(escapeVCardText('a,b')).toBe('a\\,b');
    });

    it('should escape newlines', () => {
      expect(escapeVCardText('a\nb')).toBe('a\\nb');
    });

    it('should handle multiple special characters', () => {
      expect(escapeVCardText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
    });
  });
});
