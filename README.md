# GTA: Vice City — WASM Port

**Live:** [joncodeofficial.github.io/gta-vice-city-wasm](https://joncodeofficial.github.io/gta-vice-city-wasm/)

A **local-first** browser port of Grand Theft Auto: Vice City. Import your own `game.tar.gz` once — it gets extracted and stored directly in your browser via OPFS. From that point on, the game runs entirely from your device with no CDN, no external server, and no recurring downloads.

This is a different approach from the original DOS Zone port, which streams game assets from a remote CDN. Here, a Service Worker intercepts all game file requests and serves them from local OPFS storage — meaning it works offline after the first import.

## How it works

1. Download `game.tar.gz` from the [latest release](https://github.com/joncodeofficial/gta-vice-city-wasm/releases/latest)
2. Open the [live page](https://joncodeofficial.github.io/gta-vice-city-wasm/) and click **Select game.tar.gz** to import the file
3. The archive is extracted into your browser's local storage (OPFS) — this only happens once
4. Click **Click to play** and the game loads entirely from your device

Your imported data persists between sessions so you only need to import once unless you clear browser storage.

## Requirements

- A modern desktop browser with WebAssembly + OPFS + Service Worker support
- Recommended: Chrome 110+, Firefox 111+, or Safari 16.4+
- The `game.tar.gz` game archive (~668 MB compressed)

## Running locally

```bash
pnpm install
pnpm dev
```

Then open `http://localhost:5173`.

## Tech stack

- **Vite** — dev server and build tool
- **WebAssembly** — game engine compiled from C++ via Emscripten
- **OPFS** (Origin Private File System) — stores extracted game data locally in the browser
- **Service Worker** — intercepts fetch requests to serve game files from OPFS
- **Web Worker** — extracts the `.tar.gz` archive off the main thread

## Credits

**Browser client port** (OPFS storage, Service Worker, import UI, GitHub Pages deploy):
[@joncodeofficial](https://github.com/joncodeofficial)

**Based on** [reVCDOS](https://github.com/Lolendor/reVCDOS) by [@Lolendor](https://github.com/Lolendor)

**WASM engine port** by the DOS Zone team:
- [@specialist003](https://github.com/okhmanyuk-ev)
- [@caiiiycuk](https://www.youtube.com/caiiiycuk)
- [@SerGen](https://t.me/ser_var)

The game engine is based on the open-source reverse engineering project [re3/reVC](https://github.com/SugaryHull/re3/tree/miami).

## Disclaimer

This is not a commercial release and is not affiliated with Rockstar Games or Take-Two Interactive. It is built on an open-source reimplementation of the game engine. You must own a legitimate copy of GTA: Vice City to use this software.
