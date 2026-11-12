// OPFS layout of an import. public/game.js and sw.js repeat these paths.

// Bump when the layout changes, to force a new import.
export const OPFS_VERSION = "v5";
export const READY_MARKER = "_game_ready";

export const PACKAGE_DATA = "vcbr/vc-sky-en-v6.data";
export const PACKAGE_INDEX = "vcbr/vc-sky-en-v6.json";
export const FETCHED_DIR = "vcsky/fetched";

export const GAME_ENTRIES = [
  ...new Set([READY_MARKER, PACKAGE_DATA, PACKAGE_INDEX, FETCHED_DIR].map((p) => p.split("/")[0])),
];
export const IMPORT_TMP = "_import_tmp";
// How far an interrupted import got, to resume it.
export const IMPORT_JOURNAL = "_import_journal";

// Byte ranges of each file in PACKAGE_DATA, as the loader reads them.
export function createPackageIndex() {
  const files = [];
  let size = 0;
  return {
    // Returns the start offset.
    add(path, length) {
      const start = size;
      files.push({ filename: `/vc-assets/local/${path}`, start, end: start + length });
      size += length;
      return start;
    },
    get count() {
      return files.length;
    },
    toJSON: () => ({ files, remote_package_size: size }),
  };
}
