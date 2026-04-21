import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock platform.js ────────────────────────────────────────────────────────
// We need to control isTauri and isTauriDesktop for each test.
let mockIsTauri = false;
let mockIsTauriDesktop = false;

vi.mock('../../src/utils/platform.js', () => ({
  get isTauri() {
    return mockIsTauri;
  },
  get isTauriDesktop() {
    return mockIsTauriDesktop;
  },
}));

// ── Mock tauri-bridge.js ────────────────────────────────────────────────────
const mockIsDefaultMailtoHandler = vi.fn();
const mockSetDefaultMailtoHandler = vi.fn();

vi.mock('../../src/utils/tauri-bridge.js', () => ({
  isDefaultMailtoHandler: (...args) => mockIsDefaultMailtoHandler(...args),
  setDefaultMailtoHandler: (...args) => mockSetDefaultMailtoHandler(...args),
}));

// ── Import the module under test ────────────────────────────────────────────
import {
  hasPromptBeenShown,
  markPromptShown,
  isProtocolHandlerSupported,
  isMailtoHandlerSupported,
  registerAsMailtoHandler,
  getRegistrationStatus,
  getRegistrationStatusSync,
  unregisterAsMailtoHandler,
  parseMailtoFromHash,
  resolveMailtoFromHash,
  shouldShowMailtoPrompt,
} from '../../src/utils/mailto-handler.js';

// ── Test setup ──────────────────────────────────────────────────────────────

beforeEach(() => {
  mockIsTauri = false;
  mockIsTauriDesktop = false;
  mockIsDefaultMailtoHandler.mockReset();
  mockSetDefaultMailtoHandler.mockReset();
  localStorage.clear();

  // Reset navigator mocks
  if (navigator.registerProtocolHandler) {
    delete navigator.registerProtocolHandler;
  }
  if (navigator.isProtocolHandlerRegistered) {
    delete navigator.isProtocolHandlerRegistered;
  }
  if (navigator.unregisterProtocolHandler) {
    delete navigator.unregisterProtocolHandler;
  }
});

// ── localStorage helpers ────────────────────────────────────────────────────

describe('hasPromptBeenShown', () => {
  it('returns false when nothing is stored', () => {
    expect(hasPromptBeenShown('user@example.com')).toBe(false);
  });

  it('returns true after markPromptShown', () => {
    markPromptShown('user@example.com');
    expect(hasPromptBeenShown('user@example.com')).toBe(true);
  });

  it('scopes by account', () => {
    markPromptShown('alice@example.com');
    expect(hasPromptBeenShown('alice@example.com')).toBe(true);
    expect(hasPromptBeenShown('bob@example.com')).toBe(false);
  });

  it('handles non-string account gracefully', () => {
    markPromptShown(null);
    expect(hasPromptBeenShown(null)).toBe(true);
  });

  it('survives localStorage errors', () => {
    const original = localStorage.getItem;
    localStorage.getItem = () => {
      throw new Error('quota exceeded');
    };
    expect(hasPromptBeenShown('user@example.com')).toBe(false);
    localStorage.getItem = original;
  });
});

describe('markPromptShown', () => {
  it('survives localStorage errors', () => {
    const original = localStorage.setItem;
    localStorage.setItem = () => {
      throw new Error('quota exceeded');
    };
    // Should not throw
    expect(() => markPromptShown('user@example.com')).not.toThrow();
    localStorage.setItem = original;
  });
});

// ── Protocol handler support detection ──────────────────────────────────────

describe('isProtocolHandlerSupported', () => {
  it('returns false when isTauri is true', () => {
    mockIsTauri = true;
    expect(isProtocolHandlerSupported()).toBe(false);
  });

  it('returns true when navigator.registerProtocolHandler exists', () => {
    navigator.registerProtocolHandler = vi.fn();
    expect(isProtocolHandlerSupported()).toBe(true);
  });

  it('returns false when navigator.registerProtocolHandler is missing', () => {
    expect(isProtocolHandlerSupported()).toBe(false);
  });
});

