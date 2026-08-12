/**
 * Choosing a readable foreground for an arbitrary background.
 *
 * Label and calendar colours are picked by the user, so no design token can
 * guarantee a readable foreground over them. These chips previously hardcoded
 * white text, which is unreadable on a pale label: white on a light yellow
 * measures under 1.5:1.
 *
 * The threshold below is the standard WCAG crossover. Comparing the background's
 * relative luminance against 0.179 is equivalent to asking which of black or
 * white gives the better contrast ratio, and is cheaper than computing both.
 */

/** sRGB relative luminance, per WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const clean = hex.trim().replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  if (full.length < 6) return 0;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const linear = channels.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** Contrast ratio between two hex colours, per WCAG 2.x. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The readable foreground for a user-chosen background.
 *
 * Prefers Ink or the lightest neutral so a chip stays inside the palette, but
 * only when that choice actually clears AA. It does not: a threshold test on
 * luminance alone leaves mid-luminance backgrounds failing. Primary blue
 * (#2563eb) lands at 4.19:1 against the light neutral and the pink #d6336c at
 * 3.74:1, both under 4.5. So both candidates are measured and, if neither
 * passes, the choice falls back to pure black or white, which buys roughly one
 * extra point of ratio and rescues those cases.
 *
 * The user picks these colours, so maximising legibility beats staying on
 * palette when the two conflict.
 */
const AA_BODY_TEXT = 4.5;
const PALETTE_DARK = '#070b16'; /* --fe-ink */
const PALETTE_LIGHT = '#e2e8f0'; /* --fe-n-700 */

export function readableForeground(background: string | null | undefined): string {
  if (!background) return PALETTE_LIGHT;

  const best = (candidates: string[]) =>
    candidates.reduce((a, b) =>
      contrastRatio(b, background) > contrastRatio(a, background) ? b : a,
    );

  const onPalette = best([PALETTE_DARK, PALETTE_LIGHT]);
  if (contrastRatio(onPalette, background) >= AA_BODY_TEXT) return onPalette;

  return best(['#000000', '#ffffff']);
}
