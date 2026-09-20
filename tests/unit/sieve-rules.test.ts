/**
 * Filters compile to a Sieve script the backend runs at delivery time, so a
 * generator bug is not a UI glitch — it silently misfiles or drops real mail.
 * These tests assert the emitted source, not just that something was emitted.
 */
import { describe, expect, it } from 'vitest';
import {
  createRule,
  describeRule,
  escapeSieveString,
  isManagedScript,
  isRuleEmpty,
  requiredCapabilities,
  rulesToSieve,
  sieveToRules,
  type FilterRule,
} from '../../src/utils/sieve-rules';

const rule = (partial: Partial<FilterRule>): FilterRule => createRule(partial);

describe('escapeSieveString', () => {
  it('escapes the two characters a Sieve quoted string treats as special', () => {
    expect(escapeSieveString('a"b')).toBe('a\\"b');
    expect(escapeSieveString('a\\b')).toBe('a\\\\b');
  });

  it('escapes the backslash before the quote, not after', () => {
    // Getting this order wrong turns \" into \\" and shifts every later quote.
    expect(escapeSieveString('\\"')).toBe('\\\\\\"');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeSieveString('news@example.com')).toBe('news@example.com');
  });
});

describe('rulesToSieve', () => {
  it('emits a header test for a single condition', () => {
    const out = rulesToSieve([
      rule({
        name: 'Newsletters',
        conditions: [{ field: 'from', op: 'contains', value: 'news@example.com' }],
        actions: { fileinto: 'Newsletters' },
      }),
    ]);
    expect(out).toContain('if header :contains "from" "news@example.com" {');
    expect(out).toContain('fileinto :create "Newsletters";');
  });

  it('requires only the extensions the rules actually use', () => {
    const fileOnly = rulesToSieve([
      rule({
        conditions: [{ field: 'from', op: 'contains', value: 'a@b.com' }],
        actions: { fileinto: 'X' },
      }),
    ]);
    // :create is defined by the mailbox extension (RFC 5490), not by fileinto;
    // requiring only fileinto produces a script the engine rejects.
    expect(fileOnly).toContain('require ["fileinto", "mailbox"];');
    expect(fileOnly).not.toContain('imap4flags');

    const flagged = rulesToSieve([
      rule({
        conditions: [{ field: 'body', op: 'contains', value: 'invoice' }],
        actions: { star: true },
      }),
    ]);
    expect(flagged).toContain('require ["body", "imap4flags"];');
  });

  it('escapes the IMAP backslash flags the way a Sieve string needs', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'receipt' }],
        actions: { markRead: true, star: true },
      }),
    ]);
    // Two characters in the file: a literal backslash, then another, then Seen.
    expect(out).toContain('addflag ["\\\\Seen", "\\\\Flagged"];');
  });

  it('joins multiple conditions with allof or anyof per the match mode', () => {
    const conditions = [
      { field: 'from' as const, op: 'contains' as const, value: 'a@b.com' },
      { field: 'subject' as const, op: 'contains' as const, value: 'urgent' },
    ];
    const all = rulesToSieve([rule({ match: 'all', conditions, actions: { star: true } })]);
    expect(all).toContain('if allof (header :contains "from" "a@b.com", ');

    const any = rulesToSieve([rule({ match: 'any', conditions, actions: { star: true } })]);
    expect(any).toContain('if anyof (header :contains "from" "a@b.com", ');
  });

  it('negates a does-not-contain test rather than inventing an operator', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'subject', op: 'not_contains', value: 'spam' }],
        actions: { fileinto: 'Keep' },
      }),
    ]);
    expect(out).toContain('if not header :contains "subject" "spam" {');
  });

  it('uses :is for an exact match', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'from', op: 'is', value: 'a@b.com' }],
        actions: { star: true },
      }),
    ]);
    expect(out).toContain('header :is "from" "a@b.com"');
  });

  it('expands the "any" field across from, to and cc', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'any', op: 'contains', value: 'team@' }],
        actions: { star: true },
      }),
    ]);
    expect(out).toContain('header :contains ["from", "to", "cc"] "team@"');
  });

  it('tests the decoded body, not raw MIME, for a body condition', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'body', op: 'contains', value: 'unsubscribe' }],
        actions: { fileinto: 'Bulk' },
      }),
    ]);
    expect(out).toContain('body :text :contains "unsubscribe"');
  });

  it('stops after discarding so a later rule cannot resurrect the message', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'from', op: 'contains', value: 'spam@x.com' }],
        actions: { delete: true, fileinto: 'Somewhere' },
      }),
    ]);
    expect(out).toContain('discard;');
    expect(out).toContain('stop;');
    // A discarded message must not also be filed. The folder stays in the rule
    // JSON so unchecking delete restores it, but no fileinto is emitted — and
    // the unused extension must not be required either.
    expect(out).not.toContain('fileinto :create');
    expect(out).not.toContain('require');
  });

  it('escapes a quote in a user-typed value instead of breaking the string', () => {
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'subject', op: 'contains', value: 'say "hi"' }],
        actions: { star: true },
      }),
    ]);
    expect(out).toContain('"say \\"hi\\""');
  });

  it('renders a disabled rule as a comment, never as live code', () => {
    const out = rulesToSieve([
      rule({
        name: 'Paused',
        enabled: false,
        conditions: [{ field: 'from', op: 'contains', value: 'a@b.com' }],
        actions: { delete: true },
      }),
    ]);
    expect(out).toContain('# Paused (disabled)');
    expect(out).not.toContain('discard;');
  });

  it('skips a rule with a condition but no action', () => {
    const out = rulesToSieve([
      rule({ conditions: [{ field: 'from', op: 'contains', value: 'a@b.com' }], actions: {} }),
    ]);
    expect(out).not.toContain('if ');
  });

  it('skips a rule with an action but no condition, rather than matching everything', () => {
    // An unguarded `fileinto` would file the entire inbox away.
    const out = rulesToSieve([
      rule({
        conditions: [{ field: 'from', op: 'contains', value: '  ' }],
        actions: { delete: true },
      }),
    ]);
    expect(out).not.toContain('discard;');
  });

  it('produces a valid empty script when there are no rules', () => {
    const out = rulesToSieve([]);
    expect(out).toContain('# fe-filters-v1:[]');
    expect(out).not.toContain('if ');
  });
});

