/** Virtual pixels per terminal column and per row. */
export const PX_PER_COLUMN: number;
export const PX_PER_ROW: number;
/** A length in virtual pixels as whole cells along an axis. */
export function pxToCells(px: number, axis: 'h' | 'v' | 'border'): number;
/** A stylesheet with its lengths and media queries in cells. */
export function convertStylesheet(css: string): string;
/** An inline style declaration list with its lengths in cells. */
export function convertDeclarations(text: string): string;
/** A media query condition with its lengths in cells. */
export function convertMediaQuery(query: string): string;
