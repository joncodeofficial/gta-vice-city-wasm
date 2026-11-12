// Maps a PC install to engine files. source: { paths, read, readRange, size }.

import manifest from "./manifest.json" with { type: "json" };
import {
  decodeAdf,
  decodeWav,
  encodeMp3,
  parseImgDir,
  parseSdt,
  patchSdtRates,
  pcm16,
} from "./formats.js";

const IMGS = [
  { prefix: "models/gta3.img/", img: "models/gta3.img", dir: "models/gta3.dir" },
  { prefix: "anim/cuts.img/", img: "anim/cuts.img", dir: "anim/cuts.dir" },
];

const REQUIRED = [
  "models/gta3.img",
  "models/gta3.dir",
  "anim/cuts.img",
  "anim/cuts.dir",
  "audio/sfx.raw",
  "audio/sfx.sdt",
  "data/main.scm",
  "text/american.gxt",
];

// Lower-case path -> source path; the root is wherever models/gta3.img is.
export function indexInstall(paths) {
  const marker = paths.find((p) => /(^|\/)models\/gta3\.img$/i.test(p));
  if (!marker) return null;
  const root = marker.slice(0, marker.length - "models/gta3.img".length);
  const index = new Map();
  for (const p of paths) {
    if (p.toLowerCase().startsWith(root.toLowerCase())) {
      index.set(p.slice(root.length).toLowerCase(), p);
    }
  }
  return index;
}

// hash(path) may return null to skip a file.
export async function validateInstall(index, hash) {
  const missing = REQUIRED.filter((p) => !index.has(p));
  const mismatched = [];
  if (hash && missing.length === 0) {
    const byName = new Map();
    for (const [lower, real] of index) byName.set(lower.split("/").pop(), real);
    for (const [name, expected] of Object.entries(manifest.sha256)) {
      const real = byName.get(name);
      if (!real) continue;
      const actual = await hash(real);
      if (actual !== null && actual !== expected) mismatched.push(name);
    }
  }
  return { missing, mismatched };
}

// emit(kind, path, bytes) with kind "data" (package) or "fetched".
export async function convertInstall({ source, index, readRevcFile, emit, onProgress }) {
  const real = (p) => {
    const r = index.get(p);
    if (!r) throw new Error(`missing file in the game folder: ${p}`);
    return r;
  };
  const dataSet = new Set(manifest.dataFiles);
  const revcSet = new Set(manifest.revcFiles);

  const imgEntries = new Map();
  for (const img of IMGS) {
    const entries = parseImgDir(await source.read(real(img.dir)));
    for (const e of entries) imgEntries.set(img.prefix + e.name, { img: img.img, ...e });
  }
  const readImgEntry = (e) => source.readRange(real(e.img), e.offset, e.size);

  const audio = [...index.keys()].filter(
    (p) => p.startsWith("audio/") && /\.(wav|mp3|adf)$/.test(p) && !dataSet.has(p),
  );
  const sdtBytes = await source.read(real("audio/sfx.sdt"));
  const sfx = parseSdt(sdtBytes);

  const fetchedImg = [...imgEntries.keys()].filter((p) => !dataSet.has(p));
  const total = manifest.dataFiles.length + fetchedImg.length + audio.length + sfx.length;
  let done = 0;
  const tick = () => onProgress?.(++done, total);

  // First, so sfx.sdt gets the encoded rates.
  const rates = [];
  const sfxRaw = real("audio/sfx.raw");
  for (let n = 0; n < sfx.length; n++) {
    const { offset, size, rate } = sfx[n];
    const mp3 = encodeMp3(pcm16(await source.readRange(sfxRaw, offset, size)), rate);
    rates.push(mp3.rate);
    await emit("fetched", `audio/sfx.raw/${n}.mp3`, mp3.bytes);
    tick();
  }

  for (const p of manifest.dataFiles) {
    let bytes;
    if (revcSet.has(p)) bytes = await readRevcFile(p);
    else if (p === "audio/sfx.sdt") bytes = patchSdtRates(sdtBytes, rates);
    else if (imgEntries.has(p)) bytes = await readImgEntry(imgEntries.get(p));
    else if (p.endsWith(".adf")) bytes = decodeAdf(await source.read(real(p)));
    else bytes = await source.read(real(p));
    await emit("data", p, bytes);
    tick();
  }

  for (const p of fetchedImg) {
    await emit("fetched", p, await readImgEntry(imgEntries.get(p)));
    tick();
  }

  for (const p of audio) {
    const bytes = await source.read(real(p));
    if (p.endsWith(".adf")) {
      await emit("fetched", p, decodeAdf(bytes));
    } else if (p.endsWith(".wav")) {
      // The engine only decodes MP3, but asks for the .wav name.
      const { rate, samples } = decodeWav(bytes);
      await emit("fetched", p, encodeMp3(samples, rate).bytes);
    } else {
      await emit("fetched", p, bytes);
    }
    tick();
  }
}
