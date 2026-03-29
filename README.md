# GTA: Vice City — WASM Port

A browser-based port of Grand Theft Auto: Vice City built on the open-source re3/reVC engine, compiled to WebAssembly. Import your own game archive once and play locally — no server required, no launcher, no install.

## How it works

1. Download or locate your `game.tar.gz` archive
2. Open the page and click **Select game.tar.gz** to import the file
3. The archive is extracted into your browser's local storage (OPFS) — this only happens once
4. Click **Click to play** and the game loads entirely from your device

Your imported data persists between sessions so you only need to import once unless you clear browser storage.

## Requirements

- A modern desktop browser with WebAssembly + OPFS + Service Worker support
- Recommended: Chrome 110+, Firefox 111+, or Safari 16.4+
- The `game.tar.gz` game archive (~130 MB compressed)

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

This project is based on the HTML5 port created by the **DOS Zone** team:

- [@specialist003](https://github.com/okhmanyuk-ev)
- [@caiiiycuk](https://www.youtube.com/caiiiycuk)
- [@SerGen](https://t.me/ser_var)

Deobfuscated by [@Lolendor](https://github.com/Lolendor) — original repo: [reVCDOS](https://github.com/Lolendor/reVCDOS)

The game engine is based on the open-source reverse engineering project [re3/reVC](https://github.com/SugaryHull/re3/tree/miami).

## Disclaimer

This is not a commercial release and is not affiliated with Rockstar Games or Take-Two Interactive. It is built on an open-source reimplementation of the game engine. You must own a legitimate copy of GTA: Vice City to use this software.
