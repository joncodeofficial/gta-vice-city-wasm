#!/usr/bin/env node
// Runs the import on a folder, for testing: convert-pc.mjs <install> <out>

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { FETCHED_DIR, PACKAGE_DATA, PACKAGE_INDEX, createPackageIndex } from "../src/convert/layout.js";
import { convertInstall, indexInstall, validateInstall } from "../src/convert/plan.js";

const [installDir, outDir] = process.argv.slice(2);
if (!installDir || !outDir) {
  console.error("usage: node scripts/convert-pc.mjs <install-folder> <out-folder>");
  process.exit(1);
}

const revcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "revc");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(relative(installDir, full).split(sep).join("/"));
  }
  return out;
}

const paths = await walk(installDir);
const source = {
  paths,
  read: async (p) => new Uint8Array(await readFile(join(installDir, p))),
  async readRange(p, offset, size) {
    const fh = await open(join(installDir, p));
    try {
      const buf = Buffer.alloc(size);
      const { bytesRead } = await fh.read(buf, 0, size, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
    } finally {
      await fh.close();
    }
  },
};
const hash = (p) =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(join(installDir, p))
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

const index = indexInstall(paths);
if (!index) {
  console.error("No models/gta3.img found: this does not look like a Vice City install folder.");
  process.exit(1);
}

console.log("Checking files…");
const { missing, mismatched } = await validateInstall(index, hash);
if (missing.length) {
  console.error("Missing required files:\n  " + missing.join("\n  "));
  process.exit(1);
}
if (mismatched.length) {
  console.warn(`Warning: ${mismatched.length} files differ from the known release: ${mismatched.join(", ")}`);
}

const out = (path) => join(outDir, ...path.split("/"));
await mkdir(dirname(out(PACKAGE_DATA)), { recursive: true });
const dataFile = await open(out(PACKAGE_DATA), "w");
const packageIndex = createPackageIndex();
const made = new Set();

const started = Date.now();
await convertInstall({
  source,
  index,
  readRevcFile: async (p) => new Uint8Array(await readFile(join(revcDir, p))),
  async emit(kind, p, bytes) {
    if (kind === "data") {
      packageIndex.add(p, bytes.length);
      await dataFile.write(bytes);
    } else {
      const target = out(`${FETCHED_DIR}/${p}`);
      const dir = dirname(target);
      if (!made.has(dir)) {
        await mkdir(dir, { recursive: true });
        made.add(dir);
      }
      await writeFile(target, bytes);
    }
  },
  onProgress(done, total) {
    if (done % 250 === 0 || done === total) {
      const secs = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`\r${done}/${total} files (${secs}s)`);
    }
  },
});
await dataFile.close();
process.stdout.write("\n");

await writeFile(out(PACKAGE_INDEX), JSON.stringify(packageIndex));

const size = (await stat(out(PACKAGE_DATA))).size;
console.log(`Done in ${((Date.now() - started) / 1000).toFixed(0)}s. Package: ${(size / 1e6).toFixed(1)} MB, ${packageIndex.count} files.`);
