/**
 * Sending half of QR device pairing.
 *
 * The behaviours worth pinning are the ones that keep a live credential from
 * lingering on screen: the code stays hidden until the user asks for it, and
 * expiry drops the payload rather than just stopping the animation. The frames
 * carry the seal key, so a payload left in component state after the countdown
 * is a credential left on the page.
 */
import { describe, expect, it, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { webcrypto } from 'node:crypto';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

const localMap = new Map<string, string>();
let lockEnabled = false;

vi.mock('../../src/utils/storage.js', () => ({
  Local: {
    get: (key: string) => (localMap.has(key) ? localMap.get(key)! : null),
    set: (key: string, value: string) => localMap.set(key, value),
    remove: (key: string) => localMap.delete(key),
  },
  Accounts: { getAll: () => [{ email: 'user@example.com', aliasAuth: 'user@example.com:pw' }] },
}));

vi.mock('../../src/utils/crypto-store.js', () => ({
  isLockEnabled: () => lockEnabled,
  isVaultConfigured: () => lockEnabled,
  unlockWithPin: vi.fn(async (pin: string) => pin === '135790'),
}));

vi.mock('../../src/utils/db', () => ({
  db: { meta: { where: () => ({ startsWith: () => ({ toArray: async () => [] }) }) } },
}));

// jsdom canvases have no 2d context; the encoder only needs to not explode.
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(async () => undefined) } }));

// Argon2id at 256 MiB takes over a second per derivation by design. These are
// UI tests - the real KDF and the wrap/unwrap round trip are covered in
// device-sync-pairing-code.test.ts - so stub it to keep them fast.
vi.mock('hash-wasm', () => ({
  // The shared KDF asks for outputType 'binary', so the mock must hand back
  // bytes; a hex string here would silently XOR to garbage.
  argon2id: vi.fn(async () => new Uint8Array(32).fill(0xab)),
}));

const DeviceSyncCard = (await import('../../src/svelte/components/DeviceSyncCard.svelte')).default;

const ACCOUNT = 'user@example.com';

afterEach(() => {
  cleanup();
  localMap.clear();
  lockEnabled = false;
  vi.useRealTimers();
});

const showCode = async () => {
  await fireEvent.click(screen.getByRole('button', { name: /show pairing code/i }));
  await waitFor(() => expect(screen.getByText(/expires in/i)).toBeInTheDocument());
};

