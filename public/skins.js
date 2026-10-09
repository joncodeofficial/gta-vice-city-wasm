"use strict";

// Player-skin manager and the launch hooks game.js calls (requires shared.js).
//
// The engine enumerates skins/*.bmp (24-bit, uncompressed, 256x256) from
// /vc-assets/local/skins, which is in-memory only. Imported skins are kept in
// our own database and copied into that directory in Module.preRun.
(function () {
    const U = window.vcUserData;
    const {
        SKIN_STORE, reqToPromise, txDone, openUserDataDB, withDB, expandZips,
        formatSize, download, readFile, el, ready, setStatus, lockPanel, run, bindDropZone,
    } = U;

    const SKIN_DIR = "/vc-assets/local/skins";
    const STARTUP_SKIN_KEY = "vcuserdata.startupSkin";
    const SKIN_SIZE = 256;
    const SKIN_MAX_FILE = 16 * 1024 * 1024;

    let launchSkins = [];

    // ─── Image conversion ───────────────────────────────────────────

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

    // ─── Data ───────────────────────────────────────────────────────

    async function listSkins() {
        return withDB(openUserDataDB, async (db) => {
            const all = await reqToPromise(db.transaction(SKIN_STORE, "readonly").objectStore(SKIN_STORE).getAll());
            return all.sort((a, b) => a.name.localeCompare(b.name));
        });
    }

    async function putSkin(skin) {
        await withDB(openUserDataDB, async (db) => {
            const tx = db.transaction(SKIN_STORE, "readwrite");
            tx.objectStore(SKIN_STORE).put(skin);
            await txDone(tx);
        });
    }

    async function deleteSkin(name) {
        await withDB(openUserDataDB, async (db) => {
            const tx = db.transaction(SKIN_STORE, "readwrite");
            tx.objectStore(SKIN_STORE).delete(name);
            await txDone(tx);
        });
    }

    // This engine build reads SkinFile from revc.ini at startup but never
    // writes it back, so a skin picked in the in-game menu is lost on reload.
    // The startup skin chosen here is written into the ini instead. The
    // engine pre-selects it, but only puts it on the player model when the
    // Player Skin Setup menu is closed (verified in game).
    // null = leave the ini alone, "" = default skin, otherwise a skin name.
    function getStartupSkin() {
        try {
            return localStorage.getItem(STARTUP_SKIN_KEY);
        } catch {
            return null;
        }
    }

    function setStartupSkin(name) {
        try {
            localStorage.setItem(STARTUP_SKIN_KEY, name);
        } catch (err) {
            console.warn("[userdata] could not store startup skin:", err);
        }
    }

    // ─── Launch hooks (called from game.js) ─────────────────────────

    async function prepareLaunch() {
        lockPanel();
        try {
            launchSkins = await listSkins();
        } catch (err) {
            console.error("[userdata] could not read skins:", err);
            launchSkins = [];
        }
    }

    function applyIniOverrides(ini) {
        let skin = getStartupSkin();
        if (skin === null) return ini;
        if (skin && !launchSkins.some((s) => s.name === skin)) skin = "";
        // Format confirmed in-game: the bare skin name, no quotes or extension.
        // '$$""' is what the shipped ini uses for "no skin".
        const line = `SkinFile=${skin || '$$""'}`;
        // Function replacers: a string replacement would turn "$$" into "$".
        if (/^SkinFile=/m.test(ini)) return ini.replace(/^SkinFile=[^\r\n]*/m, () => line);
        const eol = ini.includes("\r\n") ? "\r\n" : "\n";
        if (/^\[General\]/m.test(ini)) return ini.replace(/^\[General\][^\r\n]*/m, (m) => `${m}${eol}${line}`);
        return `${ini}${eol}[General]${eol}${line}${eol}`;
    }

    function installIntoFS(FS) {
        if (!launchSkins.length) return;
        FS.createPath("/", SKIN_DIR.slice(1), true, true);
        for (const skin of launchSkins) {
            try {
                FS.writeFile(`${SKIN_DIR}/${skin.name}.bmp`, skin.contents);
            } catch (err) {
                console.error(`[userdata] could not install skin ${skin.name}:`, err);
            }
        }
        console.log(`[userdata] installed ${launchSkins.length} skin(s) into ${SKIN_DIR}`);
    }

    // ─── UI ─────────────────────────────────────────────────────────

    function initSkins() {
        const skinList = document.getElementById("skin-list");
        if (!skinList) return;

        const skinInput = document.getElementById("skin-file-input");
        const skinDrop = document.getElementById("skin-drop");
        const startupSkinSelect = document.getElementById("startup-skin-select");

        async function refreshSkins() {
            const skins = await listSkins();
            const current = getStartupSkin();
            startupSkinSelect.replaceChildren(
                el("option", { value: "" }, "Default (Tommy)"),
                ...skins.map((s) => el("option", { value: s.name }, s.name)));
            startupSkinSelect.value = current && skins.some((s) => s.name === current) ? current : "";
            if (!skins.length) {
                skinList.replaceChildren(el("li", { className: "userdata-empty" }, "No custom skins imported."));
                return;
            }
            skinList.replaceChildren(...skins.map((s) => el("li", { className: "userdata-row" },
                el("span", { className: "userdata-row-title" }, s.name),
                el("span", { className: "userdata-row-info" }, s.converted ? `converted from ${s.sourceName}` : formatSize(s.contents.length)),
                el("span", { className: "userdata-row-actions" },
                    el("button", { type: "button", className: "userdata-btn", onclick: run(() => download(s.contents, `${s.name}.bmp`)) }, "Export"),
                    el("button", { type: "button", className: "userdata-btn userdata-btn-danger", onclick: run(() => removeSkin(s.name)) }, "Remove")))));
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
            if (getStartupSkin() === name) setStartupSkin("");
            setStatus(`Removed skin ${name}. If it was selected in game, the default skin is used.`, "ok");
            await refreshSkins();
        }

        skinInput.addEventListener("change", run(async () => {
            await importSkinFiles([...skinInput.files]);
            skinInput.value = "";
        }));
        startupSkinSelect.addEventListener("change", () => {
            setStartupSkin(startupSkinSelect.value);
            setStatus(startupSkinSelect.value
                ? `${startupSkinSelect.value} will be pre-selected. In game, open Options → Player Skin Setup and leave it to put it on.`
                : "The default skin will be pre-selected when the game starts.", "ok");
        });
        bindDropZone(skinDrop, (files) => importSkinFiles(files));

        refreshSkins().catch((err) => {
            console.error("[userdata]", err);
            setStatus(`Could not open browser storage: ${err && err.message ? err.message : err}`, "error");
        });
    }

    Object.assign(U, { prepareLaunch, installIntoFS, applyIniOverrides, validateBmp });
    ready(initSkins);
})();
