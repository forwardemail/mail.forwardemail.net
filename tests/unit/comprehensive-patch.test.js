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
  it('should expose Create Calendar as a kebab menu item in the header', () => {
    // Calendar header collapsed into a kebab on both viewports (matches mobile pattern).
    // Create Calendar lives inside the DropdownMenu.Content as an Item, not a standalone button.
    expect(calendarSrc).toMatch(
      /<DropdownMenu\.Item[^>]*\s*onclick=\{[^}]*newCalendarModal\s*=\s*true/,
    );
    expect(calendarSrc).toContain('<span>Create Calendar</span>');
    expect(calendarSrc).toContain('aria-label="Calendar menu"');
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

  it('should keep the Create Calendar action reachable independently of calendar count', () => {
    const calendarSrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
      'utf8',
    );
    // The Create Calendar kebab item must not be gated behind any calendars.length check
    // (only the calendars-filter dropdown is gated by calendars.length > 0).
    const createCalendarSnippet = calendarSrc.slice(
      0,
      calendarSrc.indexOf('<span>Create Calendar</span>'),
    );
    const lastIfBefore = createCalendarSnippet.lastIndexOf('{#if');
    const lastEndifBefore = createCalendarSnippet.lastIndexOf('{/if}');
    // The most recent {#if} before the Create Calendar item must already be closed.
    expect(lastEndifBefore).toBeGreaterThan(lastIfBefore);
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
    // Save dialog routes through saveFileDialog (utils/download), which
    // applies the macOS Tahoe NSSavePanel nil-return workaround.
    expect(mailServiceSrc).toContain(
      "const { saveFileDialog } = await import('../utils/download')",
    );
    expect(mailServiceSrc).toContain('const bytes = await readDownloadBytes(href)');
    expect(mailServiceSrc).toContain("new CustomEvent('fe:mail-service-toast'");
    expect(mailServiceSrc).toContain('defaultPath: safeFilename');
    expect(mailServiceSrc).toContain('await writeChunked(outputPath, bytes)');
    expect(mailServiceSrc).toContain('streamFetchToFile');
    expect(mailServiceSrc).toContain('response.body');
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
  const aboutDialogSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/AboutDialog.svelte'),
    'utf8',
  );
  const mailServiceSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/stores/mailService.ts'),
    'utf8',
  );
  const updaterBridgeSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/utils/updater-bridge.js'),
    'utf8',
  );
  const syncWorkerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/workers/sync.worker.ts'),
    'utf8',
  );

  it('should keep Add PGP Key navigation inside the desktop app', () => {
    expect(mailboxSrc).toContain("onclick={() => navigate('/mailbox/settings#accounts')}");
    expect(mailboxSrc).not.toContain('href="/mailbox/settings#accounts"');
  });

  it('should let settings capture an optional private-key passphrase at save time', () => {
    expect(settingsSrc).toContain('Private key passphrase (optional)');
    expect(settingsSrc).toContain('checkOnly: true');
    expect(settingsSrc).toContain('Please provide a PGP private key, not a public key.');
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
    expect(mailServiceSrc).toContain('waitForPassphraseModal');
    expect(mailServiceSrc).toContain('getPassphraseModalIfAvailable');
    expect(mailServiceSrc).toContain('while (needsPassphrase)');
    expect(mailServiceSrc).toContain('rememberPassphrase = res?.remember !== false;');
    expect(mailServiceSrc).toContain('if (passphrase && rememberPassphrase) {');
    expect(mailServiceSrc).toContain('if (promptedThisAttempt) {');
    expect(mailServiceSrc).toContain('lastUnlockError && /no unlocked keys available/i.test');
  });

  it('should subscribe to live PGP key version changes and re-attempt decryption when the mailbox is active', () => {
    expect(mailServiceSrc).toContain('export const pgpKeysVersion = writable(_pgpKeysVersion);');
    expect(mailboxSrc).toContain('pgpKeysVersion.subscribe((version) => {');
    expect(mailboxSrc).toContain('if (pgpReloadPending && isActive) {');
  });

  it('should force fresh desktop update checks in Settings and About dialog', () => {
    expect(settingsSrc).toContain('checkForUpdates({ force: true })');
    expect(aboutDialogSrc).toContain('checkForUpdates({ force: true })');
    expect(updaterBridgeSrc).toContain('const force = options?.force === true;');
    expect(updaterBridgeSrc).toContain('if (!force && sinceLast < MIN_CHECK_INTERVAL_MS) {');
  });

  it('should only load About dialog metadata when the dialog is opened', () => {
    expect(aboutDialogSrc).toContain('const loadAboutInfo = async (): Promise<void> => {');
    expect(aboutDialogSrc).toContain('if (!open) return;');
    expect(aboutDialogSrc).toContain('void loadAboutInfo();');
  });

  it('should keep attachment trays sticky at the bottom of the reader pane', () => {
    expect(mailboxSrc).toContain('sticky bottom-0 z-10 mt-4 border-t border-border');
    expect(mailboxSrc).toContain(
      'sticky bottom-0 z-10 mt-4 flex flex-wrap gap-2 border-t border-border',
    );
  });

  it('should skip invalid stored keys instead of treating them like retryable passphrase failures', () => {
    expect(syncWorkerSrc).toContain('Skipping invalid PGP private key');
    expect(syncWorkerSrc).toContain('function isRetryablePgpUnlockError');
    expect(syncWorkerSrc).toContain('invalidKey: true');
    expect(syncWorkerSrc).toContain('needsPassphrase: retryable');
  });
});

