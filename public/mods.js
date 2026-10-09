"use strict";

// Save-game and player-skin manager.
//
// Saves: the engine mounts IDBFS at SAVE_DIR and populates it from IndexedDB
// when it starts (asm_consts/en.js: FS.mount(IDBFS) + FS.syncfs(true)). IDBFS
// keeps one database per mount point, named after the mount path, with every
// file stored in FILE_DATA as { timestamp, mode, contents } keyed by its full
// path (modules/fs.js). Writing a record in that format before the game
// starts is therefore enough for the engine to see it as a normal save.
//
// Skins: the engine enumerates skins/*.bmp (24-bit, uncompressed, 256x256)
// from /vc-assets/local/skins, which is in-memory only. Imported skins are
// kept in our own database and copied into that directory in Module.preRun.
//
// Everything here runs before the engine starts. Once the game is running,
// its own IDBFS sync would overwrite changes made behind its back, so the
// panel is locked by prepareLaunch().
(function () {
    const SAVE_DIR = "/vc-assets/local/userfiles";
    const SKIN_DIR = "/vc-assets/local/skins";
    const SAVE_SLOTS = 8;
    const saveKey = (slot) => `${SAVE_DIR}/GTAVCsf${slot}.b`;

    // Must match IDBFS in modules/fs.js, otherwise opening the database
    // would trigger a version change the engine does not expect.
    const IDBFS_VERSION = 21;
    const IDBFS_STORE = "FILE_DATA";
    const FILE_MODE = 0o100666; // S_IFREG | rw-rw-rw-

    const MODS_DB = "vc-mods";
    const MODS_VERSION = 1;
    const BACKUP_STORE = "save-backups";
    const SKIN_STORE = "skins";

    const SAVE_MIN_SIZE = 1024;
    const SAVE_MAX_SIZE = 4 * 1024 * 1024;
    const SKIN_SIZE = 256;
    const SKIN_MAX_FILE = 16 * 1024 * 1024;

    let launched = false;
    let launchSkins = [];

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

    // Same schema IDBFS.getDB creates, so it is safe if the game never ran.
    function openSaveDB() {
        return openDB(SAVE_DIR, IDBFS_VERSION, (db, tx) => {
            const store = db.objectStoreNames.contains(IDBFS_STORE)
                ? tx.objectStore(IDBFS_STORE)
                : db.createObjectStore(IDBFS_STORE);
            if (!store.indexNames.contains("timestamp")) {
                store.createIndex("timestamp", "timestamp", { unique: false });
            }
        });
    }

    function openModsDB() {
        return openDB(MODS_DB, MODS_VERSION, (db) => {
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

    // ─── Saves ──────────────────────────────────────────────────────

    // GTA VC PC saves end with a 32-bit little-endian sum of every
    // preceding byte; the engine rejects the file if it does not match.
    function validateSave(bytes) {
        if (bytes.length < SAVE_MIN_SIZE) {
            return `File is too small (${bytes.length} bytes) to be a GTA Vice City save.`;
        }
        if (bytes.length > SAVE_MAX_SIZE) {
            return `File is too large (${formatSize(bytes.length)}) to be a GTA Vice City save.`;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const firstBlock = view.getUint32(0, true);
        if (firstBlock === 0 || firstBlock >= bytes.length) {
            return "File does not start with a valid save block. It is not a GTA Vice City PC save.";
        }
        let sum = 0;
        const end = bytes.length - 4;
        for (let i = 0; i < end; i++) sum = (sum + bytes[i]) >>> 0;
        const stored = view.getUint32(end, true);
        if (sum !== stored) {
            return "Checksum mismatch: the file is corrupted, or it is not a GTA Vice City PC save (mobile, console and Definitive Edition saves are not compatible).";
        }
        return null;
    }

    // The first block starts with the save's display name as 24 UTF-16 chars.
    function saveName(bytes) {
        if (!bytes || bytes.length < 52) return "";
        const chars = new Uint16Array(bytes.slice(4, 52).buffer);
        const end = chars.indexOf(0);
        return String.fromCharCode(...(end < 0 ? chars : chars.subarray(0, end))).trim();
    }

    async function readSlots() {
        return withDB(openSaveDB, async (db) => {
            const store = db.transaction(IDBFS_STORE, "readonly").objectStore(IDBFS_STORE);
            const slots = [];
            for (let slot = 1; slot <= SAVE_SLOTS; slot++) {
                slots.push({ slot, entry: await reqToPromise(store.get(saveKey(slot))) });
            }
            return slots;
        });
    }

    async function backupEntry(slot, entry, reason) {
        await withDB(openModsDB, async (db) => {
            const tx = db.transaction(BACKUP_STORE, "readwrite");
            tx.objectStore(BACKUP_STORE).add({
                slot,
                contents: entry.contents,
                savedAt: entry.timestamp,
                backedUpAt: new Date(),
                reason,
            });
            await txDone(tx);
        });
    }

    // Backs up whatever is in the slot, then writes the new contents and
    // reads them back to confirm the write.
    async function writeSlot(slot, bytes, reason) {
        const key = saveKey(slot);
        const existing = await withDB(openSaveDB, (db) =>
            reqToPromise(db.transaction(IDBFS_STORE, "readonly").objectStore(IDBFS_STORE).get(key)));
        if (existing && existing.contents) {
            await backupEntry(slot, existing, reason);
        }
        await withDB(openSaveDB, async (db) => {
            const tx = db.transaction(IDBFS_STORE, "readwrite");
            tx.objectStore(IDBFS_STORE).put({
                timestamp: new Date(),
                mode: FILE_MODE,
                contents: new Uint8Array(bytes),
            }, key);
            await txDone(tx);
        });
        const written = await withDB(openSaveDB, (db) =>
            reqToPromise(db.transaction(IDBFS_STORE, "readonly").objectStore(IDBFS_STORE).get(key)));
        if (!written || !equalBytes(written.contents, bytes)) {
            throw new Error("The save was written but could not be read back. Browser storage may be full.");
        }
        return Boolean(existing);
    }

    async function listBackups() {
        return withDB(openModsDB, async (db) => {
            const all = await reqToPromise(db.transaction(BACKUP_STORE, "readonly").objectStore(BACKUP_STORE).getAll());
            return all.sort((a, b) => b.backedUpAt - a.backedUpAt);
        });
    }

    async function getBackup(id) {
        return withDB(openModsDB, (db) =>
            reqToPromise(db.transaction(BACKUP_STORE, "readonly").objectStore(BACKUP_STORE).get(id)));
    }

    async function deleteBackup(id) {
        await withDB(openModsDB, async (db) => {
            const tx = db.transaction(BACKUP_STORE, "readwrite");
            tx.objectStore(BACKUP_STORE).delete(id);
            await txDone(tx);
        });
    }

    // ─── Skins ──────────────────────────────────────────────────────

    function validateBmp(bytes) {
        if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return "not a BMP file";
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const dataOffset = view.getUint32(10, true);
        const headerSize = view.getUint32(14, true);
        if (headerSize < 40) return "unsupported BMP header";
        const width = view.getInt32(18, true);
        const height = view.getInt32(22, true);
        const bpp = view.getUint16(28, true);
        const compression = view.getUint32(30, true);
        if (height === -SKIN_SIZE) return "top-down row order";
        if (width !== SKIN_SIZE || height !== SKIN_SIZE) return `${width}x${Math.abs(height)}, needs ${SKIN_SIZE}x${SKIN_SIZE}`;
        if (bpp !== 24) return `${bpp}-bit, needs 24-bit`;
        if (compression !== 0) return "compressed, needs uncompressed";
        if (dataOffset + SKIN_SIZE * SKIN_SIZE * 3 > bytes.length) return "file is truncated";
        return null;
    }

    // Decodes an uncompressed 256x256 8/24/32-bit BMP to bottom-up BGR rows
    // without going through a canvas, which rounds some palette colours.
    // Returns null for anything else.
    function decodeSkinSizedBmp(bytes) {
        if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const dataOffset = view.getUint32(10, true);
        const headerSize = view.getUint32(14, true);
        const width = view.getInt32(18, true);
        const height = view.getInt32(22, true);
        const bpp = view.getUint16(28, true);
        if (headerSize < 40 || view.getUint32(30, true) !== 0) return null;
        if (width !== SKIN_SIZE || Math.abs(height) !== SKIN_SIZE || ![8, 24, 32].includes(bpp)) return null;
        const rowSize = Math.ceil((SKIN_SIZE * bpp) / 32) * 4;
        if (dataOffset + rowSize * SKIN_SIZE > bytes.length) return null;
        let palette = null;
        if (bpp === 8) {
            const colors = view.getUint32(46, true) || 256;
            palette = bytes.subarray(14 + headerSize, 14 + headerSize + colors * 4);
            if (palette.length < colors * 4) return null;
        }
        const out = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 3);
        let dst = 0;
        for (let y = 0; y < SKIN_SIZE; y++) {
            const row = dataOffset + (height > 0 ? y : SKIN_SIZE - 1 - y) * rowSize;
            for (let x = 0; x < SKIN_SIZE; x++) {
                const p = palette ? bytes[row + x] * 4 : row + x * (bpp / 8);
                const src = palette || bytes;
                if (palette && p + 2 >= palette.length) return null;
                out[dst++] = src[p];
                out[dst++] = src[p + 1];
                out[dst++] = src[p + 2];
            }
        }
        return out;
    }

    async function decodeWithCanvas(file) {
        let bitmap;
        try {
            bitmap = await createImageBitmap(file);
        } catch {
            throw new Error("The browser could not decode this image.");
        }
        const canvas = document.createElement("canvas");
        canvas.width = SKIN_SIZE;
        canvas.height = SKIN_SIZE;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, SKIN_SIZE, SKIN_SIZE);
        ctx.drawImage(bitmap, 0, 0, SKIN_SIZE, SKIN_SIZE);
        bitmap.close();
        const rgba = ctx.getImageData(0, 0, SKIN_SIZE, SKIN_SIZE).data;
        const out = new Uint8Array(SKIN_SIZE * SKIN_SIZE * 3);
        let dst = 0;
        for (let y = SKIN_SIZE - 1; y >= 0; y--) {
            for (let x = 0; x < SKIN_SIZE; x++) {
                const p = (y * SKIN_SIZE + x) * 4;
                out[dst++] = rgba[p + 2];
                out[dst++] = rgba[p + 1];
                out[dst++] = rgba[p];
            }
        }
        return out;
    }

    // Re-encodes an image as a 24-bit bottom-up 256x256 BMP: losslessly for
    // uncompressed 256x256 BMPs, through a canvas (scaled) for anything else.
    async function convertToSkinBmp(file, bytes) {
        const pixels = decodeSkinSizedBmp(bytes) || await decodeWithCanvas(file);
        const imageSize = pixels.length; // rows of 768 bytes need no padding
        const out = new Uint8Array(54 + imageSize);
        const view = new DataView(out.buffer);
        out[0] = 0x42;
        out[1] = 0x4d;
        view.setUint32(2, out.length, true);
        view.setUint32(10, 54, true);
        view.setUint32(14, 40, true);
        view.setInt32(18, SKIN_SIZE, true);
        view.setInt32(22, SKIN_SIZE, true);
        view.setUint16(26, 1, true);
        view.setUint16(28, 24, true);
        view.setUint32(34, imageSize, true);
        view.setInt32(38, 2835, true);
        view.setInt32(42, 2835, true);
        out.set(pixels, 54);
        return out;
    }

    // The engine matches skins\*.bmp and stores the chosen name in revc.ini,
    // so keep names to a conservative character set with a lower-case ".bmp".
    function skinNameFromFile(fileName) {
        const base = fileName.replace(/\.[^.]*$/, "");
        return base.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    }

    async function listSkins() {
        return withDB(openModsDB, async (db) => {
            const all = await reqToPromise(db.transaction(SKIN_STORE, "readonly").objectStore(SKIN_STORE).getAll());
            return all.sort((a, b) => a.name.localeCompare(b.name));
        });
    }

    async function putSkin(skin) {
        await withDB(openModsDB, async (db) => {
            const tx = db.transaction(SKIN_STORE, "readwrite");
            tx.objectStore(SKIN_STORE).put(skin);
            await txDone(tx);
        });
    }

    async function deleteSkin(name) {
        await withDB(openModsDB, async (db) => {
            const tx = db.transaction(SKIN_STORE, "readwrite");
            tx.objectStore(SKIN_STORE).delete(name);
            await txDone(tx);
        });
    }

    // ─── Launch hooks (called from game.js) ─────────────────────────

    async function prepareLaunch() {
        launched = true;
        document.getElementById("mods-panel")?.setAttribute("data-locked", "1");
        try {
            launchSkins = await listSkins();
        } catch (err) {
            console.error("[mods] could not read skins:", err);
            launchSkins = [];
        }
    }

    function installIntoFS(FS) {
        if (!launchSkins.length) return;
        FS.createPath("/", SKIN_DIR.slice(1), true, true);
        for (const skin of launchSkins) {
            try {
                FS.writeFile(`${SKIN_DIR}/${skin.name}.bmp`, skin.contents);
            } catch (err) {
                console.error(`[mods] could not install skin ${skin.name}:`, err);
            }
        }
        console.log(`[mods] installed ${launchSkins.length} skin(s) into ${SKIN_DIR}`);
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

    // ─── UI ─────────────────────────────────────────────────────────

    function initUI() {
        const panel = document.getElementById("mods-panel");
        if (!panel) return;

        const status = document.getElementById("mods-status");
        const slotList = document.getElementById("save-slot-list");
        const saveInput = document.getElementById("save-file-input");
        const saveDrop = document.getElementById("save-drop");
        const saveFileName = document.getElementById("save-file-name");
        const slotSelect = document.getElementById("save-slot-select");
        const saveSummary = document.getElementById("save-import-summary");
        const saveImportBtn = document.getElementById("save-import-btn");
        const backupList = document.getElementById("save-backup-list");
        const backupCount = document.getElementById("save-backup-count");
        const skinList = document.getElementById("skin-list");
        const skinInput = document.getElementById("skin-file-input");
        const skinDrop = document.getElementById("skin-drop");

        let slots = [];
        let pendingSave = null; // { name, bytes }

        const setStatus = (message, state = "info") => {
            status.textContent = message;
            status.dataset.state = state;
            status.hidden = !message;
        };

        const guard = () => {
            if (!launched) return true;
            setStatus("The game is already running. Reload the page to manage saves and skins.", "error");
            return false;
        };

        const run = (fn) => async (...args) => {
            if (!guard()) return;
            try {
                await fn(...args);
            } catch (err) {
                console.error("[mods]", err);
                setStatus(`Error: ${err && err.message ? err.message : err}`, "error");
            }
        };

        async function refreshSlots() {
            slots = await readSlots();
            slotList.replaceChildren(...slots.map(({ slot, entry }) => {
                const info = entry && entry.contents
                    ? `${saveName(entry.contents) || "Unnamed save"} · ${formatDate(entry.timestamp)}`
                    : "Empty";
                const exportBtn = el("button", { type: "button", className: "mods-btn", onclick: run(() => exportSlot(slot)) }, "Export");
                if (!entry) exportBtn.disabled = true;
                return el("li", { className: "mods-row" },
                    el("span", { className: "mods-row-title" }, `Slot ${slot}`),
                    el("span", { className: "mods-row-info" }, info),
                    exportBtn);
            }));
            updateSaveSummary();
        }

        async function refreshBackups() {
            const backups = await listBackups();
            backupCount.textContent = String(backups.length);
            if (!backups.length) {
                backupList.replaceChildren(el("li", { className: "mods-empty" }, "No backups yet. A backup is made automatically whenever a slot is replaced."));
                return;
            }
            backupList.replaceChildren(...backups.map((b) => el("li", { className: "mods-row" },
                el("span", { className: "mods-row-title" }, `Slot ${b.slot}`),
                el("span", { className: "mods-row-info" }, `${saveName(b.contents) || "Unnamed save"} · backed up ${formatDate(b.backedUpAt)}`),
                el("span", { className: "mods-row-actions" },
                    el("button", { type: "button", className: "mods-btn", onclick: run(() => exportBackup(b.id)) }, "Export"),
                    el("button", { type: "button", className: "mods-btn", onclick: run(() => restoreBackup(b.id)) }, "Restore"),
                    el("button", { type: "button", className: "mods-btn mods-btn-danger", onclick: run(() => removeBackup(b.id)) }, "Delete")))));
        }

        async function refreshSkins() {
            const skins = await listSkins();
            if (!skins.length) {
                skinList.replaceChildren(el("li", { className: "mods-empty" }, "No custom skins imported."));
                return;
            }
            skinList.replaceChildren(...skins.map((s) => el("li", { className: "mods-row" },
                el("span", { className: "mods-row-title" }, s.name),
                el("span", { className: "mods-row-info" }, s.converted ? `converted from ${s.sourceName}` : formatSize(s.contents.length)),
                el("span", { className: "mods-row-actions" },
                    el("button", { type: "button", className: "mods-btn", onclick: run(() => download(s.contents, `${s.name}.bmp`)) }, "Export"),
                    el("button", { type: "button", className: "mods-btn mods-btn-danger", onclick: run(() => removeSkin(s.name)) }, "Remove")))));
        }

        function updateSaveSummary() {
            if (!pendingSave) {
                saveSummary.textContent = "";
                saveImportBtn.disabled = true;
                return;
            }
            const slot = Number(slotSelect.value);
            const current = slots.find((s) => s.slot === slot);
            saveSummary.textContent = current && current.entry
                ? `Slot ${slot} already has "${saveName(current.entry.contents) || "Unnamed save"}". It will be backed up, then replaced.`
                : `Slot ${slot} is empty.`;
            saveImportBtn.disabled = false;
        }

        async function selectSaveFile(picked) {
            pendingSave = null;
            saveFileName.textContent = picked.name;
            const saves = await expandZips([picked], /\.b$/i);
            if (saves.length !== 1) {
                updateSaveSummary();
                setStatus(`${picked.name} contains ${saves.length} saves (${saves.map((f) => f.name).join(", ")}). Extract it and import one file at a time.`, "error");
                return;
            }
            const file = saves[0];
            const bytes = await readFile(file);
            const error = validateSave(bytes);
            if (error) {
                updateSaveSummary();
                setStatus(`${file.name}: ${error}`, "error");
                return;
            }
            pendingSave = { name: file.name, bytes };
            const match = /GTAVCsf([1-8])\.b$/i.exec(file.name);
            const firstEmpty = slots.find((s) => !s.entry);
            slotSelect.value = String(match ? match[1] : firstEmpty ? firstEmpty.slot : 1);
            updateSaveSummary();
            setStatus(`${file.name} is a valid save: "${saveName(bytes) || "Unnamed save"}". Choose a slot and press Import.`, "ok");
        }

        async function importPendingSave() {
            if (!pendingSave) return;
            const slot = Number(slotSelect.value);
            if (!(slot >= 1 && slot <= SAVE_SLOTS)) throw new Error("Choose a slot from 1 to 8.");
            const replaced = await writeSlot(slot, pendingSave.bytes, `replaced by import of ${pendingSave.name}`);
            setStatus(`Imported ${pendingSave.name} into slot ${slot}${replaced ? " (previous save backed up)" : ""}. Start the game and use Load Game.`, "ok");
            pendingSave = null;
            saveFileName.textContent = "Choose or drop a .b or .zip save file";
            saveInput.value = "";
            await Promise.all([refreshSlots(), refreshBackups()]);
        }

        async function exportSlot(slot) {
            const entry = slots.find((s) => s.slot === slot)?.entry;
            if (!entry || !entry.contents) throw new Error(`Slot ${slot} is empty.`);
            download(entry.contents, `GTAVCsf${slot}.b`);
            setStatus(`Exported slot ${slot} as GTAVCsf${slot}.b.`, "ok");
        }

        async function exportBackup(id) {
            const b = await getBackup(id);
            if (!b) throw new Error("Backup not found.");
            download(b.contents, `GTAVCsf${b.slot}-backup-${stamp(b.backedUpAt)}.b`);
        }

        async function restoreBackup(id) {
            const b = await getBackup(id);
            if (!b) throw new Error("Backup not found.");
            const error = validateSave(b.contents);
            if (error) throw new Error(`Backup is not valid: ${error}`);
            const replaced = await writeSlot(b.slot, b.contents, "replaced by backup restore");
            setStatus(`Restored backup into slot ${b.slot}${replaced ? " (save it replaced was backed up)" : ""}.`, "ok");
            await Promise.all([refreshSlots(), refreshBackups()]);
        }

        async function removeBackup(id) {
            await deleteBackup(id);
            setStatus("Backup deleted.", "ok");
            await refreshBackups();
        }

        async function importSkinFiles(picked) {
            const files = await expandZips(picked, /\.(bmp|png|jpe?g)$/i);
            const existing = new Set((await listSkins()).map((s) => s.name));
            const done = [];
            const failed = [];
            for (const file of files) {
                const name = skinNameFromFile(file.name);
                if (!name) {
                    failed.push(`${file.name}: file name has no usable characters`);
                    continue;
                }
                if (file.size > SKIN_MAX_FILE) {
                    failed.push(`${file.name}: file is too large`);
                    continue;
                }
                let bytes = await readFile(file);
                const problem = /\.bmp$/i.test(file.name) ? validateBmp(bytes) : "not a BMP";
                let converted = false;
                if (problem) {
                    try {
                        bytes = await convertToSkinBmp(file, bytes);
                        converted = true;
                    } catch (err) {
                        failed.push(`${file.name}: ${problem}; ${err.message}`);
                        continue;
                    }
                }
                await putSkin({ name, contents: bytes, sourceName: file.name, converted, addedAt: new Date() });
                done.push(`${name}${existing.has(name) ? " (replaced)" : ""}${converted ? " (converted to 24-bit 256x256 BMP)" : ""}`);
            }
            await refreshSkins();
            const parts = [];
            if (done.length) parts.push(`Imported skin${done.length > 1 ? "s" : ""}: ${done.join(", ")}.`);
            if (failed.length) parts.push(`Failed: ${failed.join("; ")}.`);
            setStatus(parts.join(" "), failed.length ? "error" : "ok");
        }

        async function removeSkin(name) {
            await deleteSkin(name);
            setStatus(`Removed skin ${name}. If it was selected in game, the default skin is used.`, "ok");
            await refreshSkins();
        }

        for (let slot = 1; slot <= SAVE_SLOTS; slot++) {
            slotSelect.append(el("option", { value: String(slot) }, `Slot ${slot}`));
        }

        saveInput.addEventListener("change", run(() => saveInput.files[0] && selectSaveFile(saveInput.files[0])));
        skinInput.addEventListener("change", run(async () => {
            await importSkinFiles([...skinInput.files]);
            skinInput.value = "";
        }));
        slotSelect.addEventListener("change", updateSaveSummary);
        saveImportBtn.addEventListener("click", run(importPendingSave));

        for (const [zone, handler] of [
            [saveDrop, (files) => files[0] && selectSaveFile(files[0])],
            [skinDrop, (files) => importSkinFiles(files)],
        ]) {
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

        Promise.all([refreshSlots(), refreshBackups(), refreshSkins()]).catch((err) => {
            console.error("[mods]", err);
            setStatus(`Could not open browser storage: ${err && err.message ? err.message : err}`, "error");
        });
    }

    window.vcMods = { prepareLaunch, installIntoFS, validateSave, validateBmp, saveName };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initUI);
    } else {
        initUI();
    }
})();
