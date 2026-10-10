import { describe, expect, it } from 'vitest';
import { createMessageId, isEmailAlreadyExistsError } from '../../src/utils/message-id';

describe('createMessageId', () => {
  it("uses the From address's domain", () => {
    expect(createMessageId('me@Example.com')).toMatch(/^<[0-9a-f-]+@example\.com>$/);
  });

  it('reads the address out of a From header with a display name', () => {
    expect(createMessageId('Shaun <shaun@warman.life>')).toMatch(/@warman\.life>$/);
  });

  it('falls back to a fixed domain when there is no address', () => {
    expect(createMessageId('')).toMatch(/@forwardemail\.net>$/);
  });

  it('is different every time', () => {
    expect(createMessageId('me@example.com')).not.toBe(createMessageId('me@example.com'));
  });
});

describe('isEmailAlreadyExistsError', () => {
  it("matches the API's duplicate email error", () => {
    const err = new Error('Email already exists with the same Message-ID, Date, and Envelope.');
    expect(isEmailAlreadyExistsError(err)).toBe(true);
  });

  it('ignores other errors', () => {
    expect(isEmailAlreadyExistsError(new Error('Invalid recipient'))).toBe(false);
    expect(isEmailAlreadyExistsError(null)).toBe(false);
  });
});
