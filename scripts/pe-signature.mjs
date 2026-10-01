/**
 * Authenticode signatures on Windows executables (PE files).
 *
 * The official node.exe is signed by the Node.js project. A single
 * executable application starts as a copy of it, and postject then adds the
 * app as a resource. Node's old signature would be left in the middle of the
 * file, where it no longer matches, and signing tools refuse to add a new
 * one ("The certificate table isn't at the end of the file"). So the copy's
 * signature is removed before injecting, as `signtool remove /s` does:
 * https://nodejs.org/api/single-executable-applications.html
 */
import fs from 'node:fs';

const SECURITY_DIRECTORY = 4;

// The file offset of the security data directory entry, or -1 when the file
// is not a PE file with one.
function securityEntryOffset(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') return -1;
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.toString('latin1', pe, pe + 4) !== 'PE\0\0') return -1;
  const optional = pe + 24;
  if (optional + 2 > buffer.length) return -1;
  const magic = buffer.readUInt16LE(optional);
  // PE32 and PE32+ differ in where the data directories start.
  const layout = { 0x10b: [92, 96], 0x20b: [108, 112] }[magic];
  if (!layout) return -1;
  const [countAt, directoriesAt] = layout;
  if (optional + directoriesAt + (SECURITY_DIRECTORY + 1) * 8 > buffer.length) return -1;
  if (buffer.readUInt32LE(optional + countAt) <= SECURITY_DIRECTORY) return -1;
  return optional + directoriesAt + SECURITY_DIRECTORY * 8;
}

/** Whether the PE file has an Authenticode signature (a certificate table). */
export function hasSignature(file) {
  const buffer = fs.readFileSync(file);
  const entry = securityEntryOffset(buffer);
  if (entry < 0) throw new Error(`${file} is not a Windows executable`);
  return buffer.readUInt32LE(entry + 4) !== 0;
}

/**
 * Removes the Authenticode signature from a PE file in place. Returns
 * whether there was one.
 */
export function removeSignature(file) {
  const buffer = fs.readFileSync(file);
  const entry = securityEntryOffset(buffer);
  if (entry < 0) throw new Error(`${file} is not a Windows executable`);
  const offset = buffer.readUInt32LE(entry);
  const size = buffer.readUInt32LE(entry + 4);
  if (size === 0) return false;
  // A real table starts after the headers and ends inside the file.
  if (offset < entry + 8 || offset + size > buffer.length) {
    throw new Error(`${file} has an invalid certificate table entry`);
  }
  buffer.writeUInt32LE(0, entry);
  buffer.writeUInt32LE(0, entry + 4);
  // The certificate table is the last thing in a signed file (padded to 8
  // bytes). Cut it off; anything after it is not a signature and is kept.
  const end = offset + size + ((8 - ((offset + size) % 8)) % 8);
  const keep = end >= buffer.length ? offset : buffer.length;
  fs.writeFileSync(file, buffer.subarray(0, keep));
  return true;
}
