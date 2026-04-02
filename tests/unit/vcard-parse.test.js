import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Standalone copy of the parseVCard logic from Contacts.svelte.
 * Kept in sync so we can unit-test without mounting the Svelte component.
 */
function parseVCard(content) {
  if (!content) return { emails: [], phones: [] };
  const parsed = { emails: [], phones: [] };
  const rawLines = content.split(/\r?\n/);
  const lines = [];
  for (const line of rawLines) {
    if (!line) continue;
    if (/^[ \t]/.test(line) && lines.length) {
      lines[lines.length - 1] += line.trimStart();
    } else {
      lines.push(line);
    }
  }
  const unescapeText = (value) =>
    value.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const keyPart = line.slice(0, colonIndex);
    const value = unescapeText(line.slice(colonIndex + 1));
    // Strip vCard property group prefixes (e.g. "item1.TEL" → "TEL").
    const rawKey = keyPart.split(';')[0].toUpperCase();
    const key = rawKey.includes('.') ? rawKey.split('.').pop() : rawKey;

    if (key === 'FN' && !parsed.name) {
      parsed.name = value;
    } else if (key === 'N' && !parsed.name) {
      const [last, first, additional, prefix, suffix] = value.split(';');
      const parts = [prefix, first, additional, last, suffix].filter(Boolean);
      if (parts.length) parsed.name = parts.join(' ').replace(/\s+/g, ' ').trim();
    } else if (key === 'EMAIL') {
      if (value) parsed.emails.push(value);
    } else if (key === 'TEL') {
      const phone = value.replace(/^tel:/i, '');
      if (phone) parsed.phones.push(phone);
    } else if (key === 'NOTE') {
      parsed.notes = value;
    } else if (key === 'ORG') {
      parsed.company = value;
    } else if (key === 'TITLE') {
      parsed.jobTitle = value;
    } else if (key === 'URL') {
      parsed.website = value;
    } else if (key === 'BDAY') {
      if (value.length === 8) {
        parsed.birthday = `${value.substring(0, 4)}-${value.substring(4, 6)}-${value.substring(6, 8)}`;
      } else {
        parsed.birthday = value;
      }
    } else if (key === 'TZ') {
      parsed.timezone = value;
    } else if (key === 'PHOTO') {
      const typeMatch = keyPart.match(/TYPE=([^;:]+)/i);
      const photoType = typeMatch ? typeMatch[1].toLowerCase() : 'png';
      if (value) {
        parsed.photo = value.startsWith('data:')
          ? value
          : `data:image/${photoType};base64,${value}`;
      }
    } else if (key === 'ADR') {
      parsed.address = value;
    }
  }
  return parsed;
}

