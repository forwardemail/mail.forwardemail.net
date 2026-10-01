import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hasSignature, removeSignature } from '../../scripts/pe-signature.mjs';

const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length) rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

// A minimal PE file: DOS header, PE signature, COFF header, optional header
// with 16 data directories, then a body, then optionally a certificate table.
function writePe({ magic = 0x20b, certificate = null, trailer = null } = {}) {
  const pe = 0x40;
  const optional = pe + 24;
  const directoriesAt = magic === 0x20b ? 112 : 96;
  const countAt = magic === 0x20b ? 108 : 92;
  const header = Buffer.alloc(optional + directoriesAt + 16 * 8);
  header.write('MZ', 0, 'latin1');
  header.writeUInt32LE(pe, 0x3c);
  header.write('PE\0\0', pe, 'latin1');
  header.writeUInt16LE(magic, optional);
  header.writeUInt32LE(16, optional + countAt);
  const body = Buffer.from('program code and resources\0\0\0\0\0\0');
  const parts = [header, body];
  if (certificate) {
    const security = optional + directoriesAt + 4 * 8;
    header.writeUInt32LE(header.length + body.length, security);
    header.writeUInt32LE(certificate.length, security + 4);
    parts.push(certificate);
  }
  if (trailer) parts.push(trailer);

  const root = mkdtempSync(path.join(os.tmpdir(), 'forward-email-pe-'));
  temporaryRoots.push(root);
  const file = path.join(root, 'program.exe');
  writeFileSync(file, Buffer.concat(parts));
  return { file, unsignedLength: header.length + body.length, body };
}

describe('pe-signature', () => {
  it('removes the certificate table from the end of a signed PE32+ file', () => {
    const { file, unsignedLength, body } = writePe({ certificate: Buffer.alloc(24, 0xaa) });
    expect(hasSignature(file)).toBe(true);

    expect(removeSignature(file)).toBe(true);

    expect(hasSignature(file)).toBe(false);
    const after = readFileSync(file);
    expect(after.length).toBe(unsignedLength);
    expect(after.subarray(unsignedLength - body.length).equals(body)).toBe(true);
  });

  it('handles PE32 files', () => {
    const { file, unsignedLength } = writePe({ magic: 0x10b, certificate: Buffer.alloc(16, 1) });
    expect(removeSignature(file)).toBe(true);
    expect(hasSignature(file)).toBe(false);
    expect(statSync(file).size).toBe(unsignedLength);
  });

  it('leaves an unsigned file unchanged', () => {
    const { file } = writePe();
    const before = readFileSync(file);
    expect(hasSignature(file)).toBe(false);
    expect(removeSignature(file)).toBe(false);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('keeps data that follows the certificate table', () => {
    const trailer = Buffer.from('appended data that is not a signature');
    const { file, unsignedLength } = writePe({ certificate: Buffer.alloc(8, 2), trailer });
    expect(removeSignature(file)).toBe(true);
    expect(hasSignature(file)).toBe(false);
    expect(statSync(file).size).toBe(unsignedLength + 8 + trailer.length);
  });

  it('removes the padding after a certificate table whose size is not a multiple of 8', () => {
    // A 20-byte table is padded with 4 zero bytes to the end of the file.
    const certificate = Buffer.alloc(24, 3);
    const { file, unsignedLength } = writePe({ certificate });
    const raw = readFileSync(file);
    const security = 0x40 + 24 + 112 + 4 * 8;
    raw.writeUInt32LE(20, security + 4);
    writeFileSync(file, raw);

    expect(removeSignature(file)).toBe(true);
    expect(statSync(file).size).toBe(unsignedLength);
  });

  it('refuses a certificate table entry that points outside the file', () => {
    const { file } = writePe({ certificate: Buffer.alloc(8, 4) });
    const raw = readFileSync(file);
    const security = 0x40 + 24 + 112 + 4 * 8;
    raw.writeUInt32LE(raw.length * 2, security + 4);
    writeFileSync(file, raw);
    const before = readFileSync(file);

    expect(() => removeSignature(file)).toThrow(/invalid certificate table/);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('refuses files that are not Windows executables', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'forward-email-pe-'));
    temporaryRoots.push(root);
    const file = path.join(root, 'notes.txt');
    writeFileSync(file, 'MZ is not enough'.padEnd(128, ' '));
    expect(() => removeSignature(file)).toThrow(/not a Windows executable/);
    expect(() => hasSignature(file)).toThrow(/not a Windows executable/);
  });
});