describe('isMailtoHandlerSupported', () => {
  it('returns true for Tauri desktop', () => {
    mockIsTauriDesktop = true;
    expect(isMailtoHandlerSupported()).toBe(true);
  });

  it('returns true for web with registerProtocolHandler', () => {
    navigator.registerProtocolHandler = vi.fn();
    expect(isMailtoHandlerSupported()).toBe(true);
  });

  it('returns false for mobile web without registerProtocolHandler', () => {
    expect(isMailtoHandlerSupported()).toBe(false);
  });
});

// ── Registration (Web path) ─────────────────────────────────────────────────

describe('registerAsMailtoHandler – web', () => {
  it('calls navigator.registerProtocolHandler with correct URL', async () => {
    const mockRegister = vi.fn();
    navigator.registerProtocolHandler = mockRegister;

    const result = await registerAsMailtoHandler();

    expect(result.success).toBe(true);
    expect(result.method).toBe('registered');
    expect(mockRegister).toHaveBeenCalledWith(
      'mailto',
      expect.stringContaining('/#compose?mailto=%s'),
    );
  });

  it('persists registration status to localStorage', async () => {
    navigator.registerProtocolHandler = vi.fn();

    await registerAsMailtoHandler();

    expect(localStorage.getItem('fe:mailto-registered')).toBe('registered');
  });

  it('returns failure when registerProtocolHandler is missing', async () => {
    const result = await registerAsMailtoHandler();
    expect(result.success).toBe(false);
  });

  it('returns failure when registerProtocolHandler throws', async () => {
    navigator.registerProtocolHandler = () => {
      throw new Error('SecurityError');
    };

    const result = await registerAsMailtoHandler();
    expect(result.success).toBe(false);
    expect(result.message).toContain('SecurityError');
  });
});

// ── Registration (Tauri path) ───────────────────────────────────────────────

describe('registerAsMailtoHandler – Tauri', () => {
  beforeEach(() => {
    mockIsTauri = true;
    mockIsTauriDesktop = true;
  });

  it('calls setDefaultMailtoHandler and returns registered', async () => {
    mockSetDefaultMailtoHandler.mockResolvedValue({
      method: 'registered',
      message: 'Forward Email is now your default email app.',
    });

    const result = await registerAsMailtoHandler();

    expect(result.success).toBe(true);
    expect(result.method).toBe('registered');
    expect(result.message).toContain('Forward Email');
    expect(mockSetDefaultMailtoHandler).toHaveBeenCalled();
  });

  it('persists status to localStorage on success', async () => {
    mockSetDefaultMailtoHandler.mockResolvedValue({
      method: 'registered',
      message: 'OK',
    });

    await registerAsMailtoHandler();

    expect(localStorage.getItem('fe:mailto-registered')).toBe('registered');
  });

  it('handles macOS sandbox fallback (open_mail_settings)', async () => {
    mockSetDefaultMailtoHandler.mockResolvedValue({
      method: 'open_mail_settings',
      message: 'Apple Mail has been opened. Please go to Mail → Settings → General.',
    });

    const result = await registerAsMailtoHandler();

    expect(result.success).toBe(false);
    expect(result.method).toBe('open_mail_settings');
    expect(result.message).toContain('Apple Mail');
  });

  it('handles error response', async () => {
    mockSetDefaultMailtoHandler.mockResolvedValue({
      method: 'error',
      message: 'LSSetDefaultHandlerForURLScheme returned error: -50',
    });

    const result = await registerAsMailtoHandler();

    expect(result.success).toBe(false);
    expect(result.method).toBe('error');
  });

  it('handles IPC rejection gracefully', async () => {
    mockSetDefaultMailtoHandler.mockRejectedValue(new Error('IPC timeout'));

    const result = await registerAsMailtoHandler();

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC timeout');
  });

  it('handles null response from native handler', async () => {
    mockSetDefaultMailtoHandler.mockResolvedValue(null);

    const result = await registerAsMailtoHandler();

    expect(result.success).toBe(false);
    expect(result.message).toContain('No response');
  });
});

