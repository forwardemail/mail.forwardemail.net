import { describe, expect, it } from 'vitest';
import { getMessageApiId } from '../../src/utils/sync-helpers.ts';

describe('getMessageApiId', () => {
  it('returns null when the message state is absent', () => {
    expect(getMessageApiId(null)).toBeNull();
    expect(getMessageApiId()).toBeNull();
  });

  it('keeps the existing identifier precedence', () => {
    expect(
      getMessageApiId({
        id: 'id-value',
        message_id: 'message-id-value',
        uid: 42,
      }),
    ).toBe('id-value');
    expect(getMessageApiId({ uid: 42 })).toBe(42);
  });
});
