import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MAIN_PATH = path.resolve(process.cwd(), 'src/main.ts');
const SETTINGS_PATH = path.resolve(process.cwd(), 'src/svelte/Settings.svelte');

describe('mobile push registration lifecycle wiring', () => {
  let mainSource;
  let settingsSource;

  beforeAll(async () => {
    [mainSource, settingsSource] = await Promise.all([
      readFile(MAIN_PATH, 'utf8'),
      readFile(SETTINGS_PATH, 'utf8'),
    ]);
  });

  it('synchronizes after successful login credentials are stored', () => {
    expect(mainSource).toMatch(
      /onSuccess\(path = '\/mailbox'\) \{[\s\S]*?resetSessionState\?\.\(\);[\s\S]*?syncPushAfterSignIn\(\);[\s\S]*?viewModel\.navigate/,
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
    // The cold start sync must stay deferred past page load. Invoking a mobile
    // plugin command while wry's native onPageLoaded callback is still on the
    // main thread can deadlock the runtime plugin mutex and ANR on Android.
    expect(nativeLifecycleBlock).toMatch(
      /const schedulePushSync = \(\) => setTimeout\(syncPushForActiveAccount, \d+\);/,
    );
    expect(nativeLifecycleBlock).toMatch(
      /document\.readyState === 'complete'[\s\S]*?schedulePushSync\(\);[\s\S]*?addEventListener\('load', schedulePushSync, \{ once: true \}\);/,
    );
    // Exactly one immediate invocation, and it lives inside onResume. The cold
    // start path only schedules; a second bare call would reintroduce the race.
    expect(nativeLifecycleBlock.match(/syncPushForActiveAccount\(\);/g)).toHaveLength(1);
  });

  // Account switching: covered by behaviour in mailbox-actions.test.ts
  // ('switchAccount and push registration').

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
