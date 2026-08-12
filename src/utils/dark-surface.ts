/**
 * Surface palettes for injected / standalone HTML.
 *
 * The email reader iframe (a sandboxed `srcdoc`), the "PGP detected" dialog, and
 * the raw-source viewer (a blob page) all render outside the app's stylesheet
 * scope, so they CANNOT read the app's CSS custom properties. These constants
 * MIRROR the semantic tokens in `src/styles/fe-tokens.css` so those surfaces
 * stay consistent with the rest of the app.
 *
 * This is also the native/JSON export the design system calls for: it is the
 * one place a non-CSS consumer can read resolved token values.
 *
 * Keep it in sync with fe-tokens.css. Values below are the resolved hex of the
 * token named in each comment; do not invent values that are not on the ramp.
 */

/** Dark theme. Mirrors the `.dark` block in fe-tokens.css. */
export const DARK_SURFACE = {
  /** Sunken wells and code blocks — `--surface-sunken` (`--fe-ink`) */
  base: '#070b16',
  /** Page canvas — `--surface-canvas` (`--fe-panel`) */
  surface: '#0e1628',
  /** Panels / cards / the reader pane — `--surface-raised` (`--fe-n-200`) */
  panel: '#16223a',
  /** Elevated surfaces: modals, chips, buttons — `--surface-overlay` steps up
   *  to `--fe-n-300` here, matching what `--accent` / `--muted` resolve to in
   *  the app, so a chip still reads as raised against `panel`. */
  overlay: '#22304d',
  /** Default border — `--border-default` (`--fe-n-300`) */
  border: '#22304d',
  /** Stronger border, and the hover step above `overlay` — `--border-strong`
   *  (`--fe-n-400`) */
  borderStrong: '#3a4a6b',
  /** Primary text — `--fg-primary` (`--fe-n-700`) */
  text: '#e2e8f0',
  /** Muted / secondary text — `--fg-secondary` (`--fe-n-600`). Deliberately
   *  not `--fg-muted` (`--fe-n-500`), which measures about 3.2:1 against
   *  `panel` and fails AA for the quoted body text this is used on. */
  textMuted: '#94a3b8',
  /** Secondary text that still has to read as body copy, and the hover
   *  brightening of `textMuted`. Shares a value with `text` because the dark
   *  neutral ramp has no step between `--fe-n-600` and `--fe-n-700`. */
  textSubtle: '#e2e8f0',
  /** Link text — `--fg-link` (`--fe-primary-lift`) */
  link: '#60a5fa',
} as const;

/** Light theme. Mirrors the `:root` block in fe-tokens.css. */
export const LIGHT_SURFACE = {
  /** Sunken wells and code blocks — `--surface-sunken` (`--fe-l-200`) */
  base: '#ebf0f9',
  /** Page canvas — `--surface-canvas` (`--fe-l-100`) */
  surface: '#f5f8ff',
  /** Panels / cards / the reader pane — `--surface-raised` (`--fe-l-000`) */
  panel: '#ffffff',
  /** Elevated surfaces: modals, chips, buttons — `--surface-overlay` */
  overlay: '#ffffff',
  /** Default border — `--border-default` (`--fe-l-300`) */
  border: '#d9e1ee',
  /** Stronger border — `--border-strong` (`--fe-l-400`) */
  borderStrong: '#b4c0d4',
  /** Primary text — `--fg-primary` (`--fe-l-700`) */
  text: '#0e1628',
  /** Muted / secondary text — `--fg-secondary` (`--fe-l-600`) */
  textMuted: '#3a4a6b',
  /** Secondary body text — `--fg-secondary` (`--fe-l-600`) */
  textSubtle: '#3a4a6b',
  /** Link text — `--fg-link` (`--fe-primary`) */
  link: '#2563eb',
} as const;
