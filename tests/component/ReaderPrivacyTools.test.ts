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
});

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
});
