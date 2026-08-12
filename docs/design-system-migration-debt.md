# Design system migration: debt and dead code

Running log from the Forward Email design system migration. Steps 1 and 2 of the
specification's migration order say to log inconsistencies the token codemod
surfaces rather than silently normalising them. This is that log.

Status key: **open** needs doing, **deferred** deliberately scheduled for a later
phase, **intentional** looks like debt but is correct.

Phases referenced here: P1/P2 token layer and palette flip (done), P3 debt
codemod in Svelte components (done), P4 standalone CSS files, P5 primitives,
P6 mail components, P7 density, P8 accessibility.

---

## Dead code

P4 removed the bulk of this. A liveness audit of every `fe-*` class in the
standalone stylesheets found that most of them were never applied to an element.

One trap worth recording, because the first pass got it wrong: a hyphen is a
non-word character, so a `\bfe-message\b` regex matches the _prefix_ of
`fe-message-list-wrapper` and reports a dead class as live. Liveness checks on
hyphenated class names need `(?![-\w])`, not `\b`. That error only ever kept
extra rules, so nothing was deleted wrongly, but it hid 8 dead classes on the
first pass.

Equally important: the check must look at markup and scripts only. A class
referenced solely by another stylesheet is still never applied. Four
`.fe-message-*` rules in `base.css` looked live purely because `mailbox.css`
also styled them.

### Resolved in P4

| File                          | Before | After | What went                                                                                                                             |
| ----------------------------- | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pages/mailbox.css`           | 1158   | 401   | 66 of 78 `fe-*` classes were dead. 114 rules dropped, all 75 hardcoded values gone.                                                   |
| `components/email-iframe.css` | 124    | 29    | The entire appearance-toggle and dropdown block, plus its dark and light override sections. No markup had applied those four classes. |
| `components/bottom-sheet.css` | 278    | 224   | An 11-rule light-mode block that only restated the same token names with different literal fallbacks.                                 |
| `base.css`                    | 293    | 285   | Mobile typography rules for `.fe-message-subject` / `-from` / `-snippet` / `-date` and `.fe-folder`.                                  |

The storage and progress bar CSS, and the `--color-border-strong` token that
never existed, were both inside pruned rules and are gone with them.

There are now **no hardcoded colour values in any consuming stylesheet**. The
only literals left in `src/styles/` are inside token definitions, which is where
they belong, plus the `@media print` block, which deliberately pins absolute
black and white.

### Still open

**`MessageRow.svelte`** is dead code, superseded by the rows inlined in
`Mailbox.svelte`. P6 extracts a single row component; delete this then rather
than migrate it.

**`.fe-pagination`** has no markup applying it, but `Mailbox.svelte` still
carries a `:global(… .fe-pagination)` rule, so `mailbox.css` keeps its
declaration. Remove both together.

**`var(--spacing, 0.25rem)`** fallbacks in `mailbox.css` and `email-iframe.css`
are unreachable: Tailwind emits `--spacing: .25rem`. They are load-bearing for a
test that asserts the exact string, so removing them means updating
`tests/unit/mailbox-reader-layout.test.js` in the same change. Low value.

---

## Contrast and accessibility

### `text-primary` as text on dark — resolved in P8

34 occurrences, not the ~50 first counted: the earlier figure came from a
`\btext-primary\b` regex, which matches the prefix of `text-primary-foreground`
because a hyphen is a non-word character. The same trap as the class liveness
audit. All 34 genuine foreground uses now resolve through `text-fg-link`, which
is identical to before in light mode and 7.10:1 instead of 3.49:1 on dark.

### Label chips force white text over user-chosen colours — resolved in P8

`src/utils/contrast.ts` now picks the foreground by measurement. Worth knowing
why it is not a simple luminance threshold: a threshold test still fails for
mid-luminance backgrounds, because the in-palette neutrals give only 4.19:1 on
Primary blue and 3.74:1 on the pink `#d6336c`. The helper measures both palette
candidates and escalates to pure black or white when neither clears AA, which
buys about one extra point of ratio. A test sweeps the label and calendar
palettes and asserts every choice clears 4.5:1.

### `--fg-muted` is not a body-text colour — intentional, documented

