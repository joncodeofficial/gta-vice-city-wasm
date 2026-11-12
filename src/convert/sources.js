// Install sources for plan.js, read lazily with File.slice.

import { syncAccess } from "./opfs.js";

// entries: [{ path, file }]
export function folderSource(entries) {
  const byPath = new Map();
  for (const { path, file } of entries) {
    const name = path.split("/").pop();
    if (name === ".DS_Store" || name.startsWith("._")) continue;
    byPath.set(path, file);
  }
  const get = (p) => byPath.get(p);
  return {
    paths: [...byPath.keys()],
    size: (p) => get(p).size,
    read: async (p) => new Uint8Array(await get(p).arrayBuffer()),
    readRange: async (p, offset, size) =>
      new Uint8Array(await get(p).slice(offset, offset + size).arrayBuffer()),
  };
}

export class ZipError extends Error {}

const u16 = (v, p) => v.getUint16(p, true);
const u32 = (v, p) => v.getUint32(p, true);
const u64 = (v, p) => Number(v.getBigUint64(p, true));

async function view(file, start, end) {
  const buf = await file.slice(start, end).arrayBuffer();
  return new DataView(buf);
}

// Supports ZIP64.
async function readCentralDirectory(file) {
  const tailStart = Math.max(0, file.size - 65557);
  const tail = await view(file, tailStart, file.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip file");

  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || u32(tail, loc) !== 0x07064b50) throw new ZipError("damaged ZIP64 archive");
    const z64At = u64(tail, loc + 8);
    const z64 = await view(file, z64At, z64At + 56);
    if (u32(z64, 0) !== 0x06064b50) throw new ZipError("damaged ZIP64 archive");
    count = u64(z64, 32);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }

  const cd = await view(file, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder();
  const entries = new Map();
  let p = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > cd.byteLength || u32(cd, p) !== 0x02014b50) throw new ZipError("damaged zip file");
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    let compSize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    let localOffset = u32(cd, p + 42);
    const path = decoder.decode(new Uint8Array(cd.buffer, p + 46, nameLen));

    // ZIP64 extra field
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (compSize === 0xffffffff) (compSize = u64(cd, q)), (q += 8);
        if (localOffset === 0xffffffff) localOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;

    const name = path.split("/").pop();
    if (!name || path.startsWith("__MACOSX/") || name === ".DS_Store" || name.startsWith("._")) continue;
    entries.set(path, { flags, method, compSize, size, localOffset });
  }
  return entries;
}

// tmpDir: OPFS dir for unpacked big entries; the caller removes it.
// onUnpack(path) is called often while one is unpacked.
export async function zipSource(file, tmpDir, onUnpack) {
  const entries = await readCentralDirectory(file);
  const unpacked = new Map();

  const dataStart = async (path) => {
    const e = entries.get(path);
    if (e.flags & 1) throw new ZipError(`${path} is encrypted`);
    if (e.method !== 0 && e.method !== 8) throw new ZipError(`${path} uses an unsupported compression method`);
    const local = await view(file, e.localOffset, e.localOffset + 30);
    if (u32(local, 0) !== 0x04034b50) throw new ZipError("damaged zip file");
    return e.localOffset + 30 + u16(local, 26) + u16(local, 28);
  };

  const rawStream = async (path) => {
    const e = entries.get(path);
    const start = await dataStart(path);
    const stream = file.slice(start, start + e.compSize).stream();
    return e.method === 0 ? stream : stream.pipeThrough(new DecompressionStream("deflate-raw"));
  };

  const readAll = async (path) => {
    const e = entries.get(path);
    const out = new Uint8Array(e.size);
    let o = 0;
    const reader = (await rawStream(path)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (o + value.length > out.length) throw new ZipError(`${path} is larger than the zip says`);
      out.set(value, o);
      o += value.length;
    }
    return out;
  };

  // Deflate isn't seekable: unpack once to read ranges.
  const ranged = async (path) => {
    const e = entries.get(path);
    if (e.method === 0) {
      const start = await dataStart(path);
      return file.slice(start, start + e.size);
    }
    if (!unpacked.has(path)) {
      const handle = await tmpDir.getFileHandle(`f${unpacked.size}`, { create: true });
      const access = await syncAccess(handle);
      try {
        access.truncate(0);
        let at = 0;
        const reader = (await rawStream(path)).getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          access.write(value, { at });
          at += value.length;
          onUnpack?.(path);
        }
        access.flush();
      } finally {
        access.close();
      }
      unpacked.set(path, await handle.getFile());
    }
    return unpacked.get(path);
  };

  return {
    paths: [...entries.keys()],
    size: (p) => entries.get(p).size,
    read: readAll,
    async readRange(p, offset, size) {
      const blob = await ranged(p);
      return new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
    },
  };
}
