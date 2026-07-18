import { describe, it, expect, afterEach } from 'vitest';
import {
  getSpuriousUriListPlainText,
  installPasteNormalizer,
} from '../../src/utils/paste-normalizer';

type ClipboardStub = Record<string, string>;

const makeClipboardData = (entries: ClipboardStub) =>
  ({
    getData: (type: string) => entries[type] || '',
  }) as DataTransfer;

const makePasteEvent = (entries: ClipboardStub) => {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: makeClipboardData(entries) });
  return event;
};

describe('getSpuriousUriListPlainText', () => {
  it('returns the plain text when the uri-list entry is a percent-encoded duplicate', () => {
    const data = makeClipboardData({
      'text/uri-list': 'foo:%20bar',
      'text/plain': 'foo: bar',
    });
    expect(getSpuriousUriListPlainText(data)).toBe('foo: bar');
  });

  it('ignores a real URL where uri-list and plain text agree', () => {
    const data = makeClipboardData({
      'text/uri-list': 'https://example.com/page',
      'text/plain': 'https://example.com/page',
    });
    expect(getSpuriousUriListPlainText(data)).toBeNull();
  });

  it('ignores a copied URL that already contains percent escapes', () => {
    const data = makeClipboardData({
      'text/uri-list': 'https://example.com/a%20b',
      'text/plain': 'https://example.com/a%20b',
    });
    expect(getSpuriousUriListPlainText(data)).toBeNull();
  });

  it('ignores a uri-list entry that decodes to something else', () => {
    const data = makeClipboardData({
      'text/uri-list': 'https://example.com/other',
      'text/plain': 'unrelated text',
    });
    expect(getSpuriousUriListPlainText(data)).toBeNull();
  });

  it('ignores malformed percent sequences instead of throwing', () => {
    const data = makeClipboardData({
      'text/uri-list': 'foo:%ZZbar',
      'text/plain': 'foo: bar',
    });
    expect(getSpuriousUriListPlainText(data)).toBeNull();
  });

  it('returns null when either entry is missing', () => {
    expect(getSpuriousUriListPlainText(makeClipboardData({ 'text/plain': 'foo: bar' }))).toBeNull();
    expect(
      getSpuriousUriListPlainText(makeClipboardData({ 'text/uri-list': 'foo:%20bar' })),
    ).toBeNull();
    expect(getSpuriousUriListPlainText(null)).toBeNull();
  });
});

describe('installPasteNormalizer', () => {
  let uninstall: (() => void) | null = null;

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    document.body.innerHTML = '';
  });

  it('replaces the encoded paste with plain text in a text input', () => {
    uninstall = installPasteNormalizer(document);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    let inputEventFired = false;
    input.addEventListener('input', () => (inputEventFired = true));

    const event = makePasteEvent({
      'text/uri-list': 'foo:%20bar',
      'text/plain': 'foo: bar',
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('foo: bar');
    expect(inputEventFired).toBe(true);
  });

  it('inserts at the caret and replaces any selection', () => {
    uninstall = installPasteNormalizer(document);
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'before SELECTED after';
    document.body.appendChild(input);
    input.setSelectionRange('before '.length, 'before SELECTED'.length);

    input.dispatchEvent(
      makePasteEvent({
        'text/uri-list': 'foo:%20bar',
        'text/plain': 'foo: bar',
      }),
    );

    expect(input.value).toBe('before foo: bar after');
  });

  it('falls back to appending for inputs without selection support', () => {
    uninstall = installPasteNormalizer(document);
    const input = document.createElement('input');
    input.type = 'email';
    input.value = 'a@b.c';
    document.body.appendChild(input);

    input.dispatchEvent(
      makePasteEvent({
        'text/uri-list': 'foo:%20bar',
        'text/plain': 'foo: bar',
      }),
    );

    expect(input.value).toBe('a@b.cfoo: bar');
  });

  it('leaves ordinary pastes alone', () => {
    uninstall = installPasteNormalizer(document);
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    const event = makePasteEvent({ 'text/plain': 'foo: bar' });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe('');
  });

  it('does not touch contenteditable targets', () => {
    uninstall = installPasteNormalizer(document);
    const div = document.createElement('div');
    div.contentEditable = 'true';
    document.body.appendChild(div);

    const event = makePasteEvent({
      'text/uri-list': 'foo:%20bar',
      'text/plain': 'foo: bar',
    });
    div.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('does not touch readonly inputs', () => {
    uninstall = installPasteNormalizer(document);
    const input = document.createElement('input');
    input.type = 'text';
    input.readOnly = true;
    document.body.appendChild(input);

    const event = makePasteEvent({
      'text/uri-list': 'foo:%20bar',
      'text/plain': 'foo: bar',
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe('');
  });

  it('stops intercepting after uninstall', () => {
    const remove = installPasteNormalizer(document);
    remove();

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);

    const event = makePasteEvent({
      'text/uri-list': 'foo:%20bar',
      'text/plain': 'foo: bar',
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(input.value).toBe('');
  });
});
