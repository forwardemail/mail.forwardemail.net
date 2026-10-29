import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/svelte';

// The status bar is desktop-app only; the flag is read at module evaluation,
// so it is flipped per test through a hoisted holder the mock reads live.
const platform = vi.hoisted(() => ({ desktop: true, mobile: false }));
vi.mock('../../src/utils/platform.js', () => ({
  isTauri: false,
  get isTauriDesktop() {
    return platform.desktop;
  },
  get isTauriMobile() {
    return platform.mobile;
  },
}));

import EmailIframe from '../../src/svelte/components/EmailIframe.svelte';

afterEach(() => {
  cleanup();
  platform.desktop = true;
  platform.mobile = false;
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

describe('<EmailIframe /> frame per message', () => {
  it('gives each message a frame of its own', async () => {
    const view = render(EmailIframe, { props: { html: '<p>first</p>', messageId: 'a' } });
    const first = frame();
    await view.rerender({ html: '<p>second</p>', messageId: 'b' });
    // A fresh element can only run the document it was created with, so the
    // reader can never be left showing the previous message's document.
    expect(frame()).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(frame().getAttribute('srcdoc')).toContain('second');
  });

  it('updates the same frame in place when the body of one message changes', async () => {
    const view = render(EmailIframe, { props: { html: '<p>blocked images</p>', messageId: 'c' } });
    const first = frame();
    await view.rerender({ html: '<p>images loaded</p>', messageId: 'c' });
    expect(frame()).toBe(first);
    expect(first.getAttribute('srcdoc')).toContain('images loaded');
  });

  it('shows the frame as soon as there is a body, and a placeholder before', async () => {
    const view = render(EmailIframe, { props: { html: '', messageId: 'm' } });
    expect(document.querySelector('iframe.fe-email-iframe')).toBeNull();
    expect(document.querySelector('.fe-email-loading')).not.toBeNull();
    await view.rerender({ html: '<p>body</p>', messageId: 'm' });
    expect(frame().getAttribute('aria-hidden')).toBeNull();
    expect(getComputedStyle(frame()).visibility).not.toBe('hidden');
    expect(document.querySelector('.fe-email-loading')).toBeNull();
  });

  it('does not reload the frame when the document it would build is unchanged', async () => {
    const view = render(EmailIframe, { props: { html: '<p>same</p>', messageId: 'n' } });
    const first = frame();
    const token = currentToken();
    await view.rerender({ html: '<p>same</p>', messageId: 'n' });
    expect(frame()).toBe(first);
    expect(currentToken()).toBe(token);
  });

  it('ignores a height from the document it replaced', async () => {
    const view = render(EmailIframe, { props: { html: '<p>old</p>', messageId: 'd' } });
    const oldToken = currentToken();
    await view.rerender({ html: '<p>new</p>', messageId: 'd' });
    // The document the body update replaced answers late; its height is not
    // the new document's and must not be applied or cached.
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

describe('<EmailIframe /> sandbox', () => {
  // With allow-same-origin next to allow-scripts, script in the email
  // document would share the app's origin and reach its native bridge
  it('gives the email document an opaque origin on desktop', () => {
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'sb1' } });
    const iframe = document.querySelector('iframe.fe-email-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
  });

  it('still reports ready over postMessage', async () => {
    render(EmailIframe, { props: { html: '<p>hi</p>', messageId: 'sb2' } });
    const iframe = document.querySelector('iframe.fe-email-iframe') as HTMLIFrameElement;
    expect(iframe.getAttribute('data-frame-ready')).toBe('false');
    const token = iframe.getAttribute('srcdoc')?.match(/data-fe-token="([^"]*)"/)?.[1];
    postFromIframe({ type: 'ready', payload: { token } });
    await waitFor(() => expect(iframe.getAttribute('data-frame-ready')).toBe('true'));
  });
});
