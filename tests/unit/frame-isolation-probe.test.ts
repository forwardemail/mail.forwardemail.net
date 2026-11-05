/**
 * The probe asks the engine once per session whether the email frame can run
 * with an opaque origin. jsdom runs no script in frames, so the frame's
 * "ready" is posted here the way the runtime would, from the probe frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  knownOpaqueFrameSupport,
  probeOpaqueFrameSupport,
  resetFrameIsolationProbeForTests,
} from '../../src/utils/frame-isolation-probe';

afterEach(() => {
  resetFrameIsolationProbeForTests();
  vi.useRealTimers();
  // a probe that ran out of time keeps its frame while it waits for a late ready
  document.querySelectorAll('iframe[aria-hidden="true"]').forEach((frame) => frame.remove());
});

function probeFrame(): HTMLIFrameElement {
  const frame = document.querySelector('iframe[aria-hidden="true"]') as HTMLIFrameElement;
  expect(frame).not.toBeNull();
  return frame;
}

function postReady(frame: HTMLIFrameElement, token: string) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { type: 'ready', payload: { token } },
      source: frame.contentWindow,
    }),
  );
}

describe('probeOpaqueFrameSupport', () => {
  it('says yes when the opaque frame runtime reports ready, and remembers it', async () => {
    const result = probeOpaqueFrameSupport(1000);
    const frame = probeFrame();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const token = frame.srcdoc.match(/data-fe-token="([^"]+)"/)?.[1] || '';
    expect(token).toMatch(/^probe-/);
    postReady(frame, token);

    await expect(result).resolves.toBe(true);
    expect(document.querySelector('iframe[aria-hidden="true"]')).toBeNull();
    expect(knownOpaqueFrameSupport()).toBe(true);
    expect(sessionStorage.getItem('fe_opaque_frame_support')).toBe('1');
  });

  it('says no when the runtime never reports in, until the app is next loaded', async () => {
    vi.useFakeTimers();
    const result = probeOpaqueFrameSupport(500);
    vi.advanceTimersByTime(600);
    await expect(result).resolves.toBe(false);
    expect(knownOpaqueFrameSupport()).toBe(false);
    // A busy main thread at launch also runs out the time: not stored
    expect(sessionStorage.getItem('fe_opaque_frame_support')).toBeNull();
    vi.resetModules();
    const nextLoad = await import('../../src/utils/frame-isolation-probe');
    expect(nextLoad.knownOpaqueFrameSupport()).toBeNull();
  });

  it('takes a ready that comes after the time ran out, and stores it', async () => {
    vi.useFakeTimers();
    const result = probeOpaqueFrameSupport(500);
    const frame = probeFrame();
    const token = frame.srcdoc.match(/data-fe-token="([^"]+)"/)?.[1] || '';
    vi.advanceTimersByTime(600);
    await expect(result).resolves.toBe(false);

    postReady(frame, token);
    expect(knownOpaqueFrameSupport()).toBe(true);
    expect(sessionStorage.getItem('fe_opaque_frame_support')).toBe('1');
    await expect(probeOpaqueFrameSupport(500)).resolves.toBe(true);
    expect(document.querySelector('iframe[aria-hidden="true"]')).toBeNull();
  });

  it('stops waiting for a late ready after a while', async () => {
    vi.useFakeTimers();
    const result = probeOpaqueFrameSupport(500);
    const frame = probeFrame();
    const token = frame.srcdoc.match(/data-fe-token="([^"]+)"/)?.[1] || '';
    vi.advanceTimersByTime(600);
    await expect(result).resolves.toBe(false);
    vi.advanceTimersByTime(30000);
    expect(document.querySelector('iframe[aria-hidden="true"]')).toBeNull();
    postReady(frame, token);
    expect(knownOpaqueFrameSupport()).toBe(false);
  });

  it('ignores a ready from another window or with another token', async () => {
    vi.useFakeTimers();
    const result = probeOpaqueFrameSupport(500);
    const frame = probeFrame();
    postReady(frame, 'probe-wrong');
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'ready', payload: { token: 'anything' } },
        source: window,
      }),
    );
    vi.advanceTimersByTime(600);
    await expect(result).resolves.toBe(false);
  });

  it('asks only once per session', async () => {
    sessionStorage.setItem('fe_opaque_frame_support', '1');
    await expect(probeOpaqueFrameSupport(500)).resolves.toBe(true);
    expect(document.querySelector('iframe[aria-hidden="true"]')).toBeNull();
  });

  it('asks again over a "no" an earlier version stored for the session', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem('fe_opaque_frame_support', '0');
    const result = probeOpaqueFrameSupport(500);
    const frame = probeFrame();
    postReady(frame, frame.srcdoc.match(/data-fe-token="([^"]+)"/)?.[1] || '');
    await expect(result).resolves.toBe(true);
  });
});
