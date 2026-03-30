# Ideas & Improvements

## UX / Experience
- [ ] Show real-time file size progress during import
- [ ] Loading screen with visual progress while WASM boots (currently there is a delay with no feedback)
- [ ] Detect incompatible browsers early and show a clear message before the user tries to import

## Performance
- [ ] Compress assets with Brotli at extraction time — store compressed in OPFS and decompress when serving
- [ ] Cache the WASM binary in Cache API in addition to OPFS for faster startup

## Mobile
- [ ] Improve touch control layout on small screens
- [ ] Automatic landscape/portrait handling

## Features
- [ ] Export/import saves — currently stored in IndexedDB and lost if the user clears browser storage
- [ ] Show the version of the imported game archive
- [ ] Multi-language UI support (translation structure is already in place)

## Dev / Infra
- [ ] Basic Playwright tests — verify SW registration, OPFS writes, and game startup
- [ ] PWA manifest — allow installing the game as an app from the browser