Measures 4.48:1 on the light canvas and 3.79:1 on the dark canvas, so it fails
AA for body text in both themes. This is why the shadcn bridge maps
`--muted-foreground` to `--fg-secondary` instead. `--fg-muted` is for
timestamps, counts and disabled text. Noted in `fe-tokens.css`.

### `--fe-danger-deep` misses AA on the sunken surface — open, low priority

The specification presents `#dc2626` as the light-safe danger colour. It
measures 4.54:1 on the canvas and 4.83:1 on raised surfaces, but 4.22:1 on
`--surface-sunken`. Danger text inside a sunken well is rare, and changing the
value would ripple through `--destructive` and its 60-plus uses, so it is left
as specified.

### Diagnostics ground — fixed in P3

`/mailbox/diagnostics` is not part of `mailbox-mode`, so it inherited the login
screen's Ink ground. With light-theme tokens on that dark ground, state text
measured 2.77:1 and body text 1.09:1. `#diagnostics-root` now paints
`--surface-canvas`. `overflow-y` was added at the same time, which also fixed
the page being clipped by the login shell's vertical centering.

---

## Specification gaps found

### Caution had no light-safe variant — resolved

The specification defines `-deep` variants for Signal and Mint but not for
Caution, and `--fe-caution` (`#f59e0b`) measures 2.02:1 on the light canvas, so
it cannot be text there. Added `--fe-caution-deep`. It is amber-800
(`#92400e`), not amber-700, because amber-700 measures 4.39:1 against
`--surface-sunken` and misses AA on that one surface.

### No token for a starred message — resolved

Added `--state-starred`, aliased to Caution's hue rather than introducing a new
accent, since the specification caps accent count and gold is the conventional
star colour.

### Categorical colour is out of scope for the token layer — intentional

Three palettes are deliberately literal because their job is to distinguish
items, not to carry brand meaning. This is the same role `--chart-*` plays.
Each is commented at its definition.

- `Contacts.svelte` — 12 avatar colours
- `Calendar.svelte` — 6 calendar identity colours
- `Compose.svelte` — editor text and highlight colours. These are serialised
  into outgoing email HTML, which the recipient's client renders with no access
  to this app's tokens, so they must be literal.

`LabelModal.svelte` keeps a literal white contrast ring over user-chosen swatch
colours: the underlying colour is arbitrary, so no theme token can guarantee
separation from it.

---

## Deferred to later phases

### `mailbox.css` — resolved in P4, and it was not what it looked like

This was logged as the largest remaining visual clash, on the reading that
`.fe-nav-toggle` and `.fe-reader-backbtn` were painting grey buttons against the
navy shell. That was wrong. Both classes are dead, so none of those values ever
rendered; the visible hamburger and back buttons are built from Tailwind
utilities in `Mailbox.svelte` and were already correct. The same applied to the
`body.light-mode` block: almost all of it targeted dead classes.

The lesson is to check that a selector is live before reading a hardcoded value
inside it as a rendering bug.

### Encryption uses the wrong state colour — resolved in P6

Both PGP banners and their passphrase actions now use `--state-encrypted`, with
a lock icon carrying `aria-label` and the block marked `role="status"`. There
were two banner blocks, not one; the second differed only in indentation and was
easy to miss.

### Unread rows do not use `--state-unread` — resolved in P6

The state gutter is a `::before` on `[data-conversation-row]`, painted when
`data-unread="true"`. The flat message row was not exposing `data-unread` at
all, so it had to be added before the rule had anything to key on. A regression
guard now asserts that the count of row containers and the count of
`data-unread` attributes match, so a new row variant cannot silently ship
without the third cue.

### Two different warnings now look identical — accepted

`MessageTab.svelte` had a yellow banner for blocked images and an orange one for
a security warning; both are `--state-caution` now. The specification has one
caution hue, and each banner keeps a distinct icon and message, which satisfies
the rule that state must be legible without colour.

### Calendar today-circle hue changed — done, worth knowing

The date-picker today circle was violet in both themes. Violet is
`--state-encrypted` in this system and would misread as an encryption cue, so
today now takes the primary accent.

### schedule-x light theme is only partly themed — P4 or later

