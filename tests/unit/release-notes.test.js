// @vitest-environment node
import {
  FALLBACK_NOTE,
  applyChangelogSection,
  applyMetainfoRelease,
  buildNotes,
  cleanText,
  notesFromCommit,
  parseChangelogSection,
  renderMarkdown,
  renderStoreText,
} from '../../scripts/release-notes.mjs';

describe('notesFromCommit', () => {
  it('uses feat and fix subjects and skips housekeeping commits', () => {
    expect(notesFromCommit({ subject: 'feat: contacts editing and search bar UX' })).toEqual([
      { section: 'features', text: 'Contacts editing and search bar UX', platforms: [] },
    ]);
    expect(notesFromCommit({ subject: 'chore(release): 0.14.30' })).toEqual([]);
    expect(notesFromCommit({ subject: 'docs: refresh release screenshots [skip ci]' })).toEqual([]);
    expect(notesFromCommit({ subject: 'refactor: split mailbox store' })).toEqual([]);
    expect(notesFromCommit({ subject: 'Merge branch main' })).toEqual([]);
  });

  it('splits a subject that lists several changes', () => {
    const notes = notesFromCommit({
      subject: 'fix: iOS freeze and watchdog kill on plugin calls; terminal contacts scroll',
    });
    expect(notes.map((n) => n.text)).toEqual([
      'iOS freeze and watchdog kill on plugin calls',
      'Terminal contacts scroll',
    ]);
  });

  it('limits a platform-scoped subject to that platform but not a feature scope', () => {
    expect(notesFromCommit({ subject: 'fix(ios): stop reloads on taps' })[0].platforms).toEqual([
      'ios',
    ]);
    expect(notesFromCommit({ subject: 'fix(mobile): keyboard overlap' })[0].platforms).toEqual([
      'android',
      'ios',
    ]);
    expect(notesFromCommit({ subject: 'fix(calendar): all-day span' })[0].platforms).toEqual([]);
  });

  it('prefers Release-note lines over the subject, including on non-feature commits', () => {
    const body = [
      'Longer explanation for reviewers.',
      '',
      'Release-note: Conversations stay together on mobile, matching Thunderbird.',
      'Release-note(ios, android): Replies sent from your phone show as answered everywhere',
    ].join('\n');
    expect(notesFromCommit({ subject: 'fix: thread on server thread_id', body })).toEqual([
      {
        section: 'fixes',
        text: 'Conversations stay together on mobile, matching Thunderbird',
        platforms: [],
      },
      {
        section: 'fixes',
        text: 'Replies sent from your phone show as answered everywhere',
        platforms: ['android', 'ios'],
      },
    ]);
    expect(
      notesFromCommit({
        subject: 'chore: bump tao',
        body: 'Release-note: Fixes a crash on launch',
      }),
    ).toHaveLength(1);
  });

  it('hides a commit marked Release-note: none', () => {
    expect(
      notesFromCommit({ subject: 'fix: typo in log line', body: 'Release-note: none' }),
    ).toEqual([]);
  });
});

describe('cleanText', () => {
  it('capitalizes plain words but keeps brand casing', () => {
    expect(cleanText('stop reloads.')).toBe('Stop reloads');
    expect(cleanText('iOS freeze')).toBe('iOS freeze');
    expect(cleanText('unifiedPush register')).toBe('unifiedPush register');
  });
});

describe('buildNotes', () => {
  it('drops a commit and its revert, and duplicate notes', () => {
    const notes = buildNotes([
      { hash: 'aaaaaaa111', subject: 'feat: new sidebar' },
      { hash: 'bbbbbbb222', subject: 'fix: crash on send' },
      { hash: 'ccccccc333', subject: 'fix: crash on send' },
      {
        hash: 'ddddddd444',
        subject: 'Revert "feat: new sidebar"',
        body: 'This reverts commit aaaaaaa111.',
      },
    ]);
    expect(notes).toEqual({ features: [], fixes: [{ text: 'Crash on send', platforms: [] }] });
  });
});

