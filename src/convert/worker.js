// Imports a PC install into OPFS. Posts progress, warning, error and done.

import {
  FETCHED_DIR,
  GAME_ENTRIES,
  IMPORT_TMP,
  OPFS_VERSION,
  PACKAGE_DATA,
  PACKAGE_INDEX,
  READY_MARKER,
  createPackageIndex,
} from "./layout.js";
import { convertInstall, indexInstall, validateInstall } from "./plan.js";
import { folderSource, zipSource, ZipError } from "./sources.js";

const BASE = import.meta.env.BASE_URL;
// Bigger files are not hashed (it needs them in memory).
const HASH_LIMIT = 32 * 1024 * 1024;

class ImportError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

async function removeEntry(dir, name) {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // not there
  }
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function writer(root) {
  const dirs = new Map([["", root]]);
  const dirFor = async (path) => {
    const parts = path.split("/").slice(0, -1);
    let key = "";
    let dir = root;
    for (const part of parts) {
      key = key ? `${key}/${part}` : part;
      if (!dirs.has(key)) dirs.set(key, await dir.getDirectoryHandle(part, { create: true }));
      dir = dirs.get(key);
    }
    return dir;
  };
  return {
    async write(path, bytes) {
      const dir = await dirFor(path);
      const handle = await dir.getFileHandle(path.split("/").pop(), { create: true });
      const access = await handle.createSyncAccessHandle();
      try {
        access.truncate(0);
        access.write(bytes, { at: 0 });
        access.flush();
      } finally {
        access.close();
      }
    },
    async open(path) {
      const dir = await dirFor(path);
      const handle = await dir.getFileHandle(path.split("/").pop(), { create: true });
      const access = await handle.createSyncAccessHandle();
      access.truncate(0);
      return access;
    },
  };
}

async function run(message) {
  const post = (m) => self.postMessage(m);
  const root = await navigator.storage.getDirectory();
  await removeEntry(root, IMPORT_TMP);
  const tmp = await root.getDirectoryHandle(IMPORT_TMP, { create: true });

  post({ type: "progress", phase: "checking" });
  let source;
  try {
    source =
      message.kind === "zip"
        ? await zipSource(message.file, tmp, (file) =>
            post({ type: "progress", phase: "unpacking", file: file.split("/").pop() }),
          )
        : folderSource(message.entries);
  } catch (err) {
    if (err instanceof ZipError) throw new ImportError("zip", { message: err.message });
    throw err;
  }

  const install = indexInstall(source.paths);
  if (!install) {
    const hasDisc = source.paths.some((p) => /\.iso$/i.test(p));
    throw new ImportError(hasDisc ? "discImage" : "notGameFolder");
  }

  const { missing, mismatched } = await validateInstall(install, async (path) =>
    source.size(path) > HASH_LIMIT ? null : sha256(await source.read(path)),
  );
  if (missing.length) throw new ImportError("missingFiles", { files: missing });
  if (mismatched.length) post({ type: "warning", code: "mismatch", files: mismatched });

  // Marker goes last, so a half import is never ready.
  for (const name of GAME_ENTRIES) await removeEntry(root, name);
  const out = writer(root);
  const data = await out.open(PACKAGE_DATA);
  const index = createPackageIndex();
  let lastPost = 0;

  try {
    await convertInstall({
      source,
      index: install,
      async readRevcFile(path) {
        const response = await fetch(`${BASE}revc/${path}`);
        if (!response.ok) throw new Error(`could not load revc/${path}: ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      },
      async emit(kind, path, bytes) {
        if (kind === "data") {
          data.write(bytes, { at: index.add(path, bytes.length) });
        } else {
          await out.write(`${FETCHED_DIR}/${path}`, bytes);
        }
      },
      onProgress(done, total) {
        const now = Date.now();
        if (now - lastPost > 200 || done === total) {
          lastPost = now;
          post({ type: "progress", phase: "converting", done, total });
        }
      },
    });
    data.flush();
  } finally {
    data.close();
  }

  const encode = (s) => new TextEncoder().encode(s);
  await out.write(PACKAGE_INDEX, encode(JSON.stringify(index)));
  await removeEntry(root, IMPORT_TMP);
  await out.write(READY_MARKER, encode(OPFS_VERSION));
  post({ type: "done" });
}

self.onmessage = async (event) => {
  try {
    await run(event.data);
  } catch (err) {
    console.error("[convert]", err);
    if (err instanceof ImportError) {
      self.postMessage({ type: "error", code: err.code, ...err.details });
    } else if (err.name === "QuotaExceededError") {
      self.postMessage({ type: "error", code: "storage" });
    } else {
      self.postMessage({ type: "error", code: "generic", message: err.message });
    }
    try {
      await removeEntry(await navigator.storage.getDirectory(), IMPORT_TMP);
    } catch {
      // best effort
    }
  }
};
