import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const diagnostics = readFileSync(path.join(root, 'src/utils/diagnostics.ts'), 'utf8');
const index = readFileSync(path.join(root, 'index.html'), 'utf8');
const helperStart = index.indexOf('function isIgnorableCspViolation(e)');
const helperEnd = index.indexOf('function showFatal(detail)', helperStart);
const helper = index.slice(helperStart, helperEnd);

const probeUrl = 'https://example.invalid/csp-probe';

describe('diagnostics CSP overlay contract', () => {
  it('keeps the deliberate connect-src enforcement probe from covering the app', () => {
    expect(diagnostics).toContain(`const blocked = '${probeUrl}'`);
    expect(helperStart).toBeGreaterThan(-1);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(helper).toContain("e.effectiveDirective === 'connect-src'");
    expect(helper).toContain(`blocked === '${probeUrl}'`);
  });

  it('matches only the exact diagnostics probe instead of suppressing arbitrary CSP failures', () => {
    expect(helper).not.toContain("blocked.includes('example.invalid')");
    expect(helper).not.toContain("blocked.startsWith('https://example.invalid')");
    expect(helper).toContain('return false;');
  });
});
