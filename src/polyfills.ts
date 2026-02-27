// Polyfills for older WebViews (Android API 30 / Chrome <85–98)

if (typeof globalThis.structuredClone === 'undefined') {
  (globalThis as Record<string, unknown>).structuredClone = (obj: unknown) =>
    JSON.parse(JSON.stringify(obj));
}

if (typeof String.prototype.replaceAll === 'undefined') {
  String.prototype.replaceAll = function (search: string | RegExp, replacement: string): string {
    if (search instanceof RegExp) {
      if (!search.global) {
        throw new TypeError('String.prototype.replaceAll called with a non-global RegExp');
      }
      return this.replace(search, replacement);
    }
    return this.split(search).join(replacement);
  };
}
