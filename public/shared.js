"use strict";

// Logic shared by the save-game (saves.js) and player-skin (skins.js)
// managers: IndexedDB helpers, ZIP reading, small utilities and the panel
// status/lock handling. Publishes everything on window.vcUserData.
//
// Everything here runs before the engine starts. Once the game is running,
// its own IDBFS sync would overwrite changes made behind its back, so the
// panel is locked by skins.js prepareLaunch().
(function () {
    const USERDATA_DB = "vc-userdata";
    const USERDATA_VERSION = 1;
    const SKIN_STORE = "skins";

    let launched = false;

    // ─── IndexedDB helpers ──────────────────────────────────────────

    function reqToPromise(req) {
        return new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function txDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
        });
    }

    function openDB(name, version, upgrade) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(name, version);
            req.onupgradeneeded = (e) => upgrade(req.result, e.target.transaction);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error(`Database "${name}" is in use by another tab. Close other game tabs and try again.`));
        });
    }

    // Our own database: imported skins.
    function openUserDataDB() {
        return openDB(USERDATA_DB, USERDATA_VERSION, (db) => {
            if (!db.objectStoreNames.contains(SKIN_STORE)) {
                db.createObjectStore(SKIN_STORE, { keyPath: "name" });
            }
        });
    }

    async function withDB(open, fn) {
        const db = await open();
        try {
            return await fn(db);
        } finally {
            db.close();
        }
    }

    // ─── ZIP extraction ─────────────────────────────────────────────

    // Limits that keep a hostile or broken archive from exhausting memory.
    const ZIP_MAX_ENTRY = 16 * 1024 * 1024;
    const ZIP_MAX_TOTAL = 64 * 1024 * 1024;
    const ZIP_MAX_FILES = 64;

    // Inflates a raw deflate stream, aborting as soon as the output passes
    // `limit`. The size a ZIP declares can lie, so only the real output counts.
    async function inflateLimited(raw, limit, label) {
        const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (total > limit) {
                await reader.cancel();
                throw new Error(`${label} is larger than ${formatSize(limit)} once extracted.`);
            }
            chunks.push(value);
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }

    // Mod sites usually ship skins and saves zipped. Reads the central
    // directory and inflates entries with the browser's DecompressionStream;
    // only stored and deflated, unencrypted, non-ZIP64 entries are supported.
    // Each extracted file is capped at `limit` bytes.
    async function extractZip(file, wanted, limit = ZIP_MAX_ENTRY) {
        const bytes = await readFile(file);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const damaged = () => new Error(`${file.name} is damaged or not a valid ZIP archive.`);
        // Every read below goes through here so a bad offset is a clear error
        // instead of a RangeError.
        const within = (pos, len) => {
            if (pos < 0 || len < 0 || pos + len > bytes.length) throw damaged();
        };

        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
            if (view.getUint32(i, true) === 0x06054b50) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) throw new Error(`${file.name} is not a valid ZIP archive.`);
        const count = view.getUint16(eocd + 10, true);
        let p = view.getUint32(eocd + 16, true);
        if (count === 0xffff || p === 0xffffffff) throw new Error(`${file.name} is a ZIP64 archive, which is not supported.`);

        const decoder = new TextDecoder();
        const files = [];
        let totalSize = 0;
        for (let n = 0; n < count; n++) {
            within(p, 46);
            if (view.getUint32(p, true) !== 0x02014b50) throw damaged();
            const flags = view.getUint16(p + 8, true);
            const method = view.getUint16(p + 10, true);
            const compSize = view.getUint32(p + 20, true);
            const uncompSize = view.getUint32(p + 24, true);
            const nameLen = view.getUint16(p + 28, true);
            const extraLen = view.getUint16(p + 30, true);
            const commentLen = view.getUint16(p + 32, true);
            const localOffset = view.getUint32(p + 42, true);
            within(p + 46, nameLen);
            const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;

            const name = path.split("/").pop();
            if (!name || path.startsWith("__MACOSX/") || name.startsWith("._") || !wanted.test(name)) continue;
            if (flags & 1) throw new Error(`${path} in ${file.name} is encrypted.`);
            if (method !== 0 && method !== 8) throw new Error(`${path} in ${file.name} uses an unsupported compression method.`);
            if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
                throw new Error(`${path} in ${file.name} needs ZIP64, which is not supported.`);
            }
            if (files.length >= ZIP_MAX_FILES) throw new Error(`${file.name} has more than ${ZIP_MAX_FILES} matching files.`);
            // Cheap early rejection; the streamed check below is the real one.
            if (uncompSize > limit) throw new Error(`${path} in ${file.name} is larger than ${formatSize(limit)} once extracted.`);

            within(localOffset, 30);
            if (view.getUint32(localOffset, true) !== 0x04034b50) throw damaged();
            const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
            within(dataStart, compSize);
            const raw = bytes.subarray(dataStart, dataStart + compSize);

            let data;
            if (method === 0) {
                if (raw.length > limit) throw new Error(`${path} in ${file.name} is larger than ${formatSize(limit)}.`);
                data = raw;
            } else {
                data = await inflateLimited(raw, limit, `${path} in ${file.name}`);
            }
            totalSize += data.length;
            if (totalSize > ZIP_MAX_TOTAL) throw new Error(`${file.name} is larger than ${formatSize(ZIP_MAX_TOTAL)} once extracted.`);
            files.push(new File([data], name));
        }
        return files;
    }

    async function expandZips(files, wanted, limit) {
        const out = [];
        for (const file of files) {
            if (/\.(rar|7z)$/i.test(file.name)) {
                throw new Error(`${file.name}: RAR and 7z archives cannot be opened in the browser. Extract it first (macOS: double-click it or use The Unarchiver; Windows: 7-Zip), then import the files inside.`);
            }
            if (/\.zip$/i.test(file.name)) {
                const inner = await extractZip(file, wanted, limit);
                if (!inner.length) throw new Error(`${file.name} contains no usable files.`);
                out.push(...inner);
            } else {
                out.push(file);
            }
        }
        return out;
    }

    // ─── Utilities ──────────────────────────────────────────────────

    function equalBytes(a, b) {
        if (!a || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    function formatSize(n) {
        return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
    }

    function formatDate(d) {
        return d instanceof Date ? d.toLocaleString() : "unknown date";
    }

    function download(bytes, fileName) {
        const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    async function readFile(file) {
        return new Uint8Array(await file.arrayBuffer());
    }

    function el(tag, attrs, ...children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (k === "onclick") node.addEventListener("click", v);
            else if (k === "className") node.className = v;
            else node.setAttribute(k, v);
        }
        node.append(...children);
        return node;
    }

    function ready(fn) {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", fn);
        } else {
            fn();
        }
    }

    // ─── Panels: status, lock and drop zones ────────────────────────

    // Each panel (saves, skins) has its own status line; a UI action that
    // fails reports in the panel it belongs to.
    function createPanel(statusId) {
        function setStatus(message, state = "info") {
            const status = document.getElementById(statusId);
            if (!status) return;
            status.textContent = message;
            status.dataset.state = state;
            status.hidden = !message;
        }

        // Wraps a UI action: refuses once the game is running and reports
        // errors in the status line instead of throwing.
        const run = (fn) => async (...args) => {
            if (launched) {
                setStatus("The game is already running. Reload the page to manage saves and skins.", "error");
                return;
            }
            try {
                await fn(...args);
            } catch (err) {
                console.error("[userdata]", err);
                setStatus(`Error: ${err && err.message ? err.message : err}`, "error");
            }
        };

        function bindDropZone(zone, handler) {
            zone.addEventListener("dragover", (e) => {
                e.preventDefault();
                zone.dataset.dragging = "1";
            });
            zone.addEventListener("dragleave", () => delete zone.dataset.dragging);
            zone.addEventListener("drop", (e) => {
                e.preventDefault();
                delete zone.dataset.dragging;
                run(handler)([...e.dataTransfer.files]);
            });
        }

        return { setStatus, run, bindDropZone };
    }

    function lockPanels() {
        launched = true;
        document.querySelectorAll(".userdata-panel").forEach((panel) => panel.setAttribute("data-locked", "1"));
    }

    window.vcUserData = {
        SKIN_STORE,
        reqToPromise,
        txDone,
        openDB,
        openUserDataDB,
        withDB,
        expandZips,
        equalBytes,
        formatSize,
        formatDate,
        download,
        readFile,
        el,
        ready,
        createPanel,
        lockPanels,
    };
})();
