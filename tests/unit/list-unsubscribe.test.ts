import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canSendOneClick,
  getUnsubscribeOptions,
  isOneClickUrl,
  listUnsubscribeTargets,
  sendOneClickUnsubscribe,
} from '../../src/utils/list-unsubscribe';

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

describe('one-click unsubscribe', () => {
  const oneClick = (target: string) =>
    getUnsubscribeOptions(
      withLines({
        'list-unsubscribe': `<${target}>`,
        'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      }),
    );

  it('is only claimed for an https URL on a public host name', () => {
    expect(oneClick('https://news.example.com/u?id=1')?.oneClick).toBe(true);
    expect(oneClick('https://xn--mnchen-3ya.example.de/u')?.oneClick).toBe(true);

    // (a device on the user's own network, or not the default port: the page
    // may still be opened, but nothing is sent to it from here)
    for (const target of [
      'https://192.168.1.1/u',
      'https://127.0.0.1/u',
      'https://2130706433/u',
      'https://[::1]/u',
      'https://localhost/u',
      'https://router.local/u',
      'https://nas.home.arpa/u',
      'https://printer.lan/u',
      'https://intranet/u',
      'https://news.example.com:8443/u',
      `https://news.example.com/${'a'.repeat(3000)}`,
    ]) {
      expect(oneClick(target)?.oneClick, target).toBe(false);
    }
    expect(isOneClickUrl('http://news.example.com/u')).toBe(false);
    expect(isOneClickUrl('not a url')).toBe(false);
  });

  describe('sendOneClickUnsubscribe', () => {
    const url = 'https://news.example.com/u?id=1';

    function withServiceWorker(reply: ((data: unknown) => unknown) | null) {
      const postMessage = vi.fn((data: unknown, [port]: MessagePort[]) => {
        if (reply) port.postMessage(reply(data));
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: { controller: { postMessage } },
      });
      return postMessage;
    }

    afterEach(() => {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    });

    it('asks the service worker to send it, and resolves with whether it was sent', async () => {
      const postMessage = withServiceWorker(() => ({ ok: true }));
      expect(canSendOneClick()).toBe(true);
      await expect(sendOneClickUnsubscribe(url)).resolves.toBe(true);
      expect(postMessage).toHaveBeenCalledWith({ type: 'one-click-unsubscribe', url }, [
        expect.any(MessagePort),
      ]);

      withServiceWorker(() => ({ ok: false }));
      await expect(sendOneClickUnsubscribe(url)).resolves.toBe(false);
    });

    it('is not sent without a service worker, to a local host, or past the timeout', async () => {
      expect(canSendOneClick()).toBe(false);
      await expect(sendOneClickUnsubscribe(url)).resolves.toBe(false);

      const postMessage = withServiceWorker(() => ({ ok: true }));
      await expect(sendOneClickUnsubscribe('https://192.168.1.1/u')).resolves.toBe(false);
      expect(postMessage).not.toHaveBeenCalled();

      withServiceWorker(null);
      await expect(sendOneClickUnsubscribe(url, 50)).resolves.toBe(false);
    });
  });
});
