import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';

// The status bar is desktop-app only; the flag is read at module evaluation,
// so it is flipped per test through a hoisted holder the mock reads live.
const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  get isTauriDesktop() {
    return platform.desktop;
  },
}));

import EmailIframe from '../../src/svelte/components/EmailIframe.svelte';

afterEach(() => {
  cleanup();
  platform.desktop = true;
});

/** Post a message the way the sandboxed runtime would, from this iframe's window. */
function postFromIframe(data: Record<string, unknown>) {
  const iframe = document.querySelector('iframe.fe-email-iframe') as HTMLIFrameElement;
  expect(iframe).not.toBeNull();
  window.dispatchEvent(
    new MessageEvent('message', { data, origin: 'null', source: iframe.contentWindow }),
  );
}

describe('<EmailIframe /> link preview status bar', () => {
  it('is hidden until the runtime reports a hovered link', async () => {
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'm1' } });
    expect(screen.queryByTestId('link-preview')).toBeNull();

    postFromIframe({
      type: 'link-hover',
      payload: { url: 'https://forwardemail.net/docs?x=1', text: 'Docs' },
    });
    const bar = await screen.findByTestId('link-preview');
    expect(bar.textContent).toContain('https://');
    expect(bar.textContent).toContain('forwardemail.net');
    expect(bar.textContent).toContain('/docs?x=1');
    expect(bar.classList.contains('fe-link-preview-warn')).toBe(false);

    postFromIframe({ type: 'link-hover-end', payload: {} });
    await waitFor(() => expect(screen.queryByTestId('link-preview')).toBeNull());
  });

  it('warns when the link text names a different host', async () => {
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'm2' } });
    postFromIframe({
      type: 'link-hover',
      payload: { url: 'https://evil.example/login', text: 'https://www.paypal.com/' },
    });
    const bar = await screen.findByTestId('link-preview');
    expect(bar.classList.contains('fe-link-preview-warn')).toBe(true);
    expect(bar.textContent).toContain('Text says www.paypal.com, link goes to');
    expect(bar.textContent).toContain('evil.example');
  });

  it('renders the href as text, never as markup', async () => {
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'm3' } });
    postFromIframe({
      type: 'link-hover',
      payload: { url: 'https://example.org/<img src=x onerror=alert(1)>', text: '' },
    });
    const bar = await screen.findByTestId('link-preview');
    expect(bar.querySelector('img')).toBeNull();
    expect(bar.textContent).toContain('%3Cimg');
  });

  it('ignores unsupported schemes and messages from other windows', async () => {
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'm4' } });
    postFromIframe({ type: 'link-hover', payload: { url: 'javascript:alert(1)', text: 'x' } });
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'link-hover', payload: { url: 'https://example.org/', text: '' } },
        origin: 'null',
        source: window,
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('link-preview')).toBeNull();
  });

  it('stays off in a browser, where the browser draws its own status bar', async () => {
    platform.desktop = false;
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'm6' } });
    postFromIframe({
      type: 'link-hover',
      payload: { url: 'https://forwardemail.net/', text: 'Forward Email' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('link-preview')).toBeNull();
  });

  it('clears the preview when the link is clicked', async () => {
    const onLinkClick = vi.fn();
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'm5', onLinkClick } });
    postFromIframe({
      type: 'link-hover',
      payload: { url: 'https://example.org/', text: '' },
    });
    await screen.findByTestId('link-preview');
    postFromIframe({ type: 'link', payload: { url: 'https://example.org/', isMailto: false } });
    await waitFor(() => expect(screen.queryByTestId('link-preview')).toBeNull());
    expect(onLinkClick).toHaveBeenCalledWith('https://example.org/', false);
  });
});
