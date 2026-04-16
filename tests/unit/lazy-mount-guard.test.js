import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Validates that Calendar, Contacts, and Compose are **statically** imported
 * in main.ts so they share the same Svelte runtime chunk as Mailbox.
 *
 * Dynamic imports combined with Vite's manualChunks caused each chunk to
 * receive its own copy of Svelte's internal init_operations() state,
 * leaving next_sibling_getter uninitialised and crashing bits-ui
 * floating-layer components (Tooltip.Trigger, DropdownMenu.Trigger).
 *
 *   TypeError: undefined is not an object (evaluating 'next_sibling_getter.call')
 *
 * The fix converts Calendar, Contacts, and Compose to static imports
 * (same pattern as Mailbox) and adds resolve.dedupe in vite.config.js.
 *
 * Ref: https://github.com/sveltejs/svelte/issues/15960
 * Ref: https://github.com/huntabyte/bits-ui/issues/1465
 * Ref: https://github.com/huntabyte/shadcn-svelte/issues/1961
 */

const mainSrc = readFileSync(join(__dirname, '../../src/main.ts'), 'utf-8');

const viteConfigSrc = readFileSync(join(__dirname, '../../vite.config.js'), 'utf-8');

describe('Static imports for Calendar, Contacts, and Compose', () => {
  it('statically imports Calendar.svelte at the top of main.ts', () => {
    expect(mainSrc).toMatch(/^import\s+Calendar\s+from\s+['"]\.\/svelte\/Calendar\.svelte['"]/m);
  });

  it('statically imports Contacts.svelte at the top of main.ts', () => {
    expect(mainSrc).toMatch(/^import\s+Contacts\s+from\s+['"]\.\/svelte\/Contacts\.svelte['"]/m);
  });

  it('statically imports Compose.svelte at the top of main.ts', () => {
    expect(mainSrc).toMatch(/^import\s+Compose\s+from\s+['"]\.\/svelte\/Compose\.svelte['"]/m);
  });

  it('does NOT use dynamic import() for Calendar', () => {
    expect(mainSrc).not.toMatch(/import\(\s*['"]\.\/svelte\/Calendar\.svelte['"]\s*\)/);
  });

  it('does NOT use dynamic import() for Contacts', () => {
    expect(mainSrc).not.toMatch(/import\(\s*['"]\.\/svelte\/Contacts\.svelte['"]\s*\)/);
  });

  it('does NOT use dynamic import() for Compose', () => {
    expect(mainSrc).not.toMatch(/import\(\s*['"]\.\/svelte\/Compose\.svelte['"]\s*\)/);
  });

  it('does NOT define loadCalendarComponent, loadContactsComponent, or loadComposeComponent', () => {
    expect(mainSrc).not.toContain('loadCalendarComponent');
    expect(mainSrc).not.toContain('loadContactsComponent');
    expect(mainSrc).not.toContain('loadComposeComponent');
  });
});

describe('Synchronous mount pattern (no .then() chains)', () => {
  it('mountCalendar uses synchronous mount(Calendar, …)', () => {
    // The function should call mount(Calendar, ...) directly, not inside .then()
    const fnMatch = mainSrc.match(/function\s+mountCalendar\s*\(\)\s*\{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[1];
    expect(fnBody).toContain('mount(Calendar,');
    expect(fnBody).not.toContain('.then(');
  });

  it('mountContacts uses synchronous mount(Contacts, …)', () => {
    const fnMatch = mainSrc.match(/function\s+mountContacts\s*\(\)\s*\{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[1];
    expect(fnBody).toContain('mount(Contacts,');
    expect(fnBody).not.toContain('.then(');
  });

  it('Compose mount uses synchronous mount(Compose, …)', () => {
    // Compose is mounted inline (not in a named function), look for the pattern
    expect(mainSrc).toMatch(/mount\(Compose,\s*\{/);
    // Should NOT have a .then() chain for Compose
    expect(mainSrc).not.toMatch(/loadComposeComponent\(\)\s*\.then/);
  });
});

describe('mountCalendar and mountContacts error handling', () => {
  it('mountCalendar wraps mount() in try/catch', () => {
    const fnMatch = mainSrc.match(/function\s+mountCalendar\s*\(\)\s*\{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[1];
    expect(fnBody).toContain('try {');
    expect(fnBody).toContain('catch (err)');
    expect(fnBody).toContain("'Failed to mount calendar component'");
  });

  it('mountContacts wraps mount() in try/catch', () => {
    const fnMatch = mainSrc.match(/function\s+mountContacts\s*\(\)\s*\{([\s\S]*?)\n\}/);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch[1];
    expect(fnBody).toContain('try {');
    expect(fnBody).toContain('catch (err)');
    expect(fnBody).toContain("'Failed to mount contacts component'");
  });

  it('mountCalendar does NOT use retry attempts (no longer needed with static imports)', () => {
    expect(mainSrc).not.toContain('_calendarMountAttempts');
  });

  it('mountContacts does NOT use retry attempts (no longer needed with static imports)', () => {
    expect(mainSrc).not.toContain('_contactsMountAttempts');
  });
});

describe('Vite config: Svelte runtime deduplication', () => {
  it('includes resolve.dedupe with svelte entries', () => {
    expect(viteConfigSrc).toMatch(/dedupe\s*:\s*\[/);
    expect(viteConfigSrc).toContain("'svelte'");
    expect(viteConfigSrc).toContain("'svelte/internal'");
    expect(viteConfigSrc).toContain("'svelte/internal/client'");
  });

  it('keeps svelte in manualChunks vendor bundle', () => {
    // svelte should still be in the vendor chunk for optimal caching
    expect(viteConfigSrc).toMatch(/manualChunks\s*:\s*\{/);
    expect(viteConfigSrc).toMatch(/vendor\s*:\s*\[[\s\S]*?['"]svelte['"]/);
  });
});

describe('Static imports match existing pattern (Mailbox, Login, etc.)', () => {
  it('Calendar import is adjacent to other component imports', () => {
    // All component imports should be in the same block at the top
    const importBlock = mainSrc.match(/import Mailbox from.*\n(?:import \w+ from.*\n)*/);
    expect(importBlock).not.toBeNull();
    expect(importBlock[0]).toContain("import Calendar from './svelte/Calendar.svelte'");
  });

  it('Contacts import is adjacent to other component imports', () => {
    const importBlock = mainSrc.match(/import Mailbox from.*\n(?:import \w+ from.*\n)*/);
    expect(importBlock).not.toBeNull();
    expect(importBlock[0]).toContain("import Contacts from './svelte/Contacts.svelte'");
  });

  it('Compose import is adjacent to other component imports', () => {
    const importBlock = mainSrc.match(/import Mailbox from.*\n(?:import \w+ from.*\n)*/);
    expect(importBlock).not.toBeNull();
    expect(importBlock[0]).toContain("import Compose from './svelte/Compose.svelte'");
  });
});
