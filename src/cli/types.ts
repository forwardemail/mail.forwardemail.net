/**
 * The terminal client patches DOM objects (TermDOM's window, prototypes,
 * shadow roots) whose shapes TypeScript does not know, so it reads and
 * writes them as plain records.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type AnyRecord = Record<string | symbol, any>;
