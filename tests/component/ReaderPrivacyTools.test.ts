/**
 * The reader additions must stay invisible for an ordinary message: no
 * banner, no button, no extra space. They appear only when a message carries
 * what they act on, and nothing is sent or opened without a confirmation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const hoisted = vi.hoisted(() => ({
  queueEmail: vi.fn(async () => ({})),
  openExternalUrl: vi.fn(async () => {}),
}));

vi.mock('../../src/utils/outbox-service.js', () => ({ queueEmail: hoisted.queueEmail }));
vi.mock('../../src/utils/external-links.js', () => ({ openExternalUrl: hoisted.openExternalUrl }));

import UnsubscribeButton from '../../src/svelte/components/UnsubscribeButton.svelte';
import SenderWarningBanner from '../../src/svelte/components/SenderWarningBanner.svelte';

afterEach(() => {
  cleanup();
  hoisted.queueEmail.mockClear();
  hoisted.openExternalUrl.mockClear();
  Reflect.deleteProperty(navigator, 'serviceWorker');
});

// The web app's service worker, which sends the one-click POST
// (public/sw-sync.js), replying whether it was sent
function withServiceWorker(ok: boolean) {
  const postMessage = vi.fn((_data: unknown, [port]: MessagePort[]) => port.postMessage({ ok }));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { controller: { postMessage } },
  });
  return postMessage;
}

const plain = {
  from: 'Example News <news@example.com>',
  nodemailer: {
    headers: { from: { value: [{ name: 'Example News', address: 'news@example.com' }] } },
    headerLines: [{ key: 'subject', line: 'Subject: hello' }],
  },
};

const listMail = (target: string) => ({
  headerLines: [{ key: 'list-unsubscribe', line: `List-Unsubscribe: <${target}>` }],
});

// (both targets, and RFC 8058 one-click support)
const oneClickMail = {
  headerLines: [
    {
      key: 'list-unsubscribe',
      line: 'List-Unsubscribe: <mailto:leave@news.example.com>, <https://news.example.com/u?id=1>',
    },
    { key: 'list-unsubscribe-post', line: 'List-Unsubscribe-Post: List-Unsubscribe=One-Click' },
  ],
};

describe('ordinary messages', () => {
  it('render no banner and no unsubscribe button', () => {
    const { container: banner } = render(SenderWarningBanner, { props: { message: plain } });
    expect(banner.textContent?.trim()).toBe('');
    cleanup();
    const { container: button } = render(UnsubscribeButton, {
      props: { nodemailer: plain.nodemailer },
    });
    expect(button.textContent?.trim()).toBe('');
  });
});

describe('<SenderWarningBanner />', () => {
  it('shows what is wrong with an impersonating display name', () => {
    render(SenderWarningBanner, {
      props: {
        message: {
          nodemailer: {
            headers: {
              from: { value: [{ name: 'PayPal <service@paypal.com>', address: 'x@evil.test' }] },
            },
          },
        },
      },
    });
    const banner = screen.getByTestId('sender-warning');
    expect(banner.getAttribute('data-warning-kinds')).toBe('display-name');
    expect(banner.textContent).toContain('service@paypal.com');
  });
});

describe('<UnsubscribeButton />', () => {
  it('sends the unsubscribe email only after confirming, kept out of Sent', async () => {
    const onToast = vi.fn();
    render(UnsubscribeButton, {
      props: {
        nodemailer: listMail('mailto:leave@list.example?subject=remove'),
        account: 'me@example.org',
        onToast,
      },
    });
    await fireEvent.click(screen.getByTestId('reader-unsubscribe'));
    expect(hoisted.queueEmail).not.toHaveBeenCalled();
    expect(await screen.findByText('leave@list.example')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('reader-unsubscribe-confirm'));
    await waitFor(() => expect(hoisted.queueEmail).toHaveBeenCalledTimes(1));
    expect(hoisted.queueEmail).toHaveBeenCalledWith({
      from: 'me@example.org',
      to: ['leave@list.example'],
      subject: 'remove',
      text: 'unsubscribe',
      save_sent: false,
    });
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('leave@list.example'), 'success');
    expect(await screen.findByTestId('reader-unsubscribe-done')).toBeTruthy();
  });

  it('opens an https target in the browser after confirming', async () => {
    render(UnsubscribeButton, {
      props: { nodemailer: listMail('https://list.example/u?t=1') },
    });
    await fireEvent.click(screen.getByTestId('reader-unsubscribe'));
    await fireEvent.click(await screen.findByTestId('reader-unsubscribe-confirm'));
    await waitFor(() =>
      expect(hoisted.openExternalUrl).toHaveBeenCalledWith('https://list.example/u?t=1'),
    );
    expect(hoisted.queueEmail).not.toHaveBeenCalled();
  });

  it('keeps the button when sending is refused (demo mode)', async () => {
    hoisted.queueEmail.mockRejectedValueOnce(Object.assign(new Error('demo'), { isDemo: true }));
    const onToast = vi.fn();
    render(UnsubscribeButton, {
      props: { nodemailer: listMail('mailto:leave@list.example'), onToast },
    });
    await fireEvent.click(screen.getByTestId('reader-unsubscribe'));
    await fireEvent.click(await screen.findByTestId('reader-unsubscribe-confirm'));
    await waitFor(() => expect(hoisted.queueEmail).toHaveBeenCalled());
    expect(onToast).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reader-unsubscribe-done')).toBeNull();
  });

  it('sends the one-click request from this device after confirming', async () => {
    const postMessage = withServiceWorker(true);
    const onToast = vi.fn();
    render(UnsubscribeButton, { props: { nodemailer: oneClickMail, onToast } });

    await fireEvent.click(screen.getByTestId('reader-unsubscribe'));
    expect(postMessage).not.toHaveBeenCalled();
    expect(await screen.findByText('news.example.com')).toBeTruthy();
    expect(screen.getByText(/without your cookies/)).toBeTruthy();

    await fireEvent.click(screen.getByTestId('reader-unsubscribe-confirm'));
    expect(await screen.findByTestId('reader-unsubscribe-done')).toBeTruthy();
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'one-click-unsubscribe', url: 'https://news.example.com/u?id=1' },
      [expect.any(MessagePort)],
    );
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining('news.example.com'), 'success');
    // (nothing else is sent or opened)
    expect(hoisted.queueEmail).not.toHaveBeenCalled();
    expect(hoisted.openExternalUrl).not.toHaveBeenCalled();
  });

  it('offers the email instead when the one-click request could not be sent', async () => {
    withServiceWorker(false);
    const onToast = vi.fn();
    render(UnsubscribeButton, {
      props: { nodemailer: oneClickMail, account: 'me@example.org', onToast },
    });

    await fireEvent.click(screen.getByTestId('reader-unsubscribe'));
    await fireEvent.click(await screen.findByTestId('reader-unsubscribe-confirm'));
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(expect.stringContaining('news.example.com'), 'error'),
    );
    // (nothing else was done without asking: the dialog now names the email)
    expect(hoisted.queueEmail).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reader-unsubscribe-done')).toBeNull();
    expect(await screen.findByText('leave@news.example.com')).toBeTruthy();

    await fireEvent.click(screen.getByTestId('reader-unsubscribe-confirm'));
    await waitFor(() => expect(hoisted.queueEmail).toHaveBeenCalledTimes(1));
    expect(hoisted.queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'me@example.org', to: ['leave@news.example.com'] }),
    );
  });

  it('uses the email without a service worker (the desktop and mobile apps)', async () => {
    render(UnsubscribeButton, {
      props: { nodemailer: oneClickMail, account: 'me@example.org' },
    });
    await fireEvent.click(screen.getByTestId('reader-unsubscribe'));
    expect(await screen.findByText('leave@news.example.com')).toBeTruthy();
    await fireEvent.click(screen.getByTestId('reader-unsubscribe-confirm'));
    await waitFor(() => expect(hoisted.queueEmail).toHaveBeenCalledTimes(1));
  });
});
