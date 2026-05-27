import { currentPath } from './state.js';

export async function activateDemo(browser: WebdriverIO.Browser): Promise<void> {
  const tryDemo = await browser.$('[data-testid="try-demo-btn"]');
  // Wait for the button to exist, then scroll it into the viewport before
  // checking clickability. On smaller webdriver windows (observed on
  // macOS-arm64 CI runners) the demo button sits below the Stay-signed-in
  // checkbox and is outside the viewport at default scroll position, which
  // makes waitForClickable time out with "still not clickable after
  // 10000ms". scrollIntoView is a no-op when the element is already
  // visible, so this is safe on every platform.
  await tryDemo.waitForExist({ timeout: 15_000 });
  await tryDemo.scrollIntoView({ block: 'center' });
  await tryDemo.waitForClickable({ timeout: 15_000 });
  await tryDemo.click();
  await browser.waitUntil(async () => (await currentPath(browser)).startsWith('/mailbox'), {
    timeout: 15_000,
    timeoutMsg: 'expected navigation to /mailbox after Try Demo',
  });
  const shell = await browser.$('[data-testid="mailbox-shell"]');
  await shell.waitForDisplayed({ timeout: 15_000 });
}
