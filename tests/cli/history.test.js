/**
 * Page loads in the terminal document (src/cli/history.ts), against a real
 * TermDOM window: what a browser would load as a new page starts the app
 * over, other sites open in the system browser, and moves within the page
 * stay TermDOM's own.
 */
import { TermDOM } from '@b9g/termdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installHistory } from '../../src/cli/history';
import { openInBrowser } from '../../src/cli/open-url';

vi.mock('../../src/cli/open-url', () => ({ openInBrowser: vi.fn(() => true) }));

const quietTransport = () => ({
  cols: 80,
  rows: 24,
  colorDepth: 'rgb',
  interactive: false,
  sharesScreen: false,
  readable: new ReadableStream({}),
  writable: new WritableStream({}),
  resizes: new ReadableStream({}),
  ready: Promise.resolve(),
  closed: new Promise(() => {}),
  close() {},
});

function start(url = 'https://mail.forwardemail.net/mailbox') {
  const term = new TermDOM({
    html: '<!doctype html><html><body><a href="#top">top</a></body></html>',
    url,
    transport: quietTransport(),
  });
  const win = term.window;
  const reload = vi.fn();
  installHistory(win, { reload });
  return { win, reload };
}

describe('page loads', () => {
  beforeEach(() => vi.mocked(openInBrowser).mockClear());

  it('starts the app over for a new path on the same site', () => {
    const { win, reload } = start();
    win.location.href = '/login';
    win.location.assign('https://mail.forwardemail.net/mailbox?account=2');
    win.location.replace('/calendar');
    expect(reload.mock.calls).toEqual([
      ['https://mail.forwardemail.net/login'],
      ['https://mail.forwardemail.net/mailbox?account=2'],
      ['https://mail.forwardemail.net/calendar'],
    ]);
    expect(win.location.href).toBe('https://mail.forwardemail.net/mailbox');
  });

  it('starts the app over at the same URL on reload()', () => {
    const { win, reload } = start('https://mail.forwardemail.net/mailbox#inbox');
    win.location.reload();
    expect(reload.mock.calls).toEqual([['https://mail.forwardemail.net/mailbox#inbox']]);
  });

  it('opens another site in the system browser and stays on the page', () => {
    const { win, reload } = start();
    win.location.href = 'https://forwardemail.net/en/faq';
    expect(openInBrowser).toHaveBeenCalledWith('https://forwardemail.net/en/faq');
    expect(reload).not.toHaveBeenCalled();
    expect(win.location.href).toBe('https://mail.forwardemail.net/mailbox');
  });

  it('leaves pushState, replaceState, fragments and history moves to TermDOM', async () => {
    const { win, reload } = start();
    win.history.pushState({ view: 'settings' }, '', '/settings');
    win.history.replaceState({ view: 'settings', tab: 2 }, '', '/settings?tab=2');
    win.location.hash = 'labels';
    expect(win.location.href).toBe('https://mail.forwardemail.net/settings?tab=2#labels');

    const popped = new Promise((resolve) =>
      win.addEventListener('popstate', resolve, { once: true }),
    );
    win.history.back();
    await popped;
    expect(win.location.href).toBe('https://mail.forwardemail.net/settings?tab=2');
    expect(win.history.state).toEqual({ view: 'settings', tab: 2 });

    win.history.back();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(win.location.href).toBe('https://mail.forwardemail.net/mailbox');
    expect(reload).not.toHaveBeenCalled();
    expect(openInBrowser).not.toHaveBeenCalled();
  });
});
