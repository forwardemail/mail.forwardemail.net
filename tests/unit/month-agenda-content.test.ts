import { describe, it, expect } from 'vitest';
import { buildMonthAgendaContent, monthAgendaTimeText } from '../../src/utils/month-agenda-content';

describe('monthAgendaTimeText', () => {
  it('single-day timed: date, a plain separator, then the time range', () => {
    // The library's own version returns an HTML span here, which the agenda
    // view rendered as literal text on phones.
    const text = monthAgendaTimeText('2026-09-09 08:00', '2026-09-09 09:00');
    expect(text).toBe('September 9, 2026 ⋅ 8:00 AM – 9:00 AM');
    expect(text).not.toContain('<');
  });
  it('single all-day: just the date', () => {
    expect(monthAgendaTimeText('2026-09-09', '2026-09-10')).toBe(
      'September 9, 2026 – September 10, 2026',
    );
    expect(monthAgendaTimeText('2026-09-09', '2026-09-09')).toBe('September 9, 2026');
  });
  it('multi-day timed: date and time on both ends', () => {
    expect(monthAgendaTimeText('2026-09-09 22:00', '2026-09-10 01:00')).toBe(
      'September 9, 2026, 10:00 PM – September 10, 2026, 1:00 AM',
    );
  });
  it('is empty for garbage', () => {
    expect(monthAgendaTimeText('', '')).toBe('');
    expect(monthAgendaTimeText('nope', 'nope')).toBe('');
  });
});

describe('buildMonthAgendaContent', () => {
  it('escapes the title so event text can never inject markup', () => {
    const html = buildMonthAgendaContent({
      title: '<img src=x onerror=alert(1)> & "quotes"',
      start: '2026-09-09 08:00',
      end: '2026-09-09 09:00',
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;');
  });
  it('uses the library class names so the theme styles apply', () => {
    const html = buildMonthAgendaContent({
      title: 'Standup',
      start: '2026-09-09',
      end: '2026-09-09',
    });
    expect(html).toContain('class="sx__month-agenda-event__title">Standup<');
    expect(html).toContain('sx__month-agenda-event__time');
    expect(html).toContain('September 9, 2026');
  });
  it('falls back to a generic title', () => {
    expect(
      buildMonthAgendaContent({ title: '', start: '2026-09-09', end: '2026-09-09' }),
    ).toContain('>Event<');
  });
});
