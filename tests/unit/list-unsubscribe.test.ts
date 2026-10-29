import { describe, expect, it } from 'vitest';
import { getUnsubscribeOptions, listUnsubscribeTargets } from '../../src/utils/list-unsubscribe';

// Shapes as the API returns them: mailparser's headerLines plus its parsed `list`
const withLines = (lines: Record<string, string>) => ({
  headerLines: Object.entries(lines).map(([key, value]) => ({
    key,
    line: `${key}: ${value}`,
  })),
  headers: {},
});

describe('getUnsubscribeOptions', () => {
  it('returns null for a message that is not from a list', () => {
    expect(getUnsubscribeOptions(withLines({ subject: 'hi' }))).toBeNull();
    expect(getUnsubscribeOptions(null)).toBeNull();
  });

  it('reads both targets and one-click support from the raw header lines', () => {
    const options = getUnsubscribeOptions(
      withLines({
        'list-unsubscribe':
          '<https://news.example.com/u?id=1>, <mailto:unsub@news.example.com?subject=stop%20please>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      }),
    );
    expect(options).toEqual({
      url: 'https://news.example.com/u?id=1',
      mail: { to: 'unsub@news.example.com', subject: 'stop please', body: 'unsubscribe' },
      oneClick: true,
    });
  });

  it('unfolds a header split across lines', () => {
    expect(listUnsubscribeTargets('<mailto:a@list.example>,\r\n <https://list.example/u>')).toEqual(
      ['mailto:a@list.example', 'https://list.example/u'],
    );
  });

  it('falls back to the parsed list header', () => {
    const options = getUnsubscribeOptions({
      headers: { list: { unsubscribe: { url: 'https://x.example/u', mail: 'u@x.example' } } },
    });
    expect(options?.url).toBe('https://x.example/u');
    expect(options?.mail?.to).toBe('u@x.example');
    expect(options?.oneClick).toBe(false);
  });

  it('ignores targets it must not open', () => {
    const options = getUnsubscribeOptions(
      withLines({
        'list-unsubscribe':
          '<http://plain.example/u>, <javascript:alert(1)>, <https://user:pw@x.example/u>, <data:text/html,x>',
      }),
    );
    expect(options).toBeNull();
  });

  it('does not claim one-click without an https target', () => {
    const options = getUnsubscribeOptions(
      withLines({
        'list-unsubscribe': '<mailto:u@x.example>',
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      }),
    );
    expect(options?.oneClick).toBe(false);
  });

  it('rejects a mailto without a usable address', () => {
    expect(
      getUnsubscribeOptions(withLines({ 'list-unsubscribe': '<mailto:?subject=x>' })),
    ).toBeNull();
  });
});
