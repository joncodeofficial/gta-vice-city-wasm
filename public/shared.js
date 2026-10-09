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
    const BACKUP_STORE = "save-backups";
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

    // Our own database: save backups and imported skins.
    function openUserDataDB() {
        return openDB(USERDATA_DB, USERDATA_VERSION, (db) => {
            if (!db.objectStoreNames.contains(BACKUP_STORE)) {
                db.createObjectStore(BACKUP_STORE, { keyPath: "id", autoIncrement: true });
            }
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

    // Mod sites usually ship skins and saves zipped. Reads the central
    // directory and inflates entries with the browser's DecompressionStream;
    // only stored and deflated, unencrypted entries are supported.
    async function extractZip(file, wanted) {
        const bytes = await readFile(file);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
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
        const decoder = new TextDecoder();
        const files = [];
        for (let n = 0; n < count; n++) {
            if (view.getUint32(p, true) !== 0x02014b50) throw new Error(`${file.name} has a damaged ZIP directory.`);
            const flags = view.getUint16(p + 8, true);
            const method = view.getUint16(p + 10, true);
            const compSize = view.getUint32(p + 20, true);
            const nameLen = view.getUint16(p + 28, true);
            const extraLen = view.getUint16(p + 30, true);
            const commentLen = view.getUint16(p + 32, true);
            const localOffset = view.getUint32(p + 42, true);
            const path = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;

            const name = path.split("/").pop();
            if (!name || path.startsWith("__MACOSX/") || name.startsWith("._") || !wanted.test(name)) continue;
            if (flags & 1) throw new Error(`${path} in ${file.name} is encrypted.`);
            if (method !== 0 && method !== 8) throw new Error(`${path} in ${file.name} uses an unsupported compression method.`);

            const dataStart = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
            const raw = bytes.subarray(dataStart, dataStart + compSize);
            const data = method === 0
                ? raw
                : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
            files.push(new File([data], name));
        }
        return files;
    }

    async function expandZips(files, wanted) {
        const out = [];
        for (const file of files) {
            if (/\.(rar|7z)$/i.test(file.name)) {
                throw new Error(`${file.name}: RAR and 7z archives cannot be opened in the browser. Extract it first (macOS: double-click it or use The Unarchiver; Windows: 7-Zip), then import the files inside.`);
            }
            if (/\.zip$/i.test(file.name)) {
                const inner = await extractZip(file, wanted);
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

    function stamp(d) {
        const p = (n) => String(n).padStart(2, "0");
        return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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

    // ─── Panel: status, lock and drop zones ─────────────────────────

    function setStatus(message, state = "info") {
        const status = document.getElementById("userdata-status");
        if (!status) return;
        status.textContent = message;
        status.dataset.state = state;
        status.hidden = !message;
    }

    function lockPanel() {
        launched = true;
        document.getElementById("userdata-panel")?.setAttribute("data-locked", "1");
    }

    // Wraps a UI action: refuses once the game is running and reports errors
    // in the status line instead of throwing.
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

    window.vcUserData = {
        BACKUP_STORE,
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
        stamp,
        download,
        readFile,
        el,
        ready,
        setStatus,
        lockPanel,
        run,
        bindDropZone,
    };
})();
