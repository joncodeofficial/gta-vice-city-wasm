# Ideas & Improvements

## Mobile

- [ ] Menu/back button exits fullscreen on mobile (tap menu → `document.exitFullscreen()`)
- [ ] Map the engine's quit/exit action to return to the start screen instead of closing — intercept the exit event from the WASM module and reload or show the setup overlay again

## Features

- [x] Export/import saves — "Saves & skins" panel on the setup screen (see `docs/saves-and-skins-testing.md`)
- [ ] Show the version of the imported game archive
- [ ] Multi-language UI support (translation structure is already in place)

## Dev / Infra

- [ ] Basic Playwright tests — verify SW registration, OPFS writes, and game startup
- [ ] PWA manifest — allow installing the game as an app from the browser
