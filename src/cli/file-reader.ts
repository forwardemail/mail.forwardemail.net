/**
 * window.FileReader, which Node lacks and TermDOM leaves out.
 *
 * The webmail reads every file the user picks through a FileReader: the
 * compose window turns an attachment into base64 with readAsDataURL, and
 * the contact and calendar imports read text. Without one, attaching a file
 * failed with "FileReader is not defined". This reads any Blob or File
 * (Node's, which the app gets as File and Blob) and reports back the way a
 * browser does: loadstart, then load or error, then loadend, each to its
 * on<event> handler and to listeners.
 */

const EMPTY = 0;
const LOADING = 1;
const DONE = 2;

type ReadAs = 'dataURL' | 'text' | 'arrayBuffer' | 'binaryString';

interface Readable {
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

const EVENTS = ['loadstart', 'progress', 'load', 'error', 'abort', 'loadend'] as const;

export class FileReader extends EventTarget {
  static readonly EMPTY = EMPTY;
  static readonly LOADING = LOADING;
  static readonly DONE = DONE;
  readonly EMPTY = EMPTY;
  readonly LOADING = LOADING;
  readonly DONE = DONE;

  readyState = EMPTY;
  result: string | ArrayBuffer | null = null;
  error: Error | null = null;

  onloadstart: ((event: Event) => void) | null = null;
  onprogress: ((event: Event) => void) | null = null;
  onload: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onabort: ((event: Event) => void) | null = null;
  onloadend: ((event: Event) => void) | null = null;

  // Bumped by abort() and each new read, so a read that finishes late is
  // dropped.
  #read = 0;

  constructor() {
    super();
    for (const type of EVENTS) {
      this.addEventListener(type, (event) => {
        const handler = this[`on${type}`];
        if (typeof handler === 'function') handler.call(this, event);
      });
    }
  }

  readAsDataURL(blob: Readable) {
    this.#start(blob, 'dataURL');
  }

  readAsText(blob: Readable, encoding = 'utf-8') {
    this.#start(blob, 'text', encoding);
  }

  readAsArrayBuffer(blob: Readable) {
    this.#start(blob, 'arrayBuffer');
  }

  readAsBinaryString(blob: Readable) {
    this.#start(blob, 'binaryString');
  }

  abort() {
    if (this.readyState !== LOADING) return;
    this.#read++;
    this.readyState = DONE;
    this.result = null;
    this.#fire('abort');
    this.#fire('loadend');
  }

  #fire(type: (typeof EVENTS)[number], total = 0) {
    const event = new Event(type);
    Object.assign(event, { lengthComputable: total > 0, loaded: total, total });
    this.dispatchEvent(event);
  }

  #start(blob: Readable, as: ReadAs, encoding?: string) {
    if (this.readyState === LOADING) {
      throw new DOMException('The reader is already reading a file.', 'InvalidStateError');
    }
    if (!blob || typeof blob.arrayBuffer !== 'function') {
      throw new TypeError('FileReader can only read a Blob or File');
    }
    const read = ++this.#read;
    this.readyState = LOADING;
    this.result = null;
    this.error = null;
    // As in a browser, nothing is reported before the caller has set its
    // handlers, which it may do after calling readAs….
    queueMicrotask(() => {
      if (read === this.#read) this.#fire('loadstart');
    });
    const fail = (error: unknown) => {
      if (read !== this.#read) return;
      this.readyState = DONE;
      this.error = error instanceof Error ? error : new Error(String(error));
      this.#fire('error');
      this.#fire('loadend');
    };
    blob.arrayBuffer().then((buffer) => {
      if (read !== this.#read) return;
      const bytes = Buffer.from(buffer);
      try {
        this.result =
          as === 'dataURL'
            ? `data:${blob.type || 'application/octet-stream'};base64,${bytes.toString('base64')}`
            : as === 'text'
              ? new TextDecoder(encoding || 'utf-8').decode(bytes)
              : as === 'binaryString'
                ? bytes.toString('latin1')
                : buffer;
      } catch (error) {
        fail(error);
        return;
      }
      this.readyState = DONE;
      this.#fire('progress', bytes.length);
      this.#fire('load', bytes.length);
      this.#fire('loadend', bytes.length);
    }, fail);
  }
}
