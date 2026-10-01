/**
 * `new Image()` for the terminal.
 *
 * Browsers preload pictures with `new Image()`: contact and profile avatars
 * (bits-ui's Avatar), the favicon unread badge and the photo croppers. TermDOM
 * has `<img>` elements but no `Image` constructor, so the first contact with
 * a photo crashed the app ("ReferenceError: Image is not defined").
 *
 * A terminal draws no pictures, so the image this returns reports that it
 * could not load, as a broken image does in a browser: avatars show their
 * initials and the badge and croppers take their error paths. The error is
 * sent after the current task, because callers set `src` before attaching
 * `onload` and `onerror`.
 */
type ImageElement = HTMLElement & {
  src: string;
  width: number;
  height: number;
};

export function createImageConstructor(win: Record<string, unknown>) {
  const doc = win.document as Document;
  const EventCtor = win.Event as typeof Event;
  const ImageElementCtor = win.HTMLImageElement as { prototype: object } | undefined;
  const srcAccessor = ImageElementCtor
    ? Object.getOwnPropertyDescriptor(ImageElementCtor.prototype, 'src')
    : undefined;

  function Image(this: unknown, width?: number, height?: number) {
    const img = doc.createElement('img') as unknown as ImageElement;
    if (width !== undefined) img.width = width;
    if (height !== undefined) img.height = height;
    let src = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    Object.defineProperty(img, 'src', {
      configurable: true,
      enumerable: true,
      get() {
        return srcAccessor?.get ? srcAccessor.get.call(img) : src;
      },
      set(value: unknown) {
        src = String(value ?? '');
        if (srcAccessor?.set) srcAccessor.set.call(img, src);
        else img.setAttribute('src', src);
        clearTimeout(timer);
        if (!src) return;
        timer = setTimeout(() => img.dispatchEvent(new EventCtor('error')), 0);
      },
    });
    for (const name of ['naturalWidth', 'naturalHeight']) {
      Object.defineProperty(img, name, { configurable: true, get: () => 0 });
    }
    // A browser reports a failed image as complete, with no size.
    Object.defineProperty(img, 'complete', { configurable: true, get: () => true });
    return img;
  }
  if (ImageElementCtor) Image.prototype = ImageElementCtor.prototype;
  return Image as unknown as typeof globalThis.Image;
}
