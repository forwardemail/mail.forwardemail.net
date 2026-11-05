import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';

vi.mock('../../src/utils/platform.js', () => ({ isTauri: true, isTauriMobile: true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));

const repoRoot = path.resolve(import.meta.dirname, '../..');
const capabilityDir = path.join(repoRoot, 'src-tauri/capabilities');

// Every permission a platform's capabilities grant to the main window.
function grantedOn(platform) {
  const granted = new Set();
  for (const file of fs.readdirSync(capabilityDir).filter((name) => name.endsWith('.json'))) {
    const capability = JSON.parse(fs.readFileSync(path.join(capabilityDir, file), 'utf8'));
    if (!capability.platforms.includes(platform) || !capability.windows.includes('main')) continue;
    for (const entry of capability.permissions) {
      granted.add(typeof entry === 'string' ? entry : entry.identifier);
    }
  }
  return granted;
}

// `plugin:notification|register_listener` needs `notification:allow-register-listener`
// (or the plugin's default set).
function isAllowed(granted, cmd) {
  const [, plugin, command] = cmd.match(/^plugin:([^|]+)\|(.+)$/);
  return (
    granted.has(`${plugin}:default`) || granted.has(`${plugin}:allow-${command.replace(/_/g, '-')}`)
  );
}

describe('notification capability on mobile', () => {
  afterEach(() => {
    clearMocks();
    vi.resetModules();
  });

  for (const platform of ['android', 'iOS']) {
    it(`grants every notification plugin command the bridge invokes on ${platform}`, async () => {
      const granted = grantedOn(platform);
      const invoked = new Set();
      // Like the runtime ACL: a command without a permission is refused.
      mockIPC((cmd) => {
        if (!cmd.startsWith('plugin:notification|')) return null;
        invoked.add(cmd);
        if (!isAllowed(granted, cmd)) throw new Error(`${cmd} not allowed`);
        return cmd.endsWith('is_permission_granted') ? true : null;
      });

      const bridge = await import('../../src/utils/notification-bridge.js');
      await bridge.initTauriNotificationClickHandler();
      await bridge.getPermissionState();
      await bridge.requestPermission();

      // The tap listener is what lets a tapped notification open its message.
      expect(invoked).toContain('plugin:notification|register_listener');
      expect([...invoked].filter((cmd) => !isAllowed(granted, cmd))).toEqual([]);
    });
  }
});
