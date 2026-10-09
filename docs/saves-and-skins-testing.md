# Saves & skins — test plan

Manual test plan for the "Saves & skins" panel (`public/mods.js`). Run it with
`pnpm dev` in Chrome after importing `game.tar.gz` once.

## How it works (facts the tests rely on)

- The engine mounts IDBFS at `/vc-assets/local/userfiles` (confirmed at runtime
  via `FS` mounts) and loads saves from `GTAVCsf1.b` … `GTAVCsf8.b` there.
- IDBFS stores each file in the IndexedDB database `/vc-assets/local/userfiles`
  (version 21), store `FILE_DATA`, key = full path, value =
  `{ timestamp: Date, mode: 0o100666, contents: Uint8Array }`.
- A GTA VC PC save ends with a little-endian uint32 sum of all preceding bytes.
  Real PC saves tested were 201,828 bytes; the save name is 24 UTF-16 chars at
  offset 4.
- Skins are copied into `/vc-assets/local/skins/<name>.bmp` in `Module.preRun`.
  The engine lists them in Options → Player Skin Setup.
- The engine reads `SkinFile=<name>` from `revc.ini` at startup but never writes
  it back, and only applies the skin to the player when Player Skin Setup is
  closed. The panel's "Skin at startup" writes `SkinFile` in `game.js`
  `mainCalled` via `vcMods.applyIniOverrides`.
- Backups and imported skins live in the `vc-mods` database. "Reset game data"
  deletes every IndexedDB database, including these.

## Fixtures

- Valid saves: any PC `GTAVCsf*.b`, e.g. a 100% save pack. RAR/7z packs must be
  extracted first.
- Skins: 8-bit and 24-bit 256×256 BMPs, a PNG or JPG, and a `.zip` with a BMP inside.
- Invalid: a save with one byte flipped, a 10-byte file, a `.rar`.

## Cases

Status: **Pass** = run and observed on 2026-10-09 (Chrome, macOS, dev server);
**Not run** = not executed yet.

| # | Case | Steps | Expected | Status |
|---|------|-------|----------|--------|
| S1 | Import valid save into empty slot | Pick `GTAVCsf1.b` | Shows save name, slot 1 preselected from the file name; Import writes it; slot list shows the name | Pass |
| S2 | Reject corrupted save | Pick a save with one byte changed | "Checksum mismatch" error, Import disabled | Pass |
| S3 | Reject non-save / archive | Pick a 10-byte file; pick a `.rar` | "too small" error; RAR error tells the user to extract first | Pass |
| S4 | Replace occupied slot keeps a backup | Import a different save into slot 1 | Summary warns before Import; old save appears under Backups | Pass |
| S5 | Stored bytes are exact | Compare IndexedDB contents with the source file (SHA-256) | Identical; mode `100666`, timestamp is a `Date` | Pass |
| S6 | Export slot | Export slot 2 | Downloads `GTAVCsf2.b`, identical to the imported file | Pass (download captured in page, not saved to disk) |
| S7 | Restore backup | Restore the slot 1 backup | Slot 1 holds the original again; the save it replaced becomes a new backup | Pass |
| S8 | Export backup | Export a backup | `GTAVCsfN-backup-YYYYMMDD-HHMMSS.b` | Pass (captured in page) |
| S9 | Game lists imported saves | Start → Start Game → Load Game | Both slots shown with in-game names and dates; others "Not Present" | Pass |
| S10 | Load imported 100% save | Load slot 1 | Game loads: $999,999,999, 200 HP / 200 armour, 100/100 packages | Pass |
| S11 | Load imported 99% save | Load slot 2 | Game loads: 150 HP / 150 armour | Pass |
| S12 | Engine sync keeps imported saves | While running, `FS.syncfs(false)` | Both saves still in IndexedDB; backups and skins untouched | Pass |
| S13 | Saves persist after refresh | Reload page | Slots, backups and skins listed unchanged | Pass |
| S14 | Saving in game over an imported slot | Save at a safehouse into slot 1, reload, load it | New save loads; panel shows the new timestamp | Not run |
| S15 | Import while game is running | Start the game, try to use the panel | Panel is hidden or locked; no writes | Pass by design (panel is hidden on Start), not explicitly exercised |
| K1 | Import skins from ZIP | Pick two gta.cz skin zips (8-bit BMP inside) | Both imported, converted to 24-bit | Pass |
| K2 | Lossless conversion | Compare converted pixels with an independent palette decode | Identical pixel data (SHA-256) | Pass |
| K3 | Skins visible in game | Options → Player Skin Setup | Imported skins listed with spaces for underscores; preview shows the texture | Pass |
| K4 | Apply skin in menu | Select a skin, Enter | Tommy wears it in game | Pass (Spiderman) |
| K5 | Switch skin mid-game without crash | Pause → Options → Player Skin Setup → another skin | New skin applied, game keeps running | Pass (default → Spiderman); Spiderman → Batman applied in the menu without crash, not re-checked in game |
| K6 | Startup skin survives refresh | Pick "Skin at startup", reload, start, open and leave Player Skin Setup | Skin pre-selected (yellow), Tommy wears it after leaving the menu | Pass (Batman and Spiderman) |
| K7 | Startup skin removed | Remove the selected skin, start game | Default skin used, no error | Logic unit-tested (`applyIniOverrides` falls back to `$$""`); not run in game |
| K8 | PNG/JPG skin | Import a PNG or JPG | Scaled to 256×256 24-bit BMP and usable in game | Not run |
| K9 | Invalid BMP validation | 32-bit, 512×512, RLE, top-down BMPs | Re-encoded through the converter | Validator unit-tested; conversion not run in game |

## Known limitations

- RAR/7z archives cannot be opened in the browser; users must extract them.
- Only GTA Vice City **PC** saves work (mobile, console and Definitive Edition
  saves fail the checksum check).
- Skins are textures for the street outfit only; new 3D models are not possible
  without rebuilding the engine.
- A skin picked in game is lost on reload; use "Skin at startup" instead.
- The skin only goes on after Player Skin Setup has been opened and closed once
  per session (engine behaviour).
