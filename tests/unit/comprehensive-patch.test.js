/**
 * Comprehensive tests for the full patch:
 * 1. deferredWritable — global WebKit crash prevention
 * 2. Smart delete direction (nextCandidate)
 * 3. UX features: sidebar resize, collapsible bottom, card view, context-sensitive checkboxes
 * 4. forwardMessage from address fix
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// 1. deferredWritable tests
// ============================================================
describe('deferredWritable', () => {
  let deferredWritable;
  let rafCallbacks;

  beforeEach(async () => {
    rafCallbacks = [];
    global.requestAnimationFrame = vi.fn((cb) => {
      const id = rafCallbacks.length + 1;
      rafCallbacks.push(cb);
      return id;
    });
    global.cancelAnimationFrame = vi.fn((id) => {
      if (id > 0 && id <= rafCallbacks.length) {
        rafCallbacks[id - 1] = null;
      }
    });

    const mod = await import('../../src/utils/deferred-store.ts');
    deferredWritable = mod.deferredWritable;
  });

  afterEach(() => {
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
    vi.restoreAllMocks();
  });

  it('should create a store with initial value', () => {
    const store = deferredWritable([1, 2, 3]);
    expect(get(store)).toEqual([1, 2, 3]);
  });

  it('should synchronously set when adding items (array grows)', () => {
    const store = deferredWritable([1, 2]);
    store.set([1, 2, 3]);
    expect(get(store)).toEqual([1, 2, 3]);
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should synchronously set when array length stays the same', () => {
    const store = deferredWritable([1, 2, 3]);
    store.set([4, 5, 6]);
    expect(get(store)).toEqual([4, 5, 6]);
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should defer set when removing items (array shrinks)', () => {
    const store = deferredWritable([1, 2, 3]);
    store.set([1, 2]);
    // Should NOT be applied yet
    expect(get(store)).toEqual([1, 2, 3]);
    expect(global.requestAnimationFrame).toHaveBeenCalledTimes(1);
    // Flush the rAF
    rafCallbacks.forEach((cb) => cb && cb());
    expect(get(store)).toEqual([1, 2]);
  });

  it('should defer set when clearing array to empty', () => {
    const store = deferredWritable([1, 2, 3]);
    store.set([]);
    expect(get(store)).toEqual([1, 2, 3]);
    rafCallbacks.forEach((cb) => cb && cb());
    expect(get(store)).toEqual([]);
  });

  it('should synchronously set non-array values', () => {
    const store = deferredWritable('hello');
    store.set('world');
    expect(get(store)).toBe('world');
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should synchronously set when current is non-array', () => {
    const store = deferredWritable(null);
    store.set([1, 2, 3]);
    expect(get(store)).toEqual([1, 2, 3]);
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should synchronously set when new value is non-array', () => {
    const store = deferredWritable([1, 2, 3]);
    store.set(null);
    expect(get(store)).toBeNull();
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should cancel pending rAF when a new set is called', () => {
    const store = deferredWritable([1, 2, 3]);
    store.set([1, 2]); // deferred
    store.set([1, 2, 3, 4]); // sync (grows), should cancel pending
    expect(global.cancelAnimationFrame).toHaveBeenCalled();
    expect(get(store)).toEqual([1, 2, 3, 4]);
  });

  it('should defer update() when it reduces array length', () => {
    const store = deferredWritable([1, 2, 3]);
    store.update((arr) => arr.filter((x) => x !== 2));
    expect(get(store)).toEqual([1, 2, 3]);
    rafCallbacks.forEach((cb) => cb && cb());
    expect(get(store)).toEqual([1, 3]);
  });

  it('should synchronously update() when it grows array', () => {
    const store = deferredWritable([1, 2]);
    store.update((arr) => [...arr, 3]);
    expect(get(store)).toEqual([1, 2, 3]);
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should provide setImmediate for bypassing deferral', () => {
    const store = deferredWritable([1, 2, 3]);
    store.setImmediate([1]);
    expect(get(store)).toEqual([1]);
    expect(global.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it('should support subscribe', () => {
    const store = deferredWritable([1, 2]);
    const values = [];
    const unsub = store.subscribe((v) => values.push([...v]));
    store.set([1, 2, 3]);
    expect(values).toEqual([
      [1, 2],
      [1, 2, 3],
    ]);
    unsub();
  });

  it('should coalesce multiple deferred sets — only last value wins', () => {
    const store = deferredWritable([1, 2, 3, 4, 5]);
    store.set([1, 2, 3]); // deferred
    store.set([1, 2]); // deferred again, should cancel first
    expect(global.cancelAnimationFrame).toHaveBeenCalled();
    // Flush only the latest rAF
    rafCallbacks.forEach((cb) => cb && cb());
    expect(get(store)).toEqual([1, 2]);
  });
});

// ============================================================
// 2. messageStore uses deferredWritable
// ============================================================
describe('messageStore uses deferredWritable', () => {
  it('should import messages from messageStore as a deferredWritable', async () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/stores/messageStore.ts'),
      'utf8',
    );
    expect(src).toContain('import { deferredWritable }');
    expect(src).toContain('deferredWritable<');
    expect(src).not.toMatch(/\bwritable\s*<\s*Message\s*\[\s*\]\s*>\s*\(\s*\[\s*\]\s*\)/);
  });
});

// ============================================================
// 3. Smart delete direction (nextCandidate)
// ============================================================
describe('nextCandidate — smart delete direction', () => {
  let nextCandidate;

  beforeEach(async () => {
    const mod = await import('../../src/svelte/mailbox/utils/mailbox-helpers.js');
    nextCandidate = mod.nextCandidate;
  });

  it('should return null for empty list', () => {
    expect(nextCandidate({ list: [] })).toBeNull();
  });

  it('should return first item when nothing is selected', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    expect(nextCandidate({ list })).toEqual({ id: 'a' });
  });

  it('should go below by default when both neighbors exist and both are read', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'b' },
    });
    expect(result).toEqual({ id: 'c' });
  });

  it('should go above when below is read and above is unread', () => {
    const list = [{ id: 'a', is_unread: true }, { id: 'b' }, { id: 'c', is_unread: false }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'b' },
    });
    expect(result).toEqual({ id: 'a', is_unread: true });
  });

  it('should go above when below is read and above has hasUnread (conversation)', () => {
    const list = [{ id: 'a', hasUnread: true }, { id: 'b' }, { id: 'c' }];
    const result = nextCandidate({
      list,
      threadingEnabled: true,
      selectedConversation: { id: 'b' },
    });
    expect(result).toEqual({ id: 'a', hasUnread: true });
  });

  it('should go below when both neighbors are unread', () => {
    const list = [{ id: 'a', is_unread: true }, { id: 'b' }, { id: 'c', is_unread: true }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'b' },
    });
    expect(result).toEqual({ id: 'c', is_unread: true });
  });

  it('should go below when both neighbors are read', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'b' },
    });
    expect(result).toEqual({ id: 'c' });
  });

  it('should go above when at end of list', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'b' },
    });
    expect(result).toEqual({ id: 'a' });
  });

  it('should go below when at start of list', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'a' },
    });
    expect(result).toEqual({ id: 'b' });
  });

  it('should return null for single-item list', () => {
    const list = [{ id: 'a' }];
    const result = nextCandidate({
      list,
      threadingEnabled: false,
      selectedMessage: { id: 'a' },
    });
    expect(result).toBeNull();
  });
});

// ============================================================
// 4. UX features — source code verification
// ============================================================
describe('UX features — source code verification', () => {
  let mailboxSrc;

  beforeEach(() => {
    mailboxSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
      'utf8',
    );
  });

  describe('Resizable sidebar', () => {
    it('should have sidebarWidth state variable', () => {
      expect(mailboxSrc).toContain('let sidebarWidth');
    });

    it('should persist sidebar width to localStorage', () => {
      expect(mailboxSrc).toContain("localStorage.setItem('fe:sidebar-width'");
    });

    it('should read sidebar width from localStorage on init', () => {
      expect(mailboxSrc).toContain("localStorage.getItem('fe:sidebar-width')");
    });

    it('should have startSidebarResize handler', () => {
      expect(mailboxSrc).toContain('function startSidebarResize');
    });

    it('should have fe-sidebar-resizer element in template', () => {
      expect(mailboxSrc).toContain('class="fe-sidebar-resizer"');
    });

    it('should use CSS variable for sidebar width in classic layout', () => {
      expect(mailboxSrc).toContain('var(--fe-sidebar-width, 240px)');
    });

    it('should use CSS variable for sidebar width in productivity layout', () => {
      expect(mailboxSrc).toContain('var(--fe-sidebar-width, 280px)');
    });

    it('should set inline style on aside element conditionally', () => {
      expect(mailboxSrc).toMatch(/style=.*sidebarWidth.*px/);
      // Inline style should be conditional on sidebar being open
      expect(mailboxSrc).toContain('$sidebarOpen');
    });

    it('should support keyboard resize with arrow keys', () => {
      expect(mailboxSrc).toContain('ArrowLeft');
      expect(mailboxSrc).toContain('ArrowRight');
    });

    it('should clamp sidebar width between min and max', () => {
      expect(mailboxSrc).toContain('SIDEBAR_MIN');
      expect(mailboxSrc).toContain('SIDEBAR_MAX');
    });
  });

  describe('Collapsible sidebar bottom', () => {
    it('should have sidebarBottomCollapsed state', () => {
      expect(mailboxSrc).toContain('let sidebarBottomCollapsed');
    });

    it('should persist collapsed state to localStorage', () => {
      expect(mailboxSrc).toContain("localStorage.setItem('fe:sidebar-bottom-collapsed'");
    });

    it('should have toggle function', () => {
      expect(mailboxSrc).toContain('toggleSidebarBottom');
    });

    it('should conditionally render collapsed content', () => {
      expect(mailboxSrc).toContain('{#if !sidebarBottomCollapsed}');
    });

    it('should NOT have duplicate Contacts/Calendar/Settings in sidebar bottom', () => {
      // The sidebar bottom should not contain these since they're in the top nav
      const sidebarBottomSection = mailboxSrc.slice(mailboxSrc.indexOf('fe-sidebar-bottom-toggle'));
      // Should not have the old goto('contacts') or goto('calendar') buttons in the bottom
      const bottomToResizer = sidebarBottomSection.slice(
        0,
        sidebarBottomSection.indexOf('fe-sidebar-resizer'),
      );
      expect(bottomToResizer).not.toContain("goto('contacts')");
      expect(bottomToResizer).not.toContain("goto('calendar')");
    });
  });

  describe('Card view / classic view toggle', () => {
    it('should have cardView state variable', () => {
      expect(mailboxSrc).toContain('let cardView');
    });

    it('should persist card view preference in localStorage', () => {
      expect(mailboxSrc).toContain("localStorage.getItem('fe:card-view')");
      expect(mailboxSrc).toContain("localStorage.setItem('fe:card-view'");
    });

    it('should have toggleCardView function', () => {
      expect(mailboxSrc).toContain('toggleCardView');
    });

    it('should default to card view (true)', () => {
      // Default is card view unless explicitly set to false
      expect(mailboxSrc).toContain("!== 'false'");
    });

    it('should have {#if cardView} toggle in template', () => {
      expect(mailboxSrc).toContain('{#if cardView}');
    });

    it('should have classic single-row layout as alternative', () => {
      expect(mailboxSrc).toContain('Classic single-row layout');
    });

    it('should have card view Line 1 comment for sender + date', () => {
      expect(mailboxSrc).toContain('Line 1: Sender (bold, slightly bigger)');
    });

    it('should have card view Line 2 comment for subject', () => {
      expect(mailboxSrc).toContain('Line 2: Subject');
    });

    it('should have card view Line 3 comment for preview', () => {
      expect(mailboxSrc).toContain('Line 3: Preview (muted, smaller)');
    });

    it('should use text-[14px] for sender name in card view', () => {
      expect(mailboxSrc).toContain('text-[14px]');
    });

    it('should use text-[12px] for preview in card view', () => {
      expect(mailboxSrc).toContain('text-[12px] text-muted-foreground');
    });

    it('should show (No Subject) fallback in card view', () => {
      expect(mailboxSrc).toContain("'(No Subject)'");
    });

    it('should have classic Row 1 comment for From | Subject | Date', () => {
      expect(mailboxSrc).toContain('Row 1: From | Subject');
    });

    it('should have toggle button with LayoutList and Rows3 icons', () => {
      expect(mailboxSrc).toContain('Switch to classic view');
      expect(mailboxSrc).toContain('Switch to card view');
    });

    it('should hide toggle button on mobile (hidden sm:inline-flex)', () => {
      expect(mailboxSrc).toContain('hidden sm:inline-flex');
    });
  });

  describe('Always-visible checkboxes (regression fix)', () => {
    it('should NOT have fe-row-checkbox class (reverted context-sensitive feature)', () => {
      // Context-sensitive checkboxes were reverted because they broke bulk actions
      // Checkboxes should always be visible now
      expect(mailboxSrc).not.toContain('fe-row-checkbox');
    });

    it('should have checkbox buttons on each row', () => {
      // Checkboxes use the existing button pattern with Select/Deselect hints
      expect(mailboxSrc).toContain('Select');
    });

    it('should support selection mode toggle', () => {
      // Selection mode button should exist
      expect(mailboxSrc).toContain('selection');
    });
  });
});

// ============================================================
// 5. forwardMessage from address fix
// ============================================================
describe('forwardMessage from address fix', () => {
  it('should resolve from address in forwardMessage like replyTo', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/stores/mailboxActions.ts'),
      'utf8',
    );
    // Find the forwardMessage function
    const fwdIdx = src.indexOf('forwardMessage');
    expect(fwdIdx).toBeGreaterThan(-1);
    const fwdSection = src.slice(fwdIdx, fwdIdx + 2000);

    // Should contain getUserEmails and from address resolution
    expect(fwdSection).toContain('getUserEmails');
    expect(fwdSection).toContain('from:');
  });
});

// ============================================================
// 6. Folder-switch active message desync fix
// ============================================================
describe('folder-switch active message desync fix', () => {
  const mailboxSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
    'utf8',
  );

  describe('handleSelectFolder resets selection state', () => {
    it('should reset lastSelectedMessageId to null on folder switch', () => {
      // The handleSelectFolder function must clear lastSelectedMessageId
      // so the auto-selected first message in the new folder is not
      // mistaken for a stale re-click
      const fnStart = mailboxSrc.indexOf('const handleSelectFolder');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = mailboxSrc.slice(fnStart, fnStart + 800);
      expect(fnSection).toContain('lastSelectedMessageId = null');
    });

    it('should clear selectedConversation on folder switch', () => {
      // The handleSelectFolder function must clear the active conversation
      // so the highlight does not stay on a stale conversation from the
      // previous folder
      const fnStart = mailboxSrc.indexOf('const handleSelectFolder');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = mailboxSrc.slice(fnStart, fnStart + 800);
      expect(fnSection).toContain('updateSelectedConversation(null)');
    });

    it('should reset selection state before calling selectFolder action', () => {
      // The reset must happen BEFORE mailboxStore.actions.selectFolder
      // to avoid a race where the store auto-selects the first message
      // while lastSelectedMessageId still holds the old value
      const fnStart = mailboxSrc.indexOf('const handleSelectFolder');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = mailboxSrc.slice(fnStart, fnStart + 800);
      const resetIdx = fnSection.indexOf('lastSelectedMessageId = null');
      const selectFolderIdx = fnSection.indexOf('mailboxStore.actions.selectFolder');
      expect(resetIdx).toBeGreaterThan(-1);
      expect(selectFolderIdx).toBeGreaterThan(-1);
      expect(resetIdx).toBeLessThan(selectFolderIdx);
    });

    it('should clear conversation before calling selectFolder action', () => {
      const fnStart = mailboxSrc.indexOf('const handleSelectFolder');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = mailboxSrc.slice(fnStart, fnStart + 800);
      const convClearIdx = fnSection.indexOf('updateSelectedConversation(null)');
      const selectFolderIdx = fnSection.indexOf('mailboxStore.actions.selectFolder');
      expect(convClearIdx).toBeGreaterThan(-1);
      expect(selectFolderIdx).toBeGreaterThan(-1);
      expect(convClearIdx).toBeLessThan(selectFolderIdx);
    });
  });

  describe('selectConversation and selectMessage guard logic', () => {
    it('should have early-return guard using lastSelectedMessageId in selectConversation', () => {
      const fnStart = mailboxSrc.indexOf('const selectConversation');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = mailboxSrc.slice(fnStart, fnStart + 600);
      // Guard checks both lastSelectedMessageId and $selectedMessage?.id
      expect(fnSection).toContain('lastSelectedMessageId');
      expect(fnSection).toContain('$selectedMessage?.id');
    });

    it('should have early-return guard using lastSelectedMessageId in selectMessage', () => {
      const fnStart = mailboxSrc.indexOf('const selectMessage = (msg');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = mailboxSrc.slice(fnStart, fnStart + 600);
      expect(fnSection).toContain('lastSelectedMessageId');
      expect(fnSection).toContain('$selectedMessage?.id');
    });
  });

  describe('Bulk action buttons — mark read/unread wired in template', () => {
    it('should have a Mark selected as read button calling bulkMarkAsRead', () => {
      expect(mailboxSrc).toContain('aria-label="Mark selected as read"');
      expect(mailboxSrc).toContain('onclick={bulkMarkAsRead}');
    });

    it('should have a Mark selected as unread button calling bulkMarkAsUnread', () => {
      expect(mailboxSrc).toContain('aria-label="Mark selected as unread"');
      expect(mailboxSrc).toContain('onclick={bulkMarkAsUnread}');
    });

    it('should have MailOpen and MailIcon icons imported for bulk action buttons', () => {
      // MailOpen is used for the "mark as read" icon
      // MailIcon (or Mail) is used for the "mark as unread" icon
      expect(mailboxSrc).toContain('MailOpen');
      expect(mailboxSrc).toContain('MailIcon');
    });

    it('should have bulkMarkAsRead and bulkMarkAsUnread functions defined', () => {
      expect(mailboxSrc).toContain('bulkMarkAsRead');
      expect(mailboxSrc).toContain('bulkMarkAsUnread');
    });
  });

  describe('Contacts page privacy notice', () => {
    it('should have a privacy notice in Contacts.svelte', () => {
      const contactsSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
        'utf8',
      );
      expect(contactsSrc).toContain('Your contact data is stored privately and never shared');
    });

    it('should use matching style classes as Calendar privacy notice', () => {
      const contactsSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
        'utf8',
      );
      // Must have the same styling pattern as Calendar: bg-muted/50, text-xs, text-muted-foreground, shrink-0
      expect(contactsSrc).toContain('bg-muted/50');
      expect(contactsSrc).toContain('shrink-0');
    });

    it('should use flex-1 for the grid to accommodate privacy notice', () => {
      const contactsSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
        'utf8',
      );
      // Grid uses flex-1 min-h-0 instead of fixed calc height so footer is always visible
      expect(contactsSrc).toContain('grid flex-1 min-h-0');
    });
  });

  describe('store-level selectFolder clears selectedMessage', () => {
    it('should set selectedMessage to null in mailboxStore selectFolder', () => {
      const storeSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/stores/mailboxStore.ts'),
        'utf8',
      );
      const fnStart = storeSrc.indexOf('const selectFolder');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = storeSrc.slice(fnStart, fnStart + 700);
      expect(fnSection).toContain('selectedMessage.set(null)');
    });

    it('should clear selectedConversationIds in mailboxStore selectFolder', () => {
      const storeSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/stores/mailboxStore.ts'),
        'utf8',
      );
      const fnStart = storeSrc.indexOf('const selectFolder');
      expect(fnStart).toBeGreaterThan(-1);
      const fnSection = storeSrc.slice(fnStart, fnStart + 700);
      expect(fnSection).toContain('selectedConversationIds.set([])');
    });
  });

  describe('Split view (classic layout) fix', () => {
    it('should hide sidebar resizer in vertical desktop (classic) mode', () => {
      // The sidebar resizer is inside the aside (not a grid child) and hidden in classic mode
      expect(mailboxSrc).toContain('!isVerticalDesktop');
      // Resizer should be positioned absolutely inside the sidebar
      expect(mailboxSrc).toContain('position: absolute');
    });

    it('should have fe-vertical-resizable class for classic layout', () => {
      expect(mailboxSrc).toContain('class:fe-vertical-resizable={isVerticalDesktop}');
    });

    it('should define 4-column grid for classic layout', () => {
      // sidebar | messages | resizer | reader
      expect(mailboxSrc).toContain('var(--fe-sidebar-width, 240px)');
      expect(mailboxSrc).toContain('var(--fe-message-fr, 1fr)');
      expect(mailboxSrc).toContain('var(--fe-resizer-width, 10px)');
      expect(mailboxSrc).toContain('var(--fe-reader-fr, 1.2fr)');
    });

    it('should define 3-column grid for collapsed sidebar in classic layout', () => {
      // When sidebar collapsed: messages | resizer | reader
      expect(mailboxSrc).toContain('.fe-mailbox-shell.fe-vertical-resizable.fe-shell-collapsed');
    });
  });
});

// ============================================================
// 5. Calendar page fixes — source code verification
// ============================================================
describe('Calendar page fixes — source code verification', () => {
  let calendarSrc;

  beforeEach(() => {
    calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
  });

  describe('Calendar outer border removal', () => {
    it('should NOT have border classes on the sx-wrapper div', () => {
      // The sx-wrapper should not have "border border-border" classes
      const wrapperMatch = calendarSrc.match(/class="sx-wrapper[^"]*"/);
      expect(wrapperMatch).toBeTruthy();
      expect(wrapperMatch[0]).not.toContain('border border-border');
    });

    it('should have sx-wrapper class without border styling', () => {
      // Verify the sx-wrapper div uses just the class name
      expect(calendarSrc).toContain('class="sx-wrapper"');
    });
  });

  describe('Calendar dropdown overlay fix', () => {
    it('should set overflow: visible on sx-wrapper', () => {
      expect(calendarSrc).toContain('.sx-wrapper {');
      // Find the sx-wrapper CSS block and verify overflow: visible
      const wrapperIdx = calendarSrc.indexOf('.sx-wrapper {');
      const wrapperBlock = calendarSrc.slice(wrapperIdx, wrapperIdx + 300);
      expect(wrapperBlock).toContain('overflow: visible');
    });

    it('should set overflow: visible on sx-svelte-calendar-wrapper', () => {
      expect(calendarSrc).toContain('.sx-svelte-calendar-wrapper');
      const idx = calendarSrc.indexOf('.sx-svelte-calendar-wrapper');
      const block = calendarSrc.slice(idx, idx + 200);
      expect(block).toContain('overflow: visible !important');
    });

    it('should set overflow: visible on sx__calendar-wrapper', () => {
      const idx = calendarSrc.indexOf(':global(.sx__calendar-wrapper)');
      expect(idx).toBeGreaterThan(-1);
      const block = calendarSrc.slice(idx, idx + 200);
      expect(block).toContain('overflow: visible !important');
    });

    it('should set overflow: visible on sx__calendar', () => {
      const idx = calendarSrc.indexOf(':global(.sx__calendar)');
      expect(idx).toBeGreaterThan(-1);
      const block = calendarSrc.slice(idx, idx + 200);
      expect(block).toContain('overflow: visible !important');
    });

    it('should position sx__view-selection with relative positioning and z-index', () => {
      expect(calendarSrc).toContain(':global(.sx__view-selection)');
      const idx = calendarSrc.indexOf(':global(.sx__view-selection) {');
      expect(idx).toBeGreaterThan(-1);
      const block = calendarSrc.slice(idx, idx + 200);
      expect(block).toContain('z-index: 100');
      expect(block).toContain('position: relative');
    });

    it('should position sx__view-selection-items absolutely for overlay behavior', () => {
      expect(calendarSrc).toContain(':global(.sx__view-selection-items)');
      const idx = calendarSrc.indexOf(':global(.sx__view-selection-items)');
      expect(idx).toBeGreaterThan(-1);
      const block = calendarSrc.slice(idx, idx + 300);
      expect(block).toContain('z-index: 200');
      expect(block).toContain('position: absolute');
      expect(block).toContain('top: 100%');
    });

    it('should set overflow: visible on sx__calendar-header', () => {
      const matches = calendarSrc.match(/:global\(\.sx__calendar-header\)[^}]+}/g);
      expect(matches).toBeTruthy();
      const hasOverflowVisible = matches.some((m) => m.includes('overflow: visible'));
      expect(hasOverflowVisible).toBe(true);
    });

    it('should NOT have overflow-hidden on calendar-content wrapper', () => {
      // The calendar-content div should not have overflow-hidden
      const contentMatch = calendarSrc.match(/class="calendar-content[^"]*"/);
      expect(contentMatch).toBeTruthy();
      expect(contentMatch[0]).not.toContain('overflow-hidden');
    });
  });

  describe('Calendar footer with border-t separator', () => {
    it('should have border-t border-border on the privacy notice footer', () => {
      // The privacy notice should use border-t border-border for visual separation
      expect(calendarSrc).toContain('border-t border-border bg-muted/50');
    });

    it('should NOT have mt-4 spacing on the privacy notice (uses border instead)', () => {
      // The old mt-4 class should be replaced by border-t
      const privacyIdx = calendarSrc.indexOf('Your calendar data is stored privately');
      expect(privacyIdx).toBeGreaterThan(-1);
      // Get the parent div (look backwards for the class)
      const before = calendarSrc.slice(Math.max(0, privacyIdx - 200), privacyIdx);
      expect(before).not.toContain('mt-4');
    });
  });
});

// ============================================================
// 6. Footer consistency between Calendar and Contacts
// ============================================================
describe('Footer consistency between Calendar and Contacts', () => {
  it('should have matching footer class patterns on both pages', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    const contactsSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
      'utf8',
    );
    // Both should use the same footer class pattern
    const footerPattern =
      'border-t border-border bg-muted/50 px-4 py-2 text-xs text-muted-foreground shrink-0';
    expect(calendarSrc).toContain(footerPattern);
    expect(contactsSrc).toContain(footerPattern);
  });

  it('should have Contacts privacy notice outside the selectedContact conditional', () => {
    const contactsSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
      'utf8',
    );
    // Check that the privacy div is at the top level (after the grid)
    const privacyIdx = contactsSrc.indexOf(
      'Your contact data is stored privately and never shared',
    );
    expect(privacyIdx).toBeGreaterThan(-1);
    // The privacy notice should NOT be inside a selectedContact conditional
    const beforePrivacy = contactsSrc.slice(Math.max(0, privacyIdx - 500), privacyIdx);
    expect(beforePrivacy).not.toContain('{#if selectedContact}');
  });

  it('should have matching full footer class string on both pages', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    const contactsSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
      'utf8',
    );
    // Extract the full class attribute from the footer div
    const calFooterMatch = calendarSrc.match(
      /class="flex items-center gap-2 border-t border-border[^"]*"/,
    );
    const conFooterMatch = contactsSrc.match(
      /class="flex items-center gap-2 border-t border-border[^"]*"/,
    );
    expect(calFooterMatch).toBeTruthy();
    expect(conFooterMatch).toBeTruthy();
    expect(calFooterMatch[0]).toBe(conFooterMatch[0]);
  });

  it('should have matching icon sizes in both footers', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    const contactsSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Contacts.svelte'),
      'utf8',
    );
    // Both should use h-3.5 w-3.5 for the Info icon
    const calPrivacyIdx = calendarSrc.indexOf('Your calendar data is stored privately');
    const conPrivacyIdx = contactsSrc.indexOf('Your contact data is stored privately');
    const calBefore = calendarSrc.slice(Math.max(0, calPrivacyIdx - 200), calPrivacyIdx);
    const conBefore = contactsSrc.slice(Math.max(0, conPrivacyIdx - 200), conPrivacyIdx);
    expect(calBefore).toContain('h-3.5 w-3.5');
    expect(conBefore).toContain('h-3.5 w-3.5');
  });
});

// ============================================================
// 7. Calendar date picker CSS fixes
// ============================================================
describe('Calendar date picker CSS fixes', () => {
  let calendarSrc;

  beforeEach(() => {
    calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
  });

  it('should have date-picker-popup CSS override for padding', () => {
    expect(calendarSrc).toContain('sx__date-picker-popup');
    const idx = calendarSrc.indexOf('sx__date-picker-popup');
    const block = calendarSrc.slice(idx, idx + 300);
    expect(block).toContain('padding');
  });

  it('should have date-picker-popup overflow hidden to prevent scrollbar', () => {
    const idx = calendarSrc.indexOf('sx__date-picker-popup');
    const block = calendarSrc.slice(idx, idx + 300);
    expect(block).toContain('overflow: hidden');
  });

  it('should have dark mode styling for date-picker-popup', () => {
    // Check for is-dark mode styling (used for schedule-x dark theme)
    expect(calendarSrc).toContain('is-dark');
    const darkIdx = calendarSrc.indexOf('.sx-wrapper.is-dark');
    expect(darkIdx).toBeGreaterThan(-1);
  });
});

// ============================================================
// 8. Demo mode calendar data
// ============================================================
describe('Demo mode calendar data', () => {
  it('should return 3 calendars for the Calendars query', () => {
    const demoModeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/utils/demo-mode.js'),
      'utf8',
    );
    // Should have 3 calendar entries
    expect(demoModeSrc).toContain('demo-calendar');
    expect(demoModeSrc).toContain('demo-tasks');
    expect(demoModeSrc).toContain('demo-reminders');
  });

  it('should have Calendar, Tasks, and Reminders names', () => {
    const demoModeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/utils/demo-mode.js'),
      'utf8',
    );
    expect(demoModeSrc).toContain("name: 'Calendar'");
    expect(demoModeSrc).toContain("name: 'Tasks'");
    expect(demoModeSrc).toContain("name: 'Reminders'");
  });
});
// ============================================================
// 9. New Calendar creation feature
// ============================================================
describe('New Calendar creation feature', () => {
  const calendarSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
    'utf8',
  );
  it('should have createNewCalendar function', () => {
    expect(calendarSrc).toContain('createNewCalendar');
  });
  it('should have newCalendarModal state variable', () => {
    expect(calendarSrc).toContain('newCalendarModal');
  });
  it('should have newCalendarName state variable', () => {
    expect(calendarSrc).toContain('newCalendarName');
  });
  it('should call Remote.request with CalendarCreate for creation', () => {
    expect(calendarSrc).toContain("Remote.request('CalendarCreate'");
  });

  it('should use the calendar delete endpoint with explicit destructive confirmation text', () => {
    expect(calendarSrc).toMatch(/Remote\.request\(\s*'CalendarDelete'/);
    expect(calendarSrc).toContain('Are you sure you want to delete');
    expect(calendarSrc).toContain("This can't be undone.");
    expect(calendarSrc).toContain('Type the full calendar name to confirm deletion.');
    expect(calendarSrc).toContain('Delete Calendar');
  });
  it('should have Plus icon import', () => {
    expect(calendarSrc).toContain('Plus');
  });
  it('should have a dedicated Create Calendar button in the header', () => {
    expect(calendarSrc).toContain('class="calendar-create-button gap-2"');
    expect(calendarSrc).toContain('aria-label="Create calendar"');
    expect(calendarSrc).toContain('Create Calendar');
  });
  it('should have color palette for calendar creation', () => {
    expect(calendarSrc).toContain('newCalendarColor');
  });
  it('should have Dialog for new calendar creation', () => {
    expect(calendarSrc).toContain('Create Calendar');
  });
});

describe('Mailbox and calendar UI coverage', () => {
  const mailboxSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
    'utf8',
  );
  const mailboxCss = fs.readFileSync(
    path.resolve(__dirname, '../../src/styles/pages/mailbox.css'),
    'utf8',
  );
  const toastsSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/components/Toasts.svelte'),
    'utf8',
  );

  it('should keep the sidebar resize handle available in classic vertical split view', () => {
    expect(mailboxSrc).toContain('aria-label="Resize sidebar"');
    expect(mailboxSrc).not.toMatch(/\{#if !isVerticalDesktop\}[\s\S]*aria-label="Resize sidebar"/);
  });

  it('should keep both classic split resize handles visually consistent and clearly draggable', () => {
    expect(mailboxSrc).toContain('class:fe-vertical-resizer-active={resizingVertical}');
    expect(mailboxSrc).toContain('.fe-vertical-resizer,\n  .fe-sidebar-resizer');
    expect(mailboxSrc).toContain('.fe-vertical-resizer::before,\n  .fe-sidebar-resizer::before');
    expect(mailboxSrc).toContain('.fe-vertical-resizer::after,\n  .fe-sidebar-resizer::after');
    expect(mailboxSrc).toContain('width: 10px;');
    expect(mailboxSrc).toContain('height: 28px;');
    expect(mailboxSrc).toContain('background: transparent;');
    expect(mailboxSrc).toContain('repeating-linear-gradient(');
    expect(mailboxSrc).toContain('border-left: none;');
    expect(mailboxSrc).toContain('border-right: none;');
    expect(mailboxSrc).toContain('touch-action: none;');
  });

  it('should synchronize the mailbox shell grid with the live sidebar width', () => {
    expect(mailboxSrc).toContain('const shellStyle = $derived.by(() => {');
    expect(mailboxSrc).toContain('`--fe-sidebar-width: ${sidebarWidth}px`');
    expect(mailboxCss).toContain(
      'grid-template-columns: var(--fe-sidebar-width, 240px) minmax(0, 1fr) minmax(0, 1.2fr);',
    );
  });

  it('should hide the card or classic layout toggle in the mobile mailbox toolbar', () => {
    expect(mailboxSrc).toContain('{#if !isMobile}');
    expect(mailboxSrc).toContain(
      "aria-label={cardView ? 'Switch to classic view' : 'Switch to card view'}",
    );
    expect(mailboxSrc).not.toMatch(/\{#if isMobile\}[\s\S]*Switch to classic view/);
  });

  it('should keep shared toasts above dialog overlays', () => {
    expect(toastsSrc).toContain('style="z-index: 10010;"');
  });
});

describe('Large mailbox bootstrap timeout regressions', () => {
  const loginSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Login.svelte'),
    'utf8',
  );
  const mailboxStoreSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/stores/mailboxStore.ts'),
    'utf8',
  );
  const remoteSrc = fs.readFileSync(path.resolve(__dirname, '../../src/utils/remote.js'), 'utf8');

  it('should keep the calendar dropdown visible when at least one calendar exists', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    expect(calendarSrc).toMatch(/\{#if !isMobile && calendars\.length > 0\}/);
    expect(calendarSrc).not.toMatch(/\{#if !isMobile && calendars\.length > 1\}/);
  });

  it('should keep the Create Calendar button visible independently of calendar count', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    expect(calendarSrc).toContain('class="calendar-create-button gap-2"');
    expect(calendarSrc).not.toContain(
      '{#if !isMobile && calendars.length > 0}\n        <Button\n          variant="outline"\n          class="calendar-create-button gap-2"',
    );
  });

  it('should block new-event creation when no calendar is selected', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    expect(calendarSrc).toContain('const ensureEventCalendarSelected = () => {');
    expect(calendarSrc).toContain('Select a calendar before adding an event.');
    expect(calendarSrc).toContain('Create a calendar before adding an event.');
    expect(calendarSrc).toContain('disabled={!activeCalendar()}');
  });

  it('should clear stale calendar state immediately after deleting the last remaining calendar', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    expect(calendarSrc).toContain('selectedCalendarIds = [];');
    expect(calendarSrc).toContain("activeCalendarId = '';");
    expect(calendarSrc).toContain('calendarInstance = null;');
    expect(calendarSrc).toContain('calendarCreated = false;');
    expect(calendarSrc).toContain('await persistCalendarPrefs(accountKey, []);');
  });

  it('should preserve reply references in sent-copy payloads and in-window reply prefill', () => {
    const sentCopySrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/utils/sent-copy.js'),
      'utf8',
    );
    const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main.ts'), 'utf8');
    expect(sentCopySrc).toContain('references: emailPayload.references ||');
    expect(mainSrc).toContain('references: prefill?.references');
    expect(mainSrc).toContain('refreshReplyTargets?.({ force: true })');
  });

  it('should preserve the current message selection after sending a reply reloads the inbox', () => {
    const mainSrc = fs.readFileSync(path.resolve(__dirname, '../../src/main.ts'), 'utf8');
    expect(mainSrc).toContain('const preservedSelectionId = preservedSelection?.id || null');
    expect(mainSrc).toContain('await mailboxStore.actions.loadMessages?.()');
    expect(mainSrc).toContain('mailboxStore.actions.selectMessage?.(refreshedSelection)');
  });

  it('should clear stale conversation state and select the next message when moving the current message', () => {
    const storeSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/stores/mailboxStore.ts'),
      'utf8',
    );
    expect(storeSrc).toContain('const nextList = originalList.filter((m) => m.id !== msg.id)');
    expect(storeSrc).toContain('selectedConversationIds.set([])');
    expect(storeSrc).toContain('selectedMessage.set(nextSelected)');
  });

  it('should use a native Tauri save dialog and write attachments to the user-selected path', () => {
    const mailServiceSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/stores/mailService.ts'),
      'utf8',
    );
    expect(mailServiceSrc).toContain('sanitizeDownloadFilename');
    expect(mailServiceSrc).toContain('buildSaveDialogFilters');
    expect(mailServiceSrc).toContain(
      "const { save, message } = await import('@tauri-apps/plugin-dialog')",
    );
    expect(mailServiceSrc).toContain('defaultPath: safeFilename');
    expect(mailServiceSrc).toContain('await writeFile(outputPath, bytes)');
    expect(mailServiceSrc).toContain('allow access if your operating system blocked the write');
    expect(mailServiceSrc).not.toContain('baseDir: BaseDirectory.Download');
  });

  it('should allow per-request timeout overrides in the remote client', () => {
    expect(remoteSrc).toContain(
      'options.timeout ?? TIMEOUT_BY_ACTION[action] ?? TIMEOUT_BY_ACTION.default',
    );
  });

  it('should use a longer folders timeout during login bootstrap', () => {
    expect(loginSrc).toContain('const LOGIN_FOLDERS_TIMEOUT_MS = 120_000');
    expect(loginSrc).toMatch(
      /Remote\.request\([\s\S]*'Folders'[\s\S]*timeout:\s*LOGIN_FOLDERS_TIMEOUT_MS/,
    );
  });

  it('should use longer fallback timeouts when bootstrapping folders and messages', () => {
    expect(mailboxStoreSrc).toMatch(/Remote\.request\([\s\S]*'Folders'[\s\S]*timeout:\s*120_000/);
    expect(mailboxStoreSrc).toMatch(
      /Remote\.request\('MessageList', params, \{[\s\S]*timeout:\s*60_000/,
    );
  });
});

// ============================================================
// 10. PGP save, retry, and in-app settings navigation regressions
// ============================================================
describe('PGP desktop and settings regressions', () => {
  const mailboxSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
    'utf8',
  );
  const settingsSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Settings.svelte'),
    'utf8',
  );
  const passphraseModalSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/PassphraseModal.svelte'),
    'utf8',
  );
  const mailServiceSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/stores/mailService.ts'),
    'utf8',
  );

  it('should keep Add PGP Key navigation inside the desktop app', () => {
    expect(mailboxSrc).toContain("onclick={() => navigate('/mailbox/settings#accounts')}");
    expect(mailboxSrc).not.toContain('href="/mailbox/settings#accounts"');
  });

  it('should let settings capture an optional private-key passphrase at save time', () => {
    expect(settingsSrc).toContain('Private key passphrase (optional)');
    expect(settingsSrc).toContain('unlockPgpKey({');
    expect(settingsSrc).toContain('Encryption key saved and unlocked locally.');
  });

  it('should await encrypted-body invalidation after key saves and removals', () => {
    expect(settingsSrc).toContain('await invalidatePgpCachedBodies(currentAcct);');
    expect(settingsSrc).toContain("setSuccess('Encryption key removed.')");
  });

  it('should explain that the runtime passphrase unlock is separate from pasting the key', () => {
    expect(passphraseModalSrc).toContain(
      'This passphrase unlocks your private key. It is separate from pasting the key itself.',
    );
    expect(passphraseModalSrc).toContain('Remember this passphrase on this device');
  });

  it('should clear invalid stored passphrases and retry prompting after unlock failures', () => {
    expect(mailServiceSrc).toContain('function clearSavedPassphrase');
    expect(mailServiceSrc).toContain('clearSavedPassphrase(key.name);');
    expect(mailServiceSrc).toContain('while (needsPassphrase)');
    expect(mailServiceSrc).toContain('rememberPassphrase = res?.remember !== false;');
    expect(mailServiceSrc).toContain('if (passphrase && rememberPassphrase) {');
  });
});