describe('sieveToRules round trip', () => {
  it('reads back exactly what it wrote', () => {
    const rules = [
      rule({
        name: 'Newsletters',
        match: 'any',
        conditions: [
          { field: 'from', op: 'contains', value: 'news@example.com' },
          { field: 'subject', op: 'contains', value: 'weekly' },
        ],
        actions: { fileinto: 'Newsletters', markRead: true, stop: true },
      }),
      rule({ name: 'Paused', enabled: false, actions: { star: true } }),
    ];
    expect(sieveToRules(rulesToSieve(rules))).toEqual(rules);
  });

  it('survives values containing quotes, backslashes and newlines', () => {
    const rules = [
      rule({
        name: 'Tricky "one"',
        conditions: [{ field: 'subject', op: 'contains', value: 'a"b\\c\nd' }],
        actions: { fileinto: 'Odd\\Folder' },
      }),
    ];
    const script = rulesToSieve(rules);
    // The metadata must stay on one line or the comment terminates early.
    const metaLines = script.split('\n').filter((l) => l.includes('fe-filters-v1'));
    expect(metaLines).toHaveLength(1);
    expect(sieveToRules(script)).toEqual(rules);
  });

  it('returns null for a script written somewhere else', () => {
    const foreign = 'require ["fileinto"];\nif header :contains "from" "x" {\n fileinto "Y";\n}\n';
    expect(sieveToRules(foreign)).toBeNull();
    expect(isManagedScript(foreign)).toBe(false);
  });

  it('returns null rather than guessing when the marker is corrupted', () => {
    // Refusing to parse is what stops the builder overwriting a script whose
    // rules it cannot actually reproduce.
    expect(sieveToRules('# fe-filters-v1:{not json\nrequire ["fileinto"];')).toBeNull();
  });

  it('recognizes its own empty script as managed', () => {
    expect(isManagedScript(rulesToSieve([]))).toBe(true);
  });
});

describe('isRuleEmpty', () => {
  it('treats a rule with no usable condition or no action as empty', () => {
    expect(isRuleEmpty(rule({ actions: { star: true } }))).toBe(true);
    expect(isRuleEmpty(rule({ conditions: [{ field: 'from', op: 'contains', value: 'a' }] }))).toBe(
      true,
    );
    expect(
      isRuleEmpty(
        rule({
          conditions: [{ field: 'from', op: 'contains', value: 'a' }],
          actions: { star: true },
        }),
      ),
    ).toBe(false);
  });
});

describe('requiredCapabilities', () => {
  it('ignores disabled rules, which emit no code', () => {
    expect(
      requiredCapabilities([
        rule({
          enabled: false,
          conditions: [{ field: 'body', op: 'contains', value: 'x' }],
          actions: { fileinto: 'Y' },
        }),
      ]),
    ).toEqual([]);
  });
});

describe('describeRule', () => {
  it('summarizes conditions and actions in plain language', () => {
    const summary = describeRule(
      rule({
        match: 'any',
        conditions: [
          { field: 'from', op: 'contains', value: 'a@b.com' },
          { field: 'subject', op: 'is', value: 'Hi' },
        ],
        actions: { fileinto: 'Work', markRead: true },
      }),
    );
    expect(summary).toBe(
      'From contains "a@b.com" or Subject is exactly "Hi" → move to Work, mark read',
    );
  });
});
