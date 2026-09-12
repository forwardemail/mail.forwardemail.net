/**
 * The head script in index.html paints a lock cover before any bundle runs
 * when App Lock will be due at boot. It exists because every route component
 * mounts before the real lock screen, so the shell showed for a moment on a
 * locked cold start. The script is exercised here exactly as the browser runs
 * it, against the real markup, with the storage facts it reads seeded.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const html = readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');

const headScript = (() => {
  // The CSP note above the script mentions "<script>" in prose, so strip
  // comments before looking for the real element.
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const scripts = [...withoutComments.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const found = scripts.find((s) => s.includes('webmail_lock_prefs'));
  if (!found) throw new Error('lock cover script not found in index.html');
  return found;
})();

const bodyMarkup = html.slice(html.indexOf('<body'), html.indexOf('</body>') + 7);

const runHeadScript = () => new Function(headScript)();

const overlay = () => document.getElementById('app-lock-overlay') as HTMLElement;
const cover = () => document.getElementById('app-lock-boot') as HTMLElement;

beforeEach(() => {
  document.documentElement.innerHTML = bodyMarkup;
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.classList.remove('app-lock-boot');
  document.documentElement.style.backgroundColor = '';
});

afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

const seedLock = () => {
  localStorage.setItem('webmail_lock_prefs', JSON.stringify({ enabled: true, pinLength: 6 }));
  localStorage.setItem('webmail_crypto_vault', JSON.stringify({ encryptedDek: 'x', nonce: 'y' }));
};

describe('index.html lock cover', () => {
  it('ships hidden so an unlocked app never sees it', () => {
    expect(cover().style.display).toBe('none');
    expect(overlay().style.display).toBe('');
  });

  it('paints the cover on a locked cold start, before any bundle', () => {
    seedLock();
    runHeadScript();
    expect(overlay().style.display).toBe('block');
    expect(overlay().style.position).toBe('fixed');
    expect(overlay().style.zIndex).toBe('99999');
    // body#rl-app is visibility:hidden until boot; the cover must opt out.
    expect(overlay().style.visibility).toBe('visible');
    expect(cover().style.display).toBe('flex');
    expect(document.documentElement.classList.contains('app-lock-boot')).toBe(true);
  });

  it('follows the stored theme', () => {
    seedLock();
    localStorage.setItem('webmail_theme', 'dark');
    runHeadScript();
    expect(overlay().style.backgroundColor).toBe('rgb(10, 10, 10)');
  });

  it('stays hidden when the lock is off', () => {
    localStorage.setItem('webmail_lock_prefs', JSON.stringify({ enabled: false }));
    localStorage.setItem('webmail_crypto_vault', JSON.stringify({ encryptedDek: 'x' }));
    runHeadScript();
    expect(cover().style.display).toBe('none');
  });

  it('stays hidden when the lock is on but no vault exists', () => {
    localStorage.setItem('webmail_lock_prefs', JSON.stringify({ enabled: true }));
    runHeadScript();
    expect(cover().style.display).toBe('none');
  });

  it('stays hidden on a same-tab reload that was already unlocked', () => {
    // bootstrap restores the key from the session stash on this path and
    // never shows the lock screen, so a cover here would flash for nothing.
    seedLock();
    sessionStorage.setItem('webmail_lock_session_unlocked', '1');
    runHeadScript();
    expect(cover().style.display).toBe('none');
  });

  it('survives corrupt storage without throwing', () => {
    localStorage.setItem('webmail_lock_prefs', '{not json');
    expect(() => runHeadScript()).not.toThrow();
    expect(cover().style.display).toBe('none');
  });
});
