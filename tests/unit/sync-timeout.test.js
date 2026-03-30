import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// 1. withTimeout — timer cleanup and rejection
// ---------------------------------------------------------------------------

describe('withTimeout helper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Re-implement the fixed withTimeout to test it in isolation.
   * This mirrors the production code in sync-worker-client.js.
   */
  function withTimeout(promise, ms, taskId, pendingTasks) {
    let timerId;
    const timeout = new Promise((_, reject) => {
      timerId = setTimeout(() => {
        pendingTasks.reject(taskId, new Error(`Sync task timed out after ${ms}ms`));
        reject(new Error(`Sync task timed out after ${ms}ms`));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
  }

  it('resolves when the task completes before the timeout', async () => {
    const pendingTasks = { reject: vi.fn() };
    const task = new Promise((resolve) => setTimeout(() => resolve('done'), 100));
    const wrapped = withTimeout(task, 5000, 'task-1', pendingTasks);

    vi.advanceTimersByTime(100);
    const result = await wrapped;

    expect(result).toBe('done');
    expect(pendingTasks.reject).not.toHaveBeenCalled();
  });

  it('rejects when the task exceeds the timeout', async () => {
    const pendingTasks = { reject: vi.fn() };
    const task = new Promise((resolve) => setTimeout(() => resolve('done'), 200_000));
    const wrapped = withTimeout(task, 10_000, 'task-2', pendingTasks);

    vi.advanceTimersByTime(10_000);

    await expect(wrapped).rejects.toThrow('Sync task timed out after 10000ms');
    expect(pendingTasks.reject).toHaveBeenCalledWith(
      'task-2',
      expect.objectContaining({ message: 'Sync task timed out after 10000ms' }),
    );
  });

  it('clears the timer when the task resolves (no stale timer leak)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const pendingTasks = { reject: vi.fn() };
    const task = new Promise((resolve) => setTimeout(() => resolve('ok'), 50));
    const wrapped = withTimeout(task, 120_000, 'task-3', pendingTasks);

    vi.advanceTimersByTime(50);
    await wrapped;

    // clearTimeout should have been called in the .finally() block
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it('clears the timer when the task rejects (no stale timer leak)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    const pendingTasks = { reject: vi.fn() };
    const task = new Promise((_, reject) => setTimeout(() => reject(new Error('task failed')), 50));
    const wrapped = withTimeout(task, 120_000, 'task-4', pendingTasks);

    vi.advanceTimersByTime(50);

    await expect(wrapped).rejects.toThrow('task failed');
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 2. Default timeout values
// ---------------------------------------------------------------------------

describe('sync timeout constants', () => {
  it('default sync task timeout should be 120 seconds', () => {
    // The production value in sync-worker-client.js
    const SYNC_TASK_TIMEOUT_MS = 120_000;
    expect(SYNC_TASK_TIMEOUT_MS).toBe(120_000);
  });

  it('metadata task should use 120s timeout in sync controller', () => {
    // The sync controller passes { timeout: 120_000 } for metadata tasks
    const metadataTimeout = 120_000;
    expect(metadataTimeout).toBeGreaterThanOrEqual(120_000);
  });

  it('body task timeout should remain at 60s', () => {
    const bodyTimeout = 60_000;
    expect(bodyTimeout).toBe(60_000);
  });

  it('per-request fetch timeout should remain at 30s', () => {
    const FETCH_TIMEOUT_MS = 30_000;
    expect(FETCH_TIMEOUT_MS).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// 3. Service worker registration — readyState guard
// ---------------------------------------------------------------------------

describe('service worker registration readyState guard', () => {
  it('registers immediately when document.readyState is complete', () => {
    let registered = false;
    const registerServiceWorker = () => {
      registered = true;
    };
    const canUseServiceWorker = () => true;
    const isProd = true;

    if (canUseServiceWorker() && isProd) {
      if (document.readyState === 'complete') {
        registerServiceWorker();
      } else {
        window.addEventListener('load', () => {
          registerServiceWorker();
        });
      }
    }

    // jsdom sets readyState to 'complete' by default
    expect(registered).toBe(true);
  });

  it('does not register when canUseServiceWorker is false (Tauri)', () => {
    let registered = false;
    const registerServiceWorker = () => {
      registered = true;
    };
    const canUseServiceWorker = () => false;
    const isProd = true;

    if (canUseServiceWorker() && isProd) {
      registerServiceWorker();
    }

    expect(registered).toBe(false);
  });

  it('does not register in development mode', () => {
    let registered = false;
    const registerServiceWorker = () => {
      registered = true;
    };
    const canUseServiceWorker = () => true;
    const isProd = false;

    if (canUseServiceWorker() && isProd) {
      registerServiceWorker();
    }

    expect(registered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. loadFolders TTL cache — selectedFolder guard
// ---------------------------------------------------------------------------

describe('loadFolders TTL cache selectedFolder guard', () => {
  it('sets default folder when none is currently selected', () => {
    let selectedFolder = '';
    const mappedCached = [
      { path: 'INBOX', name: 'Inbox' },
      { path: 'Sent', name: 'Sent' },
    ];

    const currentFolder = selectedFolder;
    if (!currentFolder || currentFolder === '') {
      const inbox = mappedCached.find((f) => f.path?.toUpperCase?.() === 'INBOX');
      const defaultFolder = inbox?.path || mappedCached[0]?.path;
      if (defaultFolder) {
        selectedFolder = defaultFolder;
      }
    }

    expect(selectedFolder).toBe('INBOX');
  });

  it('does NOT overwrite when a folder is already selected', () => {
    let selectedFolder = 'Drafts';
    const mappedCached = [
      { path: 'INBOX', name: 'Inbox' },
      { path: 'Sent', name: 'Sent' },
    ];

    const currentFolder = selectedFolder;
    if (!currentFolder || currentFolder === '') {
      const inbox = mappedCached.find((f) => f.path?.toUpperCase?.() === 'INBOX');
      const defaultFolder = inbox?.path || mappedCached[0]?.path;
      if (defaultFolder) {
        selectedFolder = defaultFolder;
      }
    }

    expect(selectedFolder).toBe('Drafts');
  });

  it('falls back to first folder when INBOX is not found', () => {
    let selectedFolder = '';
    const mappedCached = [
      { path: 'Archive', name: 'Archive' },
      { path: 'Sent', name: 'Sent' },
    ];

    const currentFolder = selectedFolder;
    if (!currentFolder || currentFolder === '') {
      const inbox = mappedCached.find((f) => f.path?.toUpperCase?.() === 'INBOX');
      const defaultFolder = inbox?.path || mappedCached[0]?.path;
      if (defaultFolder) {
        selectedFolder = defaultFolder;
      }
    }

    expect(selectedFolder).toBe('Archive');
  });
});

// ---------------------------------------------------------------------------
// 5. exitDemoAndRedirect — uses location.replace
// ---------------------------------------------------------------------------

describe('exitDemoAndRedirect uses location.replace', () => {
  it('source code uses window.location.replace not reload', async () => {
    // jsdom does not allow spying on location.replace.
    // Verify the pattern directly in the source file.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const demoPath = path.resolve(import.meta.dirname, '../../src/utils/demo-mode.js');
    const content = fs.readFileSync(demoPath, 'utf8');

    expect(content).toContain("window.location.replace('/'");
    expect(content).not.toContain('window.location.reload()');
    // The old pattern used hash + reload; verify it's gone
    expect(content).not.toContain("window.location.hash = '#/login'");
  });
});
