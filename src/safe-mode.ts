// Entry for the troubleshooting page (safe-mode.html). See utils/safe-mode.ts.
import './styles/safe-mode.css';
import { clearSiteData } from './utils/clear-manifest';
import { buildSafeModeReport, countAccounts, reasonText, storedTheme } from './utils/safe-mode';
import { getLogPath, readRecentLogs } from './utils/tauri-bridge.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const theme = storedTheme(localStorage);
if (theme) document.documentElement.classList.add(theme);

const reason = new URLSearchParams(location.search).get('reason');
const intro = reasonText(reason);
if (intro) $('sm-reason').textContent = intro;

$('sm-open').addEventListener('click', () => {
  location.replace('/');
});

getLogPath()
  .then((path) => {
    if (path) $('sm-log-path').textContent = `Log files: ${path}`;
  })
  .catch(() => {});

const copyButton = $<HTMLButtonElement>('sm-copy');
copyButton.addEventListener('click', async () => {
  const status = $('sm-copy-status');
  const output = $<HTMLTextAreaElement>('sm-report');
  copyButton.disabled = true;
  status.textContent = 'Collecting…';
  try {
    const text = await buildSafeModeReport({
      reason,
      accounts: countAccounts(localStorage),
      readLogs: readRecentLogs,
    });
    output.value = text;
    output.hidden = false;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = 'Copied. Paste it into your email to support.';
    } catch {
      // The webview can refuse clipboard access after an await; the text is
      // shown selected so ⌘C / Ctrl+C still works.
      output.focus();
      output.select();
      status.textContent = 'Select the text below and copy it.';
    }
  } catch (err) {
    status.textContent = `Could not collect diagnostics: ${String(err)}`;
  } finally {
    copyButton.disabled = false;
  }
});

const confirmBox = $('sm-reset-confirm');
$('sm-reset').addEventListener('click', () => {
  confirmBox.hidden = false;
});
$('sm-reset-no').addEventListener('click', () => {
  confirmBox.hidden = true;
});
$<HTMLButtonElement>('sm-reset-yes').addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const status = $('sm-reset-status');
  button.disabled = true;
  status.textContent = 'Resetting…';
  try {
    await clearSiteData();
    location.replace('/');
  } catch (err) {
    button.disabled = false;
    status.textContent = `Reset failed: ${String(err)}`;
  }
});