// ============================================================
// 11. Pre-release regression guards (May 2026 round)
// ============================================================
describe('pre-release regression guards', () => {
  const notificationMgrSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/utils/notification-manager.js'),
    'utf8',
  );
  const swSyncSrc = fs.readFileSync(path.resolve(__dirname, '../../public/sw-sync.js'), 'utf8');
  const syncHelpersSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/utils/sync-helpers.ts'),
    'utf8',
  );
  const settingsRegistrySrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/stores/settingsRegistry.ts'),
    'utf8',
  );
  const inviteCardSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/components/CalendarInviteCard.svelte'),
    'utf8',
  );
  const mailboxStorePrSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/stores/mailboxStore.ts'),
    'utf8',
  );
  const mailboxSveltePrSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
    'utf8',
  );
  const filePickerRustSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src-tauri/src/file_picker_macos.rs'),
    'utf8',
  );
  const downloadSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/utils/download.ts'),
    'utf8',
  );
  const filePickerJsSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/utils/file-picker.ts'),
    'utf8',
  );

  it('notification filter covers \\Seen + Archive/Junk/Trash specialUse and name list', () => {
    expect(notificationMgrSrc).toContain('SILENT_SPECIAL_USE');
    expect(notificationMgrSrc).toContain("'\\\\Archive'");
    expect(notificationMgrSrc).toContain("'\\\\Junk'");
    expect(notificationMgrSrc).toContain("'\\\\Trash'");
    expect(notificationMgrSrc).toContain("'\\\\All'");
    expect(notificationMgrSrc).toContain("'ARCHIVE'");
    expect(notificationMgrSrc).toContain("'JUNK'");
    expect(notificationMgrSrc).toContain("'TRASH'");
    // hasSeenFlag is the gate that catches Thunderbird IMAP COPY/APPEND.
    expect(notificationMgrSrc).toMatch(/const hasSeenFlag\s*=/);
    expect(notificationMgrSrc).toContain('if (hasSeenFlag(msg)) return;');
  });

  it('handleNewMessage optimistically prepends to the message store', () => {
    expect(notificationMgrSrc).toContain('prependNewMessageToStore');
    expect(notificationMgrSrc).toContain('mailboxStore.state.messages.set([envelope');
    expect(notificationMgrSrc).toContain('__optimistic: true');
  });

  it('sw-sync normalizeMessage never falls back to Date.now() for the message date', () => {
    // The literal "Date.now()" fallback that caused the bulk-sync date bug
    // must be gone — the line now resolves to 0 when no date field is usable.
    expect(swSyncSrc).not.toMatch(/new Date\(rawDate \|\| Date\.now\(\)\)/);
    expect(swSyncSrc).toContain('raw.created_at ||');
    expect(swSyncSrc).toMatch(/parsedDate\.getTime\(\)\s*:\s*0/);
  });

  it('sync-helpers normalizeMessageForCache never falls back to Date.now() for the message date', () => {
    expect(syncHelpersSrc).not.toMatch(/parsedDate\.getTime\(\)\s*:\s*Date\.now\(\)/);
    expect(syncHelpersSrc).toMatch(/parsedDate\.getTime\(\)\s*:\s*0/);
  });

  it('default_calendar_id setting is registered as an account-scoped device key', () => {
    expect(settingsRegistrySrc).toContain('default_calendar_id:');
    expect(settingsRegistrySrc).toMatch(/default_calendar_id_\$\{account\}/);
    expect(settingsRegistrySrc).toMatch(/id:\s*'default_calendar_id'/);
  });

  it('CalendarInviteCard prefers the saved default before "Calendar"/list[0]', () => {
    // The picker must read the saved id first and only fall back to the
    // label-match → list[0] heuristic, otherwise invites can land on a
    // "random" calendar when no calendar is literally named "Calendar".
    expect(inviteCardSrc).toContain('Local.get(defaultCalendarKey())');
    expect(inviteCardSrc).toContain('Local.set(defaultCalendarKey(), calendarId)');
    expect(inviteCardSrc).toMatch(/<select[\s\S]*bind:value=\{selectedCalendarId\}/);
  });

  it('markFolderAsRead no longer hits .modify((m) => …) — db worker rejects that', () => {
    // The bug surfaced as "db worker modify does not support function
    // callbacks; pass an object". Switching to bulkPut preserves \Flagged
    // while clearing the function-callback path entirely.
    expect(mailboxStorePrSrc).toContain('await db.messages.bulkPut(updated)');
    // Defence-in-depth: assert there's no `.modify(` with an arrow-fn body
    // sitting inside the markFolderAsRead helper specifically.
    const markStart = mailboxStorePrSrc.indexOf('const markFolderAsRead');
    expect(markStart).toBeGreaterThan(-1);
    const markEnd = mailboxStorePrSrc.indexOf('const getSpamFolderPath', markStart);
    // Strip // line comments so the assertion catches real code only, not the
    // explanatory comment that describes the previous buggy form.
    const markBody = mailboxStorePrSrc
      .slice(markStart, markEnd)
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(markBody).not.toMatch(/\.modify\(\s*\(m\)\s*=>/);
  });

  it('Mailbox.svelte removed the "Page N" desktop pagination and enabled desktop infinite scroll', () => {
    expect(mailboxSveltePrSrc).not.toContain('<span>Page {$page}</span>');
    expect(mailboxSveltePrSrc).not.toContain('class="fe-pagination');
    // Infinite-scroll observer no longer gates on isMobileViewport().
    expect(mailboxSveltePrSrc).toMatch(
      /infiniteScrollObserver\s*=\s*new IntersectionObserver[\s\S]{0,400}entry\.isIntersecting && \$hasNextPage/,
    );
  });

  it('account switch clears the viewed-email state in the currentAccount subscriber', () => {
    // Belt-and-suspenders clear inside the Mailbox component, on top of
    // performAccountSwitch's own clears. Pin both lines so a future "DRY
    // it up" refactor doesn't silently bring back the stale-body bug.
    expect(mailboxSveltePrSrc).toContain('mailboxStore?.state?.selectedMessage?.set?.(null);');
    expect(mailboxSveltePrSrc).toContain("mailboxStore?.state?.messageBody?.set?.('');");
    expect(mailboxSveltePrSrc).toContain('mailboxStore?.state?.attachments?.set?.([]);');
  });

  it('save_file_macos Rust command exists and uses nullable NSSavePanel construction', () => {
    expect(filePickerRustSrc).toContain('pub fn save_file_macos');
    expect(filePickerRustSrc).toContain('create_save_panel');
    // Nullable msg_send! is the key Tahoe-safety pattern.
    expect(filePickerRustSrc).toMatch(
      /let panel:\s*Option<Retained<NSSavePanel>>\s*=\s*msg_send!\[class,\s*savePanel\]/,
    );
    // alloc/init fallback path mirrors the open-panel wrapper.
    expect(filePickerRustSrc).toMatch(/mtm\.alloc::<NSSavePanel>\(\)/);
  });

  it('JS saveFileDialog routes through save_file_macos on macOS', () => {
    expect(downloadSrc).toContain('export async function saveFileDialog');
    expect(downloadSrc).toContain('isMacOSPlatform');
    expect(downloadSrc).toContain("invoke<string | null>('save_file_macos'");
  });

  it('file-picker no longer falls back to plugin-dialog open() on macOS (would SIGABRT)', () => {
    // The literal fallback import that previously triggered the open-panel
    // crash on Tahoe must be gone from the macOS branch.
    const macBranchStart = filePickerJsSrc.indexOf('if (isMacOS)');
    const macBranchEnd = filePickerJsSrc.indexOf('} else {', macBranchStart);
    const macBranch = filePickerJsSrc.slice(macBranchStart, macBranchEnd);
    expect(macBranch).not.toContain('@tauri-apps/plugin-dialog');
  });
});

