// Loading node:http is what makes Node 23+ install its own global undici
// dispatcher, so it goes first: an override set before that point gets
// clobbered by the lazy initialisation.
import 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';

/**
 * Keep webdriverio on its own undici 6 request path under Node 23+.
 *
 * Node's built-in undici exposes its global dispatcher to older undici copies
 * through a `Dispatcher1Wrapper` shim. webdriver's `getDispatcher()` treats
 * any global dispatcher whose class is not literally `Agent` as a
 * user-supplied proxy and routes every request through it instead of building
 * its own Agent. Crossing that shim rejects the Content-Length header
 * webdriver sets (`UND_ERR_INVALID_ARG: invalid content-length header`), so no
 * session can be created. Installing a plain undici 6 Agent restores the
 * Node 20/22 behaviour, including the long connectionRetryTimeout the specs
 * rely on while WebDriverAgent compiles on a cold iOS runner.
 *
 * Same fix as e2e-webview/setup/undici-dispatcher.ts. Both mobile nightlies
 * went red the day CI moved to Node 26 and stayed red until this landed.
 */
if (getGlobalDispatcher().constructor.name !== 'Agent') {
  setGlobalDispatcher(new Agent());
}
