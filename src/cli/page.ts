import indexHtml from '../../index.html?raw';
import fs from 'node:fs';
import path from 'node:path';
import terminalCss from './terminal.css?raw';
import { convertDeclarations, convertStylesheet } from './px-to-cells.js';

/**
 * The body of index.html, which holds every mount point main.ts looks up.
 * Scripts, links and meta tags are browser-only and are dropped, and so is
 * the animated starfield: its canvases have nothing to paint on in a
 * terminal, and without them createStarfield() does nothing.
 */
export function getPageMarkup(): string {
  // Comments first: the head's comments mention <script> and <style>.
  return indexHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '')
    .replace(/<div class="fe-stars">[\s\S]*?<\/div>/, '')
    .replace(/(\sstyle=)"([^"]*)"/g, (_m, attr, value) => `${attr}"${convertDeclarations(value)}"`);
}

/**
 * The webmail's own compiled stylesheet, followed by the terminal theme that
 * maps it onto a character grid, followed by the user's own overrides from
 * `user.css` in the data directory, if there is one.
 */
export function injectStyles(document: Document, dataDir: string) {
  let userCss = '';
  try {
    userCss = convertStylesheet(fs.readFileSync(path.join(dataDir, 'user.css'), 'utf8'));
  } catch {
    // no user stylesheet
  }
  const sheets: Array<[string, string]> = [
    ['fe-app-css', typeof __forwardemailAppCss === 'string' ? __forwardemailAppCss : ''],
    ['fe-terminal-css', terminalCss],
    ['fe-user-css', userCss],
  ];
  for (const [id, css] of sheets) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;
    document.head.append(style);
  }
}