describe('changelog round trip', () => {
  const notes = {
    features: [{ text: 'Send from any address on a domain', platforms: [] }],
    fixes: [
      { text: 'Stop reloads on taps', platforms: ['ios'] },
      { text: 'Watchdog reload on a blank window', platforms: ['macos'] },
    ],
  };

  it('reads back exactly what it wrote, platforms included', () => {
    const changelog = applyChangelogSection(
      '',
      '1.2.3',
      renderMarkdown('1.2.3', '2026-10-11', notes),
    );
    expect(changelog).toContain('- Stop reloads on taps _(iOS)_');
    expect(parseChangelogSection(changelog, '1.2.3')).toEqual(notes);
    expect(parseChangelogSection(changelog, '1.2.4')).toBeNull();
  });

  it('puts the newest version first and replaces a re-run of the same version', () => {
    let changelog = applyChangelogSection('', '1.0.0', renderMarkdown('1.0.0', 'd1', notes));
    changelog = applyChangelogSection(changelog, '1.0.1', renderMarkdown('1.0.1', 'd2', notes));
    changelog = applyChangelogSection(
      changelog,
      '1.0.1',
      renderMarkdown('1.0.1', 'd3', { features: [], fixes: [] }),
    );
    const headings = changelog.match(/^## .+$/gm);
    expect(headings).toEqual(['## 1.0.1 (d3)', '## 1.0.0 (d1)']);
    expect(parseChangelogSection(changelog, '1.0.1')).toEqual({ features: [], fixes: [] });
  });
});

describe('renderStoreText', () => {
  it('falls back to a generic line when nothing is user facing', () => {
    expect(renderStoreText({ features: [], fixes: [] })).toBe(FALLBACK_NOTE);
  });

  it('stays within the limit and says more was left out', () => {
    const fixes = Array.from({ length: 30 }, (_, i) => ({
      text: `Fix number ${i} for something users noticed`,
      platforms: [],
    }));
    const text = renderStoreText({ features: [], fixes }, { limit: 500 });
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text.startsWith('Fixes:\n• Fix number 0')).toBe(true);
    expect(text.endsWith('…and more.')).toBe(true);
  });

  it('cuts a single note longer than the whole limit instead of returning nothing', () => {
    const text = renderStoreText(
      { features: [{ text: 'x'.repeat(600), platforms: [] }], fixes: [] },
      { limit: 500 },
    );
    expect(text.length).toBeLessThanOrEqual(500);
    expect(text).toMatch(/^New:\n• x+…\n…and more\.$/);
  });
});

describe('applyMetainfoRelease', () => {
  const metainfo = [
    '<component>',
    '  <releases>',
    '    <release version="1.0.1" date="2026-10-11"/>',
    '    <release version="1.0.0" date="2026-10-01"/>',
    '  </releases>',
    '</component>',
    '',
  ].join('\n');
  const notes = {
    features: [{ text: 'Filters & rules <beta>', platforms: [] }],
    fixes: [{ text: 'Stop reloads on taps', platforms: ['ios'] }],
  };

  it('adds an escaped description for Linux and keeps the release date', () => {
    const out = applyMetainfoRelease(metainfo, '1.0.1', notes, 'ignored');
    expect(out).toContain('<release version="1.0.1" date="2026-10-11">');
    expect(out).toContain('<li>Filters &amp; rules &lt;beta&gt;</li>');
    expect(out).not.toContain('Stop reloads on taps');
    expect(out).toContain('<release version="1.0.0" date="2026-10-01"/>');
  });

  it('is stable when run twice', () => {
    const once = applyMetainfoRelease(metainfo, '1.0.1', notes, 'x');
    expect(applyMetainfoRelease(once, '1.0.1', notes, 'x')).toBe(once);
  });

  it('adds the release when sync-version has not listed it yet', () => {
    const out = applyMetainfoRelease(metainfo, '1.0.2', notes, '2026-10-12');
    expect(out.indexOf('version="1.0.2" date="2026-10-12"')).toBeLessThan(
      out.indexOf('version="1.0.1"'),
    );
  });
});
