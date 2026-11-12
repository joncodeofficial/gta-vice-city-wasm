// Vice City PC file formats, as pure functions over Uint8Array.

import { Mp3Encoder } from "@breezystack/lamejs";

const SECTOR = 2048;

// IMG v1 .dir: 32-byte entries (offset, size in sectors, name).
export function parseImgDir(dir) {
  const view = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries = [];
  for (let i = 0; i + 32 <= dir.byteLength; i += 32) {
    const offset = view.getUint32(i, true) * SECTOR;
    const size = view.getUint32(i + 4, true) * SECTOR;
    let end = i + 8;
    while (end < i + 32 && dir[end] !== 0) end++;
    const name = String.fromCharCode(...dir.subarray(i + 8, end)).toLowerCase();
    entries.push({ name, offset, size });
  }
  return entries;
}

// .adf radio: MP3 XORed with 0x22.
export function decodeAdf(bytes) {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ 0x22;
  return out;
}

// sfx.sdt: 20-byte entries, slices of sfx.raw (16-bit mono PCM).
export function parseSdt(sdt) {
  const view = new DataView(sdt.buffer, sdt.byteOffset, sdt.byteLength);
  const entries = [];
  for (let i = 0; i + 20 <= sdt.byteLength; i += 20) {
    entries.push({
      offset: view.getUint32(i, true),
      size: view.getUint32(i + 4, true),
      rate: view.getUint32(i + 8, true),
    });
  }
  return entries;
}

// Rates must match the encoded MP3 chunks.
export function patchSdtRates(sdt, rates) {
  const out = sdt.slice();
  const view = new DataView(out.buffer);
  rates.forEach((rate, n) => view.setUint32(n * 20 + 8, rate, true));
  return out;
}

const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

// Ties go to the higher rate.
export function nearestMp3Rate(rate) {
  let best = MP3_RATES[0];
  for (const r of MP3_RATES) {
    if (Math.abs(r - rate) <= Math.abs(best - rate)) best = r;
  }
  return best;
}

export function resample(samples, from, to) {
  if (from === to) return samples;
  const length = Math.max(1, Math.round((samples.length * to) / from));
  const out = new Int16Array(length);
  const step = from / to;
  for (let i = 0; i < length; i++) {
    const pos = i * step;
    const j = Math.floor(pos);
    const a = samples[Math.min(j, samples.length - 1)];
    const b = samples[Math.min(j + 1, samples.length - 1)];
    out[i] = Math.round(a + (b - a) * (pos - j));
  }
  return out;
}

const IMA_STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
  50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
  253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
  3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
  11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

function decodeImaAdpcm(data, blockAlign) {
  const perBlock = (blockAlign - 4) * 2 + 1;
  const blocks = Math.ceil(data.length / blockAlign);
  const out = new Int16Array(blocks * perBlock);
  let n = 0;
  for (let b = 0; b < data.length; b += blockAlign) {
    const end = Math.min(b + blockAlign, data.length);
    if (end - b < 4) break;
    let predictor = (data[b] | (data[b + 1] << 8)) << 16 >> 16;
    let index = Math.min(88, data[b + 2]);
    out[n++] = predictor;
    for (let i = b + 4; i < end; i++) {
      for (const nibble of [data[i] & 15, data[i] >> 4]) {
        const step = IMA_STEPS[index];
        let diff = step >> 3;
        if (nibble & 1) diff += step >> 2;
        if (nibble & 2) diff += step >> 1;
        if (nibble & 4) diff += step;
        predictor += nibble & 8 ? -diff : diff;
        predictor = Math.max(-32768, Math.min(32767, predictor));
        index = Math.max(0, Math.min(88, index + IMA_INDEX[nibble & 7]));
        out[n++] = predictor;
      }
    }
  }
  return out.subarray(0, n);
}

// Mono WAV: PCM 16-bit or IMA ADPCM.
export function decodeWav(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmt = null;
  let data = null;
  for (let i = 12; i + 8 <= bytes.byteLength; ) {
    const id = String.fromCharCode(...bytes.subarray(i, i + 4));
    const size = view.getUint32(i + 4, true);
    if (id === "fmt ") {
      fmt = {
        format: view.getUint16(i + 8, true),
        channels: view.getUint16(i + 10, true),
        rate: view.getUint32(i + 12, true),
        blockAlign: view.getUint16(i + 20, true),
      };
    } else if (id === "data") {
      data = bytes.subarray(i + 8, Math.min(i + 8 + size, bytes.byteLength));
    }
    i += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("not a WAV file");
  if (fmt.channels !== 1) throw new Error(`unsupported WAV: ${fmt.channels} channels`);
  if (fmt.format === 1) return { rate: fmt.rate, samples: pcm16(data) };
  if (fmt.format === 17) {
    return { rate: fmt.rate, samples: decodeImaAdpcm(data, fmt.blockAlign) };
  }
  throw new Error(`unsupported WAV format ${fmt.format}`);
}

export function pcm16(bytes) {
  const samples = new Int16Array(bytes.byteLength >> 1);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(i * 2, true);
  return samples;
}

function bitrateFor(rate) {
  if (rate <= 12000) return 32;
  if (rate <= 24000) return 56;
  return 64;
}

// Returns { bytes, rate } at the nearest MP3 rate.
export function encodeMp3(samples, sourceRate) {
  const rate = nearestMp3Rate(sourceRate);
  const pcm = resample(samples, sourceRate, rate);
  const encoder = new Mp3Encoder(1, rate, bitrateFor(rate));
  const parts = [];
  const CHUNK = 1152 * 16;
  for (let i = 0; i < pcm.length; i += CHUNK) {
    const part = encoder.encodeBuffer(pcm.subarray(i, i + CHUNK));
    if (part.length) parts.push(part);
  }
  const tail = encoder.flush();
  if (tail.length) parts.push(tail);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return { bytes: out, rate };
}
