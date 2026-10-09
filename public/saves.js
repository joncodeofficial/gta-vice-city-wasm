"use strict";

// Save-game manager (requires shared.js).
//
// The engine mounts IDBFS at SAVE_DIR and populates it from IndexedDB when it
// starts (asm_consts/en.js: FS.mount(IDBFS) + FS.syncfs(true)). IDBFS keeps
// one database per mount point, named after the mount path, with every file
// stored in FILE_DATA as { timestamp, mode, contents } keyed by its full path
// (modules/fs.js). Writing a record in that format before the game starts is
// therefore enough for the engine to see it as a normal save.
(function () {
    const U = window.vcUserData;
    const {
        BACKUP_STORE, reqToPromise, txDone, openDB, openUserDataDB, withDB, expandZips,
        equalBytes, formatSize, formatDate, stamp, download, readFile, el, ready,
        setStatus, run, bindDropZone,
    } = U;

    const SAVE_DIR = "/vc-assets/local/userfiles";
    const SAVE_SLOTS = 8;
    const saveKey = (slot) => `${SAVE_DIR}/GTAVCsf${slot}.b`;

    // Must match IDBFS in modules/fs.js, otherwise opening the database
    // would trigger a version change the engine does not expect.
    const IDBFS_VERSION = 21;
    const IDBFS_STORE = "FILE_DATA";
    const FILE_MODE = 0o100666; // S_IFREG | rw-rw-rw-

    const SAVE_MIN_SIZE = 1024;
    const SAVE_MAX_SIZE = 4 * 1024 * 1024;

    // ─── Data ───────────────────────────────────────────────────────

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
        await withDB(openUserDataDB, async (db) => {
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
        return withDB(openUserDataDB, async (db) => {
            const all = await reqToPromise(db.transaction(BACKUP_STORE, "readonly").objectStore(BACKUP_STORE).getAll());
            return all.sort((a, b) => b.backedUpAt - a.backedUpAt);
        });
    }

    async function getBackup(id) {
        return withDB(openUserDataDB, (db) =>
            reqToPromise(db.transaction(BACKUP_STORE, "readonly").objectStore(BACKUP_STORE).get(id)));
    }

    async function deleteBackup(id) {
        await withDB(openUserDataDB, async (db) => {
            const tx = db.transaction(BACKUP_STORE, "readwrite");
            tx.objectStore(BACKUP_STORE).delete(id);
            await txDone(tx);
        });
    }

    // ─── UI ─────────────────────────────────────────────────────────

    function initSaves() {
        const slotList = document.getElementById("save-slot-list");
        if (!slotList) return;

        const saveInput = document.getElementById("save-file-input");
        const saveDrop = document.getElementById("save-drop");
        const saveFileName = document.getElementById("save-file-name");
        const slotSelect = document.getElementById("save-slot-select");
        const saveSummary = document.getElementById("save-import-summary");
        const saveImportBtn = document.getElementById("save-import-btn");
        const backupList = document.getElementById("save-backup-list");
        const backupCount = document.getElementById("save-backup-count");

        let slots = [];
        let pendingSave = null; // { name, bytes }

        async function refreshSlots() {
            slots = await readSlots();
            slotList.replaceChildren(...slots.map(({ slot, entry }) => {
                const info = entry && entry.contents
                    ? `${saveName(entry.contents) || "Unnamed save"} · ${formatDate(entry.timestamp)}`
                    : "Empty";
                const exportBtn = el("button", { type: "button", className: "userdata-btn", onclick: run(() => exportSlot(slot)) }, "Export");
                if (!entry) exportBtn.disabled = true;
                return el("li", { className: "userdata-row" },
                    el("span", { className: "userdata-row-title" }, `Slot ${slot}`),
                    el("span", { className: "userdata-row-info" }, info),
                    exportBtn);
            }));
            updateSaveSummary();
        }

        async function refreshBackups() {
            const backups = await listBackups();
            backupCount.textContent = String(backups.length);
            if (!backups.length) {
                backupList.replaceChildren(el("li", { className: "userdata-empty" }, "No backups yet. A backup is made automatically whenever a slot is replaced."));
                return;
            }
            backupList.replaceChildren(...backups.map((b) => el("li", { className: "userdata-row" },
                el("span", { className: "userdata-row-title" }, `Slot ${b.slot}`),
                el("span", { className: "userdata-row-info" }, `${saveName(b.contents) || "Unnamed save"} · backed up ${formatDate(b.backedUpAt)}`),
                el("span", { className: "userdata-row-actions" },
                    el("button", { type: "button", className: "userdata-btn", onclick: run(() => exportBackup(b.id)) }, "Export"),
                    el("button", { type: "button", className: "userdata-btn", onclick: run(() => restoreBackup(b.id)) }, "Restore"),
                    el("button", { type: "button", className: "userdata-btn userdata-btn-danger", onclick: run(() => removeBackup(b.id)) }, "Delete")))));
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
            const saves = await expandZips([picked], /\.b$/i, SAVE_MAX_SIZE);
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

        for (let slot = 1; slot <= SAVE_SLOTS; slot++) {
            slotSelect.append(el("option", { value: String(slot) }, `Slot ${slot}`));
        }

        saveInput.addEventListener("change", run(() => saveInput.files[0] && selectSaveFile(saveInput.files[0])));
        slotSelect.addEventListener("change", updateSaveSummary);
        saveImportBtn.addEventListener("click", run(importPendingSave));
        bindDropZone(saveDrop, (files) => files[0] && selectSaveFile(files[0]));

        Promise.all([refreshSlots(), refreshBackups()]).catch((err) => {
            console.error("[userdata]", err);
            setStatus(`Could not open browser storage: ${err && err.message ? err.message : err}`, "error");
        });
    }

    Object.assign(U, { validateSave, saveName });
    ready(initSaves);
})();