// ── Status check (Web path) ─────────────────────────────────────────────────

describe('getRegistrationStatus – web', () => {
  it('returns unknown when registerProtocolHandler is missing', async () => {
    const status = await getRegistrationStatus();
    expect(status).toBe('unknown');
  });

  it('returns default from Firefox isProtocolHandlerRegistered', async () => {
    navigator.registerProtocolHandler = vi.fn();
    navigator.isProtocolHandlerRegistered = vi.fn().mockReturnValue('registered');

    const status = await getRegistrationStatus();
    expect(status).toBe('default');
  });

  it('returns declined from Firefox API', async () => {
    navigator.registerProtocolHandler = vi.fn();
    navigator.isProtocolHandlerRegistered = vi.fn().mockReturnValue('declined');

    const status = await getRegistrationStatus();
    expect(status).toBe('declined');
  });

  it('falls back to localStorage optimistic status', async () => {
    navigator.registerProtocolHandler = vi.fn();
    localStorage.setItem('fe:mailto-registered', 'registered');

    const status = await getRegistrationStatus();
    expect(status).toBe('default');
  });

  it('returns unknown when no data available', async () => {
    navigator.registerProtocolHandler = vi.fn();

    const status = await getRegistrationStatus();
    expect(status).toBe('unknown');
  });
});

// ── Status check (Tauri path) ───────────────────────────────────────────────

describe('getRegistrationStatus – Tauri', () => {
  beforeEach(() => {
    mockIsTauri = true;
    mockIsTauriDesktop = true;
  });

  it('returns default when native handler reports default', async () => {
    mockIsDefaultMailtoHandler.mockResolvedValue({
      status: 'default',
      current_handler: 'net.forwardemail.mail',
    });

    const status = await getRegistrationStatus();
    expect(status).toBe('default');
  });

  it('returns not_default when another handler is registered', async () => {
    mockIsDefaultMailtoHandler.mockResolvedValue({
      status: 'not_default',
      current_handler: 'com.apple.mail',
    });

    const status = await getRegistrationStatus();
    expect(status).toBe('not_default');
  });

  it('returns unknown when native check returns unknown', async () => {
    mockIsDefaultMailtoHandler.mockResolvedValue({
      status: 'unknown',
      current_handler: '',
    });

    const status = await getRegistrationStatus();
    expect(status).toBe('unknown');
  });

  it('falls back to a registered state when IPC fails but Tauri was previously registered', async () => {
    mockIsDefaultMailtoHandler.mockRejectedValue(new Error('IPC error'));
    localStorage.setItem('fe:mailto-registered', 'registered');

    const status = await getRegistrationStatus();
    expect(status).toBe('registered');
  });

  it('returns unknown when IPC fails and no localStorage', async () => {
    mockIsDefaultMailtoHandler.mockRejectedValue(new Error('IPC error'));

    const status = await getRegistrationStatus();
    expect(status).toBe('unknown');
  });

  it('handles malformed IPC response', async () => {
    mockIsDefaultMailtoHandler.mockResolvedValue('not an object');

    const status = await getRegistrationStatus();
    // Should fall through to localStorage / unknown
    expect(['registered', 'unknown']).toContain(status);
  });
});

// ── Synchronous status check ────────────────────────────────────────────────

describe('getRegistrationStatusSync', () => {
  it('returns default on web when localStorage has registered', () => {
    localStorage.setItem('fe:mailto-registered', 'registered');
    expect(getRegistrationStatusSync()).toBe('default');
  });

  it('returns registered on Tauri desktop when localStorage has registered', () => {
    mockIsTauriDesktop = true;
    localStorage.setItem('fe:mailto-registered', 'registered');
    expect(getRegistrationStatusSync()).toBe('registered');
  });

  it('returns unknown when localStorage is empty', () => {
    expect(getRegistrationStatusSync()).toBe('unknown');
  });
});

