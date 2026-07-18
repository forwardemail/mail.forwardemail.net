import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAIN_PATH = path.resolve(process.cwd(), 'src/main.ts');
const MAILBOX_ACTIONS_PATH = path.resolve(process.cwd(), 'src/stores/mailboxActions.ts');
const SETTINGS_PATH = path.resolve(process.cwd(), 'src/svelte/Settings.svelte');

describe('mobile push registration lifecycle wiring', () => {
  let mainSource;
  let mailboxActionsSource;
  let settingsSource;

  beforeAll(async () => {
    [mainSource, mailboxActionsSource, settingsSource] = await Promise.all([
      readFile(MAIN_PATH, 'utf8'),
      readFile(MAILBOX_ACTIONS_PATH, 'utf8'),
      readFile(SETTINGS_PATH, 'utf8'),
    ]);
  });

  it('synchronizes after successful login credentials are stored', () => {
    expect(mainSource).toMatch(
      /onSuccess\(path = '\/mailbox'\) \{[\s\S]*?resetSessionState\?\.\(\);[\s\S]*?syncPushForActiveAccount\(\);[\s\S]*?viewModel\.navigate/,
    );
  });

  it('synchronizes on mobile cold start and every app resume', () => {
    const backgroundServiceStart = mainSource.indexOf(
      "import('./utils/background-service.js').then",
    );
    const serviceWorkerStart = mainSource.indexOf(
      'if (canUseServiceWorker() && import.meta.env.PROD)',
      backgroundServiceStart,
    );
    const nativeLifecycleBlock = mainSource.slice(backgroundServiceStart, serviceWorkerStart);

    expect(backgroundServiceStart).toBeGreaterThan(-1);
    expect(serviceWorkerStart).toBeGreaterThan(backgroundServiceStart);
    expect(nativeLifecycleBlock).toMatch(
      /onResume\(\(\) => \{[\s\S]*?syncPushForActiveAccount\(\);[\s\S]*?\}\);/,
    );
    expect(nativeLifecycleBlock.match(/syncPushForActiveAccount\(\);/g)).toHaveLength(2);
  });

  it('uses the authenticated synchronization guard after account switching', () => {
    expect(mailboxActionsSource).toContain(
      "const { syncPushNotifications } = await import('../utils/push-notifications.js');",
    );
    expect(mailboxActionsSource).toContain('await syncPushNotifications();');
    expect(mailboxActionsSource).not.toContain(
      "const { initPushNotifications } = await import('../utils/push-notifications.js');",
    );
  });

  it('mounts the cross-platform management surface and removes Android-only duplicate state', () => {
    expect(settingsSource).toContain(
      "import PushNotificationSettings from './components/PushNotificationSettings.svelte';",
    );
    expect(settingsSource).toContain('<PushNotificationSettings {toasts} {openExternal} />');
    expect(settingsSource).not.toContain('pushAndroidProvider');
    expect(settingsSource).not.toContain('refreshUnifiedPushState');
    expect(settingsSource).not.toContain('handleSelectUnifiedPushDistributor');
  });
});