describe('parseVCard', () => {
  describe('basic vCard parsing', () => {
    it('should parse a simple vCard with no property groups', () => {
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:John Doe',
        'EMAIL;TYPE=INTERNET:john@example.com',
        'TEL:555-1234',
        'END:VCARD',
      ].join('\r\n');

      const result = parseVCard(vcard);
      expect(result.name).toBe('John Doe');
      expect(result.emails).toEqual(['john@example.com']);
      expect(result.phones).toEqual(['555-1234']);
    });

    it('should return empty arrays for empty content', () => {
      expect(parseVCard('')).toEqual({ emails: [], phones: [] });
      expect(parseVCard(null)).toEqual({ emails: [], phones: [] });
    });

    it('should parse N property when FN is missing', () => {
      const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Doe;Jane;;;\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.name).toBe('Jane Doe');
    });

    it('should parse all optional fields', () => {
      const content = readFileSync(
        join(process.cwd(), 'tests/fixtures/vcf/full-contact.vcf'),
        'utf-8',
      );
      const result = parseVCard(content);
      expect(result.name).toBe('Isabella Martinez');
      expect(result.emails).toEqual(['isabella@company.com']);
      expect(result.phones).toEqual(['555-0108']);
      expect(result.company).toBe('Enterprise Inc');
      expect(result.jobTitle).toBe('Senior Developer');
      expect(result.website).toBe('https://isabellamartinez.dev');
      expect(result.timezone).toBe('America/Los_Angeles');
      expect(result.birthday).toBe('1990-05-22');
      expect(result.notes).toBe('Met at conference 2025');
    });
  });

  describe('iOS/macOS property group prefixes', () => {
    it('should strip item1.TEL group prefix and parse phone number', () => {
      const vcard = 'BEGIN:VCARD\r\nitem1.TEL;type=pref:+15551234567\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.phones).toEqual(['+15551234567']);
    });

    it('should strip item2.EMAIL group prefix and parse email', () => {
      const vcard = 'BEGIN:VCARD\r\nitem2.EMAIL;type=INTERNET:test@example.com\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.emails).toEqual(['test@example.com']);
    });

    it('should strip group prefix from URL property', () => {
      const vcard = 'BEGIN:VCARD\r\nitem3.URL:https://example.com\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.website).toBe('https://example.com');
    });

    it('should strip group prefix from ORG property', () => {
      const vcard = 'BEGIN:VCARD\r\nitem1.ORG:Apple Inc.\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.company).toBe('Apple Inc.');
    });

    it('should strip group prefix from ADR property', () => {
      const vcard =
        'BEGIN:VCARD\r\nitem1.ADR;type=HOME:;;123 Main St;City;ST;12345;US\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.address).toBe(';;123 Main St;City;ST;12345;US');
    });

    it('should strip group prefix from TITLE property', () => {
      const vcard = 'BEGIN:VCARD\r\nITEM4.TITLE:Engineer\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.jobTitle).toBe('Engineer');
    });

    it('should parse a full iOS-generated vCard with multiple grouped properties', () => {
      const content = readFileSync(
        join(process.cwd(), 'tests/fixtures/vcf/ios-contact.vcf'),
        'utf-8',
      );
      const result = parseVCard(content);
      expect(result.name).toBe('Johnny Appleseed');
      expect(result.emails).toEqual(['johnny@icloud.com', 'johnny@apple.com']);
      expect(result.phones).toEqual([
        '+1 (555) 123-4567',
        '+1 (555) 987-6543',
        '+1 (555) 456-7890',
      ]);
      expect(result.company).toBe('Apple Inc.;Engineering');
      expect(result.jobTitle).toBe('Chief Seed Officer');
      expect(result.website).toBe('https://www.apple.com');
      expect(result.birthday).toBe('1985-02-24');
      expect(result.notes).toBe('Met at WWDC 2024.\nGreat conversation about trees.');
      expect(result.address).toBe(';;1 Infinite Loop;Cupertino;CA;95014;United States');
    });
  });

  describe('TEL VALUE=uri handling', () => {
    it('should strip tel: URI prefix from phone numbers', () => {
      const vcard = 'BEGIN:VCARD\r\nTEL;VALUE=uri:tel:+15551234567\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.phones).toEqual(['+15551234567']);
    });

    it('should handle tel: URI with type parameter', () => {
      const vcard = 'BEGIN:VCARD\r\nTEL;VALUE=uri;TYPE=home:tel:+15559876543\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.phones).toEqual(['+15559876543']);
    });

    it('should parse a vCard with multiple tel: URI numbers', () => {
      const content = readFileSync(
        join(process.cwd(), 'tests/fixtures/vcf/tel-uri-contact.vcf'),
        'utf-8',
      );
      const result = parseVCard(content);
      expect(result.name).toBe('Uri Test');
      expect(result.emails).toEqual(['uri.test@example.com']);
      expect(result.phones).toEqual(['+15551234567', '+15559876543']);
    });

    it('should handle plain phone numbers without tel: prefix', () => {
      const vcard = 'BEGIN:VCARD\r\nTEL:555-1234\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.phones).toEqual(['555-1234']);
    });
  });

  describe('line folding', () => {
    it('should handle folded lines (continuation with leading whitespace)', () => {
      const vcard = 'BEGIN:VCARD\r\nFN:Very Long Name That Gets\r\n  Folded\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.name).toBe('Very Long Name That GetsFolded');
    });
  });

  describe('escaped characters', () => {
    it('should unescape \\n to newline', () => {
      const vcard = 'BEGIN:VCARD\r\nNOTE:Line one\\nLine two\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.notes).toBe('Line one\nLine two');
    });

    it('should unescape \\, to comma', () => {
      const vcard = 'BEGIN:VCARD\r\nNOTE:Hello\\, world\r\nEND:VCARD';
      const result = parseVCard(vcard);
      expect(result.notes).toBe('Hello, world');
    });
  });
});
