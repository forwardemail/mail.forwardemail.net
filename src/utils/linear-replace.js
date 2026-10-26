/**
 * `str.replace(pattern, replacer)` for a pattern whose every match ends at the
 * first `terminator` after the match start (`<img[^>]*>`, `\/\*[\s\S]*?\*\/`,
 * `…[^)]*\)`). A start with no terminator after it can never match, yet the
 * engine still scans to the end of the string for each one, which is quadratic
 * on an email that repeats "<img" (or "/*", or "url(data:") without ever
 * closing it. Only the text up to the last terminator can hold a match, so the
 * tail is passed through untouched: same output, linear time.
 *
 * @param {string} str
 * @param {string} terminator - The literal every match ends with
 * @param {RegExp} pattern - A global pattern
 * @param {string|Function} replacer
 * @returns {string}
 */
export function replaceUpToLast(str, terminator, pattern, replacer) {
  const last = str.lastIndexOf(terminator);
  if (last === -1) return str;
  const end = last + terminator.length;
  return str.slice(0, end).replace(pattern, replacer) + str.slice(end);
}