// ============================================================
// 12. Round-2 fix regression guards (May 2026 follow-up batch)
// ============================================================
describe('round-2 fix regression guards', () => {
  const messageRowSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/MessageRow.svelte'),
    'utf8',
  );
  const calendarSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Calendar.svelte'),
    'utf8',
  );
  const mailboxSrcR2 = fs.readFileSync(
    path.resolve(__dirname, '../../src/svelte/Mailbox.svelte'),
    'utf8',
  );
  const tokensSrc = fs.readFileSync(path.resolve(__dirname, '../../src/styles/tokens.css'), 'utf8');
  const indexHtmlSrc = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

  it('MessageRow binds unread to font weight on both from line and subject', () => {
    // Pre-fix: from line was unconditionally font-semibold, subject was
    // unconditionally font-medium — only the bg-primary/5 tint cued unread.
    // Now: bold for unread, normal for read on both. Whitespace-tolerant
    // regex so reformats (e.g. prettier line wrapping) don't false-fail.
    expect(messageRowSrc).toMatch(/\{\s*unread\s*\?\s*'font-bold'\s*:\s*'font-normal'\s*\}/);
    expect(messageRowSrc).toMatch(/\{\s*unread\s*\?\s*'font-semibold'\s*:\s*'font-normal'\s*\}/);
    // Defence-in-depth: assert the *unconditional* pre-fix classes are gone.
    expect(messageRowSrc).not.toMatch(/gap-1\.5\s+font-semibold\s+text-foreground"/);
    expect(messageRowSrc).not.toMatch(/truncate\s+font-medium\s+text-foreground"/);
  });

  it('Calendar applyRemoteChange triggers a fresh event fetch for CREATE/UPDATE', () => {
    // Pre-fix: applyRemoteChange called load(), which only refetches the
    // calendar list — not events. So WS-driven calendarEventCreated /
    // calendarEventUpdated payloads didn't surface in the events grid.
    expect(calendarSrc).toContain('const applyRemoteChange');
    // Both fall-throughs (no payload, and after the calendarEventDeleted
    // branch) must hit loadEventsForSelection(true).
    expect(calendarSrc).toMatch(
      /const applyRemoteChange[\s\S]{0,1500}loadEventsForSelection\(true\)/,
    );
    // load() now also force-refreshes events on re-activation (calendars
    // already cached path) so events don't starve out on tab switches.
    expect(calendarSrc).toMatch(
      /const load\s*=\s*async[\s\S]{0,1200}else\s*\{[\s\S]{0,400}loadEventsForSelection\(true\)/,
    );
  });

  it('handleFolderDrop re-points selection via nextCandidate after move', () => {
    // Pre-fix: drag-drop left selectedMessage pinned to the moved row, so
    // the reader pane kept showing the moved subject. Now: compute fallback
    // *before* the move (source row still in list), apply after; if the
    // fallback itself was part of the moved set, clear the reader instead.
    expect(mailboxSrcR2).toContain('const handleFolderDrop');
    const dropStart = mailboxSrcR2.indexOf('const handleFolderDrop');
    const dropEnd = mailboxSrcR2.indexOf('const handleReaderSwipeStart', dropStart);
    const dropBody = mailboxSrcR2.slice(dropStart, dropEnd);
    expect(dropBody).toContain('const fallback = wasSelected ? nextCandidate() : null;');
    expect(dropBody).toContain('if (wasSelected) {');
    expect(dropBody).toContain('selectedMessage?.set?.(null);');
  });

  it('drag-hover folder expand uses a 2500ms delay', () => {
    // Bumped from 1500ms because folder-tree shift mid-drag pushed the
    // intended drop target off-screen even at 1.5s.
    expect(mailboxSrcR2).toMatch(/toggleFolderExpansion\(folder\.path\);\s*\}\s*,\s*2500\)/);
  });

  it('row click dispatches through handleRowClick with modifier handling', () => {
    // cmd/ctrl+click = additive toggle, shift+click = range select via
    // lastSelectionAnchorId. Plain click sets anchor and calls open().
    expect(mailboxSrcR2).toContain('let lastSelectionAnchorId');
    expect(mailboxSrcR2).toContain('const handleRowClick');
    expect(mailboxSrcR2).toMatch(/event\?\.metaKey\s*\|\|\s*event\?\.ctrlKey/);
    expect(mailboxSrcR2).toMatch(/event\?\.shiftKey/);
    // Both row variants (threaded conversation row, non-threaded message
    // row) must call through handleRowClick, otherwise the modifiers are
    // ignored for half the views.
    expect(mailboxSrcR2).toContain('handleRowClick(conv, e, $filteredConversations || []');
    expect(mailboxSrcR2).toContain('handleRowClick(msg, e, $filteredMessages || []');
  });

  it('dark theme surface tokens are at hue 0 with 0% saturation', () => {
    // Previous palette held hue 240 at 4-6% sat. Pure grey (0 0% L%)
    // removes the blue cast at full-window scale. Accent (199°) retained.
    expect(tokensSrc).toContain('--background: 0 0% 6%;');
    expect(tokensSrc).toContain('--card: 0 0% 8%;');
    expect(tokensSrc).toContain('--popover: 0 0% 10%;');
    expect(tokensSrc).toContain('--muted: 0 0% 16%;');
    expect(tokensSrc).toContain('--border: 0 0% 18%;');
    expect(tokensSrc).toContain('--sidebar-background: 0 0% 10%;');
    // Accent must remain blue/cyan — these are intentional.
    expect(tokensSrc).toContain('--primary: 199 89% 49%;');
    expect(tokensSrc).toContain('--ring: 199 89% 49%;');
  });

  it('startup fatal-error overlay ignores WebDriver harness noise', () => {
    // The overlay was catching WDIO "stale element reference" rejections
    // and rendering a z-index:max panel that blocked every subsequent
    // test click. Filtering before render keeps production diagnostics
    // intact while keeping CI green.
    expect(indexHtmlSrc).toContain('isTestHarnessNoise');
    expect(indexHtmlSrc).toContain('stale element reference');
    expect(indexHtmlSrc).toContain('WebDriverError');
    expect(indexHtmlSrc).toContain('element click intercepted');
  });

  it('threaded conversation row exposes data-slot="checkbox"', () => {
    // mark-as-read.spec.ts targets [data-slot="checkbox"] which comes
    // from shadcn's <Checkbox> in MessageRow.svelte. The threaded view
    // uses a custom button — without this testid, the existing test
    // can't find the checkbox in threaded mode (the demo default).
    expect(mailboxSrcR2).toMatch(
      /aria-label=\{[\s\S]{0,180}'Deselect'[\s\S]{0,180}data-slot="checkbox"/,
    );
  });
});
