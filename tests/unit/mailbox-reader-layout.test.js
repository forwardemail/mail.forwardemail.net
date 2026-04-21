import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const mailboxCss = fs.readFileSync(path.join(repoRoot, 'src/styles/pages/mailbox.css'), 'utf8');
const emailIframeCss = fs.readFileSync(
  path.join(repoRoot, 'src/styles/components/email-iframe.css'),
  'utf8',
);

describe('mailbox reader layout styles', () => {
  it('keeps horizontal overflow inside the email iframe instead of the outer reader pane', () => {
    expect(mailboxCss).toContain('.fe-reader {');
    expect(mailboxCss).toContain('overflow-x: hidden;');
    expect(mailboxCss).toContain('overflow-y: auto;');
  });

  it('uses the shared spacing token for email iframe container padding', () => {
    expect(emailIframeCss).toContain('.fe-email-iframe-container {');
    expect(emailIframeCss).toContain('padding: calc(var(--spacing, 0.25rem) * 5);');
    expect(emailIframeCss).not.toContain('padding: 20px;');
  });

  it('uses the shared spacing token for reader pane padding instead of hardcoded values', () => {
    expect(mailboxCss).toContain(
      'padding: calc(var(--spacing, 0.25rem) * 2.5) calc(var(--spacing, 0.25rem) * 5);',
    );
    expect(mailboxCss).not.toContain('padding: 10px 20px;');
  });
});
