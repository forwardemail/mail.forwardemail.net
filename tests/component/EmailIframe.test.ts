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

// The token the component gave the document now in the iframe
function currentToken() {
  const iframe = document.querySelector('iframe.fe-email-iframe') as HTMLIFrameElement;
  const match = /data-fe-token="([^"]*)"/.exec(iframe.getAttribute('srcdoc') || '');
  return match ? match[1] : '';
}

const frame = () => document.querySelector('iframe.fe-email-iframe') as HTMLIFrameElement;

describe('<EmailIframe /> keeps one frame across messages', () => {
  it('keeps the same iframe element when the message changes', async () => {
    const view = render(EmailIframe, { props: { html: '<p>first</p>', messageId: 'a' } });
    const first = frame();
    await view.rerender({ html: '', messageId: 'b' });
    await view.rerender({ html: '<p>second</p>', messageId: 'b' });
    expect(frame()).toBe(first);
    expect(first.getAttribute('srcdoc')).toContain('second');
  });

  it('stays hidden until the current document says it is ready', async () => {
    render(EmailIframe, { props: { html: '<p>body</p>', messageId: 'c' } });
    expect(frame().classList.contains('fe-email-iframe-hidden')).toBe(true);
    postFromIframe({ type: 'ready', payload: { token: currentToken() } });
    await waitFor(() => expect(frame().classList.contains('fe-email-iframe-hidden')).toBe(false));
  });

  it('ignores a height from the document it replaced', async () => {
    const view = render(EmailIframe, { props: { html: '<p>old</p>', messageId: 'd' } });
    const oldToken = currentToken();
    await view.rerender({ html: '<p>new</p>', messageId: 'e' });
    // The previous email's runtime answers late; its height is not the new
    // email's and must not be applied or cached for it.
    postFromIframe({ type: 'height', payload: { height: 1234, token: oldToken } });
    await Promise.resolve();
    expect(frame().style.height).not.toBe('1234px');
    postFromIframe({ type: 'height', payload: { height: 321, token: currentToken() } });
    await waitFor(() => expect(frame().style.height).toBe('321px'));
  });

  it('reserves the measured height when a message is shown again', async () => {
    const view = render(EmailIframe, { props: { html: '<p>tall</p>', messageId: 'f' } });
    postFromIframe({ type: 'height', payload: { height: 950, token: currentToken() } });
    await waitFor(() => expect(frame().style.height).toBe('950px'));
    view.unmount();
    // A fresh instance, as after the reader skeleton or a tab switch
    render(EmailIframe, { props: { html: '<p>tall</p>', messageId: 'f' } });
    expect(frame().style.height).toBe('950px');
  });
});
