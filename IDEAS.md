# Ideas & Improvements

## Performance

- [ ] Compress assets with Brotli at extraction time — store compressed in OPFS and decompress when serving

## Features

- [ ] Export/import saves — currently stored in IndexedDB and lost if the user clears browser storage
- [ ] Show the version of the imported game archive
- [ ] Multi-language UI support (translation structure is already in place)

## Dev / Infra

- [ ] Basic Playwright tests — verify SW registration, OPFS writes, and game startup
- [ ] PWA manifest — allow installing the game as an app from the browser