The `--sx-color-*` surface overrides are still scoped to `.sx-wrapper.is-dark`,
matching previous behaviour, so light-mode schedule-x still uses its own default
surfaces. The values are tokens now, but light mode is not driven by them.

---

## Unrelated pre-existing issues

### `tailwind.config.js` is inert — open

Tailwind v4 with no `@config` directive anywhere, so the file is never loaded.
Its custom breakpoints never applied, meaning the roughly 59 `md:` utilities
have always resolved at Tailwind's default 768px rather than the intended 820px.
Wiring it up would shift layout between 768px and 820px, so it needs its own
change. Deleting the file is the safer option.

### `svelte-check` baseline — open

Around 2058 pre-existing errors, so it cannot gate this work. Verification is
vitest, eslint, prettier, a production build, and screenshot comparison.

---

## Phases 5 to 8

### What landed

**P5.** JetBrains Mono bundled through `@fontsource-variable` (CSP allows
`font-src 'self' data:` only, so a CDN was never an option). Loaded eagerly
rather than through `font-loader.js`, because `--type-label` is the system's
most-used element and a swap after first paint would flash across the whole UI;
`wght.css` skips the italic set and `unicode-range` means only the Latin file is
fetched. Three signature type classes in `components/typography.css`. A
`MonoLabel` primitive, named that way because shadcn already ships an unrelated
form-control `Label` in the same directory and a colliding import would resolve
to the wrong component silently. A `subtle` button variant, semantic state
variants on `Badge` with an opt-in `mono` treatment, sunken input fill, and
`--elev-inset` on dark cards.

**P6.** `StatusLog` and `StatusLine` with the specification's glyph vocabulary,
landed in `Diagnostics.svelte`. An inverse `Panel` implemented as
`data-surface="inverse"`, which redefines both the semantic tokens and the
shadcn bridge names. Both sets are needed: the bridge names are declared on
`:root`, so their values are already substituted by the time a descendant
redefines a token they point at, and redefining `--surface-canvas` alone would
not move `--background`. Nesting is neutralised in CSS and warned about in dev.

**P7.** `data-density` on `<html>` from a new `list_density` setting.

**P8.** Focus rings at every viewport width, ARIA roles on both lists, and the
two contrast fixes above.

### Deviations and limits, with reasons

**Density does not reach 44px.** Specification §2.6 gives compact rows a 44px
height. Measured, rows are 79px compact and 87px comfortable: `min-height` is
not the binding constraint because the row renders sender, subject and preview
on three lines, and that content is taller than 44px. Only the `--row-pad-y`
difference shows. Reaching 44px means collapsing the row to a single line, which
changes what information the list shows. That is a product decision and outside
the "keep the layout intact" scope this work was given, so the setting currently
controls padding rather than height.

**`j`/`k` are not bound to list navigation.** Specification §6 asks for j/k, a
Gmail convention. This app follows Thunderbird: `j` is mark-junk and `shift+j`
is mark-not-junk. Arrow up and down already navigate the list, so the
accessibility requirement is met; rebinding `j` would break an established
shortcut to satisfy a stylistic preference.

**The folder tree is not a full tree widget.** It reports `role="tree"`,
`role="treeitem"`, `aria-selected`, `aria-expanded` and `aria-level` accurately,
and the inner buttons remain focusable and operable. It does not implement
roving tabindex with arrow-key traversal, which is a keyboard-navigation feature
rather than a styling one.

**`Badge`'s mono treatment is opt-in.** Specification §4.2 puts `--type-label`
on every chip. Existing badges carry sentence-case content such as email
addresses and recipient names, where uppercase monospace costs more legibility
than it buys brand, so `mono` is a prop. Use it for fixed vocabularies.

**New mail has no dedicated live region.** Send status is announced through the
toast region. New mail relies on the existing sync-status `role="status"` region
rather than a purpose-built announcement.

### Still open

- **`.fe-pagination`** and the `var(--spacing, 0.25rem)` fallbacks, both
  unchanged and both noted above.
- **RouteStepper (§3.2) and the rules components (§5.4 to §5.6)** remain
  deferred: the product surfaces they describe do not exist in this client.
- **Alias chips in the message row (§5.1)** are not implemented. The
  specification calls the receiving alias a first-class element when it differs
  from the account's primary address; the row currently has no such chip.
