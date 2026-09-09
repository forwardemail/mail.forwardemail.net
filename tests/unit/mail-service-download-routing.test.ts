import { beforeEach, describe, expect, it, vi } from 'vitest';

// Regression for the Android "Download does nothing" bug. The attachment and
// image-preview Download buttons used to gate the native save path on
// isTauriDesktop, so mobile fell through to an <a download> click. The
// Android WebView wry creates has no DownloadListener and WKWebView ignores
// the download attribute, so nothing happened and no error surfaced.

const mocks = vi.hoisted(() => ({
  platform: { isTauri: false, isTauriDesktop: false, isTauriMobile: false },
  save: vi.fn(),
  writeFile: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../../src/utils/platform.js', () => mocks.platform);
vi.mock('../../src/utils/file-picker', () => ({ isMacOSPlatform: false }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
vi.mock('@tauri-apps/plugin-fs', () => ({ writeFile: mocks.writeFile, remove: mocks.remove }));

vi.mock('../../src/utils/db.js', () => ({ db: { messageBodies: { where: vi.fn() } } }));
vi.mock('../../src/utils/storage.js', () => ({ Local: { get: vi.fn(() => null) } }));
vi.mock('../../src/utils/remote.js', () => ({ Remote: { request: vi.fn() } }));
vi.mock('../../src/utils/sync-worker-client.js', () => ({
  sendSyncRequest: vi.fn(),
  refreshSyncWorkerPgpKeys: vi.fn(),
  requestPgpDecryption: vi.fn(),
  unlockPgpKey: vi.fn(),
  requestParsing: vi.fn(),
}));
vi.mock('../../src/utils/perf-logger.ts', () => ({
  createPerfTracer: vi.fn(() => ({ stage: vi.fn(), end: vi.fn() })),
}));
vi.mock('../../src/utils/logger.ts', () => ({ warn: vi.fn() }));

import { mailService } from '../../src/stores/mailService';

const attachment = {
  filename: 'photo.png',
  contentType: 'image/png',
  // "hello" as a data URL, the shape image previews carry on mobile
  href: 'data:image/png;base64,aGVsbG8=',
};
const message = { id: 'm1', folder: 'INBOX' };

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('mailService.downloadAttachment platform routing', () => {
  let anchorClicks: number;

  beforeEach(() => {
    vi.clearAllMocks();
    anchorClicks = 0;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      anchorClicks++;
    });
    mocks.save.mockResolvedValue('content://com.android.providers.downloads/document/42');
    mocks.writeFile.mockResolvedValue(undefined);
  });

  it('uses the native save dialog and fs plugin on Tauri mobile', async () => {
    mocks.platform.isTauri = true;
    mocks.platform.isTauriMobile = true;
    mocks.platform.isTauriDesktop = false;

    await mailService.downloadAttachment(attachment as never, message as never);
    await flush();

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][0]).toMatchObject({ defaultPath: 'photo.png' });
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    const [path, bytes] = mocks.writeFile.mock.calls[0];
    expect(path).toBe('content://com.android.providers.downloads/document/42');
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('hello');
    expect(anchorClicks).toBe(0);
  });

  it('still uses the native save dialog on Tauri desktop', async () => {
    mocks.platform.isTauri = true;
    mocks.platform.isTauriMobile = false;
    mocks.platform.isTauriDesktop = true;

    await mailService.downloadAttachment(attachment as never, message as never);
    await flush();

    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).toHaveBeenCalledTimes(1);
    expect(anchorClicks).toBe(0);
  });

  it('keeps the anchor download on the web', async () => {
    mocks.platform.isTauri = false;
    mocks.platform.isTauriMobile = false;
    mocks.platform.isTauriDesktop = false;

    await mailService.downloadAttachment(attachment as never, message as never);
    await flush();

    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(anchorClicks).toBe(1);
  });

  it('surfaces a toast when the save dialog itself fails', async () => {
    mocks.platform.isTauri = true;
    mocks.platform.isTauriMobile = true;
    mocks.platform.isTauriDesktop = false;
    mocks.save.mockRejectedValue(new Error('dialog.save not allowed'));
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener('fe:mail-service-toast', onToast);

    await mailService.downloadAttachment(attachment as never, message as never);
    await flush();
    window.removeEventListener('fe:mail-service-toast', onToast);

    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ type: 'error' });
  });

  it('does not toast twice when the write fails after the dialog', async () => {
    mocks.platform.isTauri = true;
    mocks.platform.isTauriMobile = true;
    mocks.platform.isTauriDesktop = false;
    mocks.writeFile.mockRejectedValue(new Error('EACCES'));
    const toasts: unknown[] = [];
    const onToast = (e: Event) => toasts.push((e as CustomEvent).detail);
    window.addEventListener('fe:mail-service-toast', onToast);

    await mailService.downloadAttachment(attachment as never, message as never);
    await flush();
    window.removeEventListener('fe:mail-service-toast', onToast);

    expect(toasts).toHaveLength(1);
  });
});