// ── Unregister ──────────────────────────────────────────────────────────────

describe('unregisterAsMailtoHandler', () => {
  it('calls navigator.unregisterProtocolHandler when available', () => {
    navigator.registerProtocolHandler = vi.fn();
    navigator.unregisterProtocolHandler = vi.fn();

    const result = unregisterAsMailtoHandler();
    expect(result).toBe(true);
    expect(navigator.unregisterProtocolHandler).toHaveBeenCalled();
  });

  it('returns false when API is not available', () => {
    expect(unregisterAsMailtoHandler()).toBe(false);
  });
});

// ── Hash parsing ────────────────────────────────────────────────────────────

describe('parseMailtoFromHash', () => {
  it('returns null for empty input', () => {
    expect(parseMailtoFromHash('')).toBeNull();
    expect(parseMailtoFromHash(null)).toBeNull();
    expect(parseMailtoFromHash(undefined)).toBeNull();
  });

  it('parses a valid compose hash', () => {
    const result = parseMailtoFromHash('#compose?mailto=mailto:alice@example.com');
    expect(result).toEqual({ mailtoUrl: 'mailto:alice@example.com' });
  });

  it('handles URL-encoded mailto URL', () => {
    const encoded = encodeURIComponent('mailto:alice@example.com?subject=Hello World');
    const result = parseMailtoFromHash(`#compose?mailto=${encoded}`);
    expect(result.mailtoUrl).toBe('mailto:alice@example.com?subject=Hello World');
  });

  it('rejects non-compose hashes', () => {
    expect(parseMailtoFromHash('#inbox')).toBeNull();
    expect(parseMailtoFromHash('#settings')).toBeNull();
  });

  it('rejects non-mailto URLs', () => {
    expect(parseMailtoFromHash('#compose?mailto=https://evil.com')).toBeNull();
  });

  it('works without leading #', () => {
    const result = parseMailtoFromHash('compose?mailto=mailto:test@x.com');
    expect(result).toEqual({ mailtoUrl: 'mailto:test@x.com' });
  });

  it('returns non-null for number input', () => {
    expect(parseMailtoFromHash(42)).toBeNull();
  });
});

// ── resolveMailtoFromHash ───────────────────────────────────────────────────

describe('resolveMailtoFromHash', () => {
  it('returns null for invalid hash', async () => {
    const result = await resolveMailtoFromHash('#inbox');
    expect(result).toBeNull();
  });

  it('returns null for empty input', async () => {
    const result = await resolveMailtoFromHash('');
    expect(result).toBeNull();
  });
});

// ── shouldShowMailtoPrompt ──────────────────────────────────────────────────

describe('shouldShowMailtoPrompt', () => {
  it('returns false when platform does not support mailto handling', () => {
    // No registerProtocolHandler, not Tauri
    expect(shouldShowMailtoPrompt('user@example.com')).toBe(false);
  });

  it('returns true on web when registerProtocolHandler is available', () => {
    navigator.registerProtocolHandler = vi.fn();
    expect(shouldShowMailtoPrompt('user@example.com')).toBe(true);
  });

  it('returns true on Tauri desktop', () => {
    mockIsTauriDesktop = true;
    expect(shouldShowMailtoPrompt('user@example.com')).toBe(true);
  });

  it('returns false after prompt has been shown', () => {
    navigator.registerProtocolHandler = vi.fn();
    markPromptShown('user@example.com');
    expect(shouldShowMailtoPrompt('user@example.com')).toBe(false);
  });

  it('returns false when already registered (sync check)', () => {
    navigator.registerProtocolHandler = vi.fn();
    localStorage.setItem('fe:mailto-registered', 'registered');
    expect(shouldShowMailtoPrompt('user@example.com')).toBe(false);
  });

  it('returns true for different account even if one was shown', () => {
    navigator.registerProtocolHandler = vi.fn();
    markPromptShown('alice@example.com');
    expect(shouldShowMailtoPrompt('bob@example.com')).toBe(true);
  });
});