describe('<DeviceSyncCard />', () => {
  it('offers the PGP bucket only when there are keys to send', () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });
    expect(screen.getByText(/none saved/i)).toBeInTheDocument();

    cleanup();
    localMap.set(`pgp_keys_${ACCOUNT}`, JSON.stringify([{ name: 'work', value: 'x' }]));
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    expect(screen.queryByText(/none saved/i)).toBeNull();
    expect(screen.getByText('(1)')).toBeInTheDocument();
  });

  it('keeps the code hidden behind press-and-hold, and re-hides on release', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });
    await showCode();

    const reveal = screen.getByRole('button', { name: /press and hold to reveal/i });
    expect(reveal).toBeInTheDocument();

    await fireEvent.pointerDown(reveal);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /press and hold to reveal/i })).toBeNull(),
    );

    // The release lands on the WINDOW: revealing unmounts the overlay button,
    // so its own pointerup can never fire. Before that was handled, one tap
    // revealed the credential-bearing code permanently.
    await fireEvent.pointerUp(window);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /press and hold to reveal/i })).toBeInTheDocument(),
    );
  });

  it('keeps a user-chosen pairing code when buckets change the recommendation', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    const requireCode = screen.getByRole('checkbox', { name: /require a pairing code/i });
    expect(requireCode).toBeChecked();

    // The user re-affirms protection by toggling it off and back on, then
    // drops the credential bucket. The recommendation flips to off, but an
    // explicit choice must survive it.
    await fireEvent.click(requireCode);
    await fireEvent.click(requireCode);
    await fireEvent.click(screen.getByRole('checkbox', { name: /include sign-in/i }));

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /require a pairing code/i })).toBeChecked(),
    );
  });

  it('regenerating does not stack timers or accelerate expiry', async () => {
    vi.useFakeTimers();
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    await fireEvent.click(screen.getByRole('button', { name: /show pairing code/i }));
    await vi.waitFor(() => expect(screen.getByText(/expires in/i)).toBeInTheDocument());

    await fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
    // Wait for the regenerated session to fully start before advancing fake
    // time. Node's WebCrypto resolves on a real macrotask, so only waitFor's
    // event-loop pumping lets sealBundle finish; asserting on the 3:00 label
    // alone matches the OLD session's frozen display and proves nothing.
    await vi.waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /regenerate/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );

    // With the old stacked interval the countdown ran at double speed and
    // expired around the 90s mark. At 179s a single healthy timer must still
    // be counting; a couple more seconds expires it on schedule. Not asserted
    // to the exact second because vi.waitFor itself advances fake timers.
    await vi.advanceTimersByTimeAsync(179_000);
    expect(screen.queryByText(/that code expired/i)).toBeNull();
    expect(screen.getByText(/expires in/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(screen.getByText(/that code expired/i)).toBeInTheDocument();
  });

  it('reserves the rotate-password warning for unprotected credential codes', async () => {
    vi.useFakeTimers();
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    // Default flow: credentials travel but a pairing code protects them.
    await fireEvent.click(screen.getByRole('button', { name: /show pairing code/i }));
    await vi.waitFor(() => expect(screen.getByText(/expires in/i)).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(181_000);

    expect(screen.getByText(/that code expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/change the password/i)).toBeNull();

    // Now explicitly unprotected: the warning is earned.
    await fireEvent.click(screen.getByRole('checkbox', { name: /require a pairing code/i }));
    await fireEvent.click(screen.getByRole('button', { name: /show pairing code/i }));
    await vi.waitFor(() => expect(screen.getByText(/expires in/i)).toBeInTheDocument());
    await vi.advanceTimersByTimeAsync(181_000);

    expect(screen.getByText(/change the password/i)).toBeInTheDocument();
  });

  it('offers a pinned-visible escape hatch for anyone who cannot hold a pointer', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });
    await showCode();

    await fireEvent.click(screen.getByRole('checkbox', { name: /keep the code visible/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /press and hold to reveal/i })).toBeNull(),
    );
  });

  it('drops the payload when the countdown runs out', async () => {
    vi.useFakeTimers();
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    await fireEvent.click(screen.getByRole('button', { name: /show pairing code/i }));
    await vi.waitFor(() => expect(screen.getByText(/expires in/i)).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(181_000);

    expect(screen.getByText(/that code expired/i)).toBeInTheDocument();
    expect(screen.queryByText(/expires in/i)).toBeNull();
    expect(screen.getByRole('button', { name: /show pairing code/i })).toBeInTheDocument();
  });

  it('demands the app lock PIN before building a code', async () => {
    lockEnabled = true;
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    await fireEvent.click(screen.getByRole('button', { name: /show pairing code/i }));
    expect(screen.getByText(/enter your app lock pin/i)).toBeInTheDocument();

    const input = screen.getByPlaceholderText('PIN');
    await fireEvent.input(input, { target: { value: '000000' } });
    await fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/did not match/i)).toBeInTheDocument());
    expect(screen.queryByText(/expires in/i)).toBeNull();

    await fireEvent.input(input, { target: { value: '135790' } });
    await fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    await waitFor(() => expect(screen.getByText(/expires in/i)).toBeInTheDocument());
  });

  it('requires a pairing code by default when credentials are included', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    expect(screen.getByRole('checkbox', { name: /require a pairing code/i })).toBeChecked();
  });

  it('drops the pairing-code default for a settings-only bundle', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    // Nothing worth stealing left in the bundle, so the extra typing buys
    // nothing and should not be imposed.
    await fireEvent.click(screen.getByRole('checkbox', { name: /include sign-in/i }));
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /require a pairing code/i })).not.toBeChecked(),
    );
  });

  it('shows a pairing code alongside the QR when one is required', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });
    await showCode();

    expect(screen.getByText(/type this on your phone/i)).toBeInTheDocument();
    expect(screen.getByText(/^[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/)).toBeInTheDocument();
  });

  it('refuses to build a code with every bucket unchecked, counting an empty PGP bucket as unselected', async () => {
    render(DeviceSyncCard, { props: { account: ACCOUNT } });

    await fireEvent.click(screen.getByRole('checkbox', { name: /include sign-in/i }));
    await fireEvent.click(screen.getByRole('checkbox', { name: /include app settings/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /show pairing code/i })).toBeDisabled(),
    );
  });
});
