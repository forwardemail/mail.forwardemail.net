import { describe, it, expect, vi } from 'vitest';
import {
  getFromDisplay,
  getConversationFromDisplay,
  getConversationFromName,
  getMessageFromName,
  getInitials,
  getProfileInitials,
  getAvatarColor,
} from '../../../../src/svelte/mailbox/utils/avatar-helpers';

// Mock the dependencies
vi.mock('../../../../src/utils/date', () => ({}));

vi.mock('../../../../src/utils/address', () => ({
  extractAddressList: (msg, field) => {
    if (!msg) return [];
    const value = msg[field] || msg[field.charAt(0).toUpperCase() + field.slice(1)];
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  },
  displayAddresses: (list) => list,
  extractDisplayName: (email) => {
    if (!email) return '';
    if (email.includes('<')) {
      const match = email.match(/^([^<]+)/);
      return match ? match[1].trim() : email;
    }
    return email;
  },
}));

describe('avatar-helpers', () => {
  describe('getFromDisplay', () => {
    it('extracts display name from message', () => {
      const message = {
        from: 'John Doe <john@example.com>',
      };

      const result = getFromDisplay(message);

      expect(result).toBe('John Doe <john@example.com>');
    });

    it('returns email if no display name', () => {
      const message = {
        from: 'john@example.com',
      };

      const result = getFromDisplay(message);

      expect(result).toBe('john@example.com');
    });

    it('handles uppercase From field', () => {
      const message = {
        From: 'jane@example.com',
      };

      const result = getFromDisplay(message);

      expect(result).toBe('jane@example.com');
    });

    it('handles null message', () => {
      expect(getFromDisplay(null)).toBe('');
    });
  });

  describe('getConversationFromDisplay', () => {
    it('extracts from latest message in conversation', () => {
      const conv = {
        messages: [{ from: 'old@example.com' }, { from: 'latest@example.com' }],
      };

      const result = getConversationFromDisplay(conv);

      expect(result).toBe('latest@example.com');
    });

    it('uses latestFrom fallback', () => {
      const conv = {
        latestFrom: 'fallback@example.com',
        messages: [],
      };

      const result = getConversationFromDisplay(conv);

      expect(result).toBe('fallback@example.com');
    });

    it('handles null conversation', () => {
      expect(getConversationFromDisplay(null)).toBe('');
    });
  });

  describe('getConversationFromName', () => {
    it('extracts display name from conversation', () => {
      const conv = {
        messages: [{ from: 'John Doe <john@example.com>' }],
      };

      const result = getConversationFromName(conv);

      expect(result).toBe('John Doe');
    });
  });

  describe('getMessageFromName', () => {
    it('extracts display name from message', () => {
      const msg = { from: 'Jane Smith <jane@example.com>' };

      const result = getMessageFromName(msg);

      expect(result).toBe('Jane Smith');
    });
  });

  describe('getInitials', () => {
    it('returns initials from full name', () => {
      expect(getInitials('John Doe <john@example.com>')).toBe('JD');
    });

    it('returns first two letters of single name', () => {
      expect(getInitials('John')).toBe('JO');
    });

    it('returns first two letters of email', () => {
      expect(getInitials('john@example.com')).toBe('JO');
    });

    it('handles names with multiple words', () => {
      expect(getInitials('John Michael Doe')).toBe('JD');
    });

    it('handles empty input', () => {
      expect(getInitials('')).toBe('??');
      expect(getInitials(null)).toBe('??');
    });

    it('handles single character name', () => {
      expect(getInitials('J')).toBe('J');
    });
  });

  describe('getProfileInitials', () => {
    it('returns initials from full name', () => {
      expect(getProfileInitials('John Doe')).toBe('JD');
    });

    it('returns first two letters of single name', () => {
      expect(getProfileInitials('John')).toBe('JO');
    });

    it('handles multiple word names', () => {
      expect(getProfileInitials('John Michael Doe')).toBe('JD');
    });

    it('handles empty name', () => {
      expect(getProfileInitials('')).toBe('');
      expect(getProfileInitials(null)).toBe('');
    });

    it('handles whitespace', () => {
      expect(getProfileInitials('  John Doe  ')).toBe('JD');
    });

    it('handles single character', () => {
      expect(getProfileInitials('J')).toBe('J');
    });
  });

  describe('getAvatarColor', () => {
    it('returns consistent color for same email', () => {
      const color1 = getAvatarColor('john@example.com');
      const color2 = getAvatarColor('john@example.com');

      expect(color1).toBe(color2);
      expect(color1).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('returns different colors for different emails', () => {
      const color1 = getAvatarColor('john@example.com');
      const color2 = getAvatarColor('jane@example.com');

      // While not guaranteed, very likely to be different
      expect(color1).not.toBe(color2);
    });

    it('returns default color for empty input', () => {
      expect(getAvatarColor('')).toBe('#6b7280');
      expect(getAvatarColor(null)).toBe('#6b7280');
    });

    it('returns valid hex color', () => {
      const colors = ['john@example.com', 'jane@example.com', 'bob@example.com'].map(
        getAvatarColor,
      );

      colors.forEach((color) => {
        expect(color).toMatch(/^#[0-9a-f]{6}$/);
      });
    });

    it('handles special characters', () => {
      const color = getAvatarColor('test+tag@example.com');
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    });
  });
});
