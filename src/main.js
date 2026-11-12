import {
  LANGUAGES,
  applyTranslations,
  changeLanguage,
  currentLanguage,
  setRawText,
  setText,
  t,
} from "./i18n/index.js";
import {
  GAME_ENTRIES,
  IMPORT_TMP,
  OPFS_VERSION,
  PACKAGE_DATA,
  PACKAGE_INDEX,
  READY_MARKER,
} from "./convert/layout.js";

const BASE = import.meta.env.BASE_URL;

const LEGACY_SCRIPT_SOURCES = [
  `${BASE}controllers.js`,
  `${BASE}GamepadEmulator.js`,
  `${BASE}idbfs.js`,
  `${BASE}shared.js`,
  `${BASE}saves.js`,
  `${BASE}skins.js`,
  `${BASE}game.js`,
];

function isLocalDevEnvironment() {
  return (
    window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

async function clearDevelopmentServiceWorkers() {
  if (!("serviceWorker" in navigator) || !isLocalDevEnvironment()) {
    return;
  }

  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existingScript = document.querySelector(`script[src="${src}"]`);
    if (existingScript) {
      if (existingScript.dataset.loaded === "true") {
        resolve();
        return;
      }

      existingScript.addEventListener("load", () => resolve(), { once: true });
      existingScript.addEventListener(
        "error",
        () => reject(new Error(`Failed to load script: ${src}`)),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = false;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load script: ${src}`)),
      { once: true },
    );
    document.body.appendChild(script);
  });
}

async function loadLegacyScripts() {
  for (const src of LEGACY_SCRIPT_SOURCES) {
    await loadScript(src);
  }
}

// Returns null if OK, or a string describing the failure reason.
async function checkReady() {
  try {
    const root = await navigator.storage.getDirectory();

    const getFile = async (path) => {
      const parts = path.split("/");
      let dir = root;
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
      return (await dir.getFileHandle(parts.at(-1))).getFile();
    };

    let marker;
    try {
      marker = await getFile(READY_MARKER);
    } catch {
      return `OPFS marker '${READY_MARKER}' not found`;
    }
    const version = await marker.text();
    if (version !== OPFS_VERSION) {
      return `OPFS marker version mismatch: got "${version}", expected "${OPFS_VERSION}"`;
    }

    const minSizes = { [PACKAGE_DATA]: 100 * 1024 * 1024, [PACKAGE_INDEX]: 0 };
    for (const [path, minSize] of Object.entries(minSizes)) {
      let file;
      try {
        file = await getFile(path);
      } catch {
        return `OPFS file not found: ${path}`;
      }
      if (file.size < minSize) {
        return `OPFS file too small: ${path} is ${(file.size / 1024 / 1024).toFixed(1)} MB, need > ${minSize / 1024 / 1024} MB`;
      }
    }

    return null;
  } catch (err) {
    return `checkReady error: ${err.message}`;
  }
}

// Returns null if OK, or a string describing the failure reason.
async function verifyGameServing() {
  const requiredUrls = [PACKAGE_DATA, PACKAGE_INDEX].map((path) => `/${path}`);

  try {
    for (const url of requiredUrls) {
      let response;
      try {
        response = await fetch(url, { method: "HEAD", cache: "no-store" });
      } catch (err) {
        return `fetch failed for ${url}: ${err.message}`;
      }
      if (!response.ok) {
        return `SW served ${response.status} for ${url}`;
      }
    }

    return null;
  } catch (err) {
    return `verifyGameServing error: ${err.message}`;
  }
}

async function waitForGameReady(retries = 6, delayMs = 400) {
  let lastReason = "unknown";
  for (let attempt = 0; attempt < retries; attempt++) {
    const opfsReason = await checkReady();
    if (opfsReason !== null) {
      lastReason = opfsReason;
      console.warn(`[waitForGameReady] attempt ${attempt + 1}: ${opfsReason}`);
    } else {
      const servingReason = await verifyGameServing();
      if (servingReason !== null) {
        lastReason = servingReason;
        console.warn(`[waitForGameReady] attempt ${attempt + 1}: ${servingReason}`);
      } else {
        return { ready: true, reason: null };
      }
    }

    if (attempt < retries - 1) {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }
  }

  return { ready: false, reason: lastReason };
}

async function clearGameFiles() {
  // Clear OPFS: delete all known directories and the marker file
  try {
    const root = await navigator.storage.getDirectory();
    for (const name of [...GAME_ENTRIES, IMPORT_TMP]) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // entry may not exist
      }
    }
  } catch (err) {
    console.warn("[reset] OPFS clear failed:", err);
  }
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

// [{ path, file }] for every file in a dropped folder.
async function readDroppedFolder(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    const reader = dir.createReader();
    // Batches until an empty one.
    for (;;) {
      const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!batch.length) break;
      for (const entry of batch) {
        const path = `${prefix}/${entry.name}`;
        if (entry.isDirectory) await walk(entry, path);
        else out.push({ path, file: await entryFile(entry) });
      }
    }
  };
  await walk(root, root.name);
  return out;
}

// [{ path, file }] for every file in a folder picked with showDirectoryPicker.
async function readPickedFolder(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    for await (const handle of dir.values()) {
      const path = `${prefix}/${handle.name}`;
      if (handle.kind === "directory") await walk(handle, path);
      else out.push({ path, file: await handle.getFile() });
    }
  };
  await walk(root, root.name);
  return out;
}

// Phones can't pick folders; they only get the .zip button.
const canPickFolders = () => !window.matchMedia("(pointer: coarse)").matches;

// Dropping a folder avoids the browser's "upload files?" prompt.
function bindGameDrop(zone, { isBusy, onFile, onFolder, onError }) {
  // Keeps a missed drop from opening the file.
  window.addEventListener("dragover", (event) => event.preventDefault());
  window.addEventListener("drop", (event) => event.preventDefault());

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!isBusy()) zone.dataset.dragging = "1";
  });
  zone.addEventListener("dragleave", () => delete zone.dataset.dragging);
  zone.addEventListener("drop", async (event) => {
    event.preventDefault();
    delete zone.dataset.dragging;
    if (isBusy()) return;
    // Read entries before any await.
    const entry = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry?.())
      .find(Boolean);
    if (!entry) return;
    try {
      if (entry.isFile) onFile(await entryFile(entry));
      else onFolder(entry.name, await readDroppedFolder(entry));
    } catch (err) {
      onError(err);
    }
  });
}

async function initSetupFlow() {
  const overlay = document.getElementById("setup-overlay");
  const zipInput = document.getElementById("game-zip-input");
  const folderInput = document.getElementById("game-folder-input");
  const dropZone = document.getElementById("game-drop");
  const folderBtn = document.getElementById("game-folder-btn");
  const zipBtn = document.getElementById("game-zip-btn");
  const progress = document.getElementById("setup-progress");
  const progressBar = document.getElementById("setup-progress-bar");
  const progressLabel = document.getElementById("setup-progress-label");
  const progressPercent = document.getElementById("setup-progress-percent");
  const errorBox = document.getElementById("setup-error");
  const storageStatus = document.getElementById("storage-status");
  const selectedFileName = document.getElementById("selected-file-name");
  const clickToPlayButton = document.getElementById("click-to-play-button");
  const resetFilesBtn = document.getElementById("reset-files-btn");

  if (
    !overlay ||
    !zipInput ||
    !folderInput ||
    !dropZone ||
    !folderBtn ||
    !zipBtn ||
    !progress ||
    !progressBar ||
    !progressLabel ||
    !progressPercent ||
    !errorBox ||
    !storageStatus ||
    !selectedFileName ||
    !clickToPlayButton
  ) {
    return;
  }


  const showError = (key, options) => {
    errorBox.style.display = "block";
    setText(errorBox, key, options);
  };

  const setStorageStatus = (key, state) => {
    setText(storageStatus, key);
    storageStatus.dataset.state = state;
  };

  const setPlayAvailability = (enabled) => {
    window.__gtaGameReady = enabled;
    clickToPlayButton.disabled = !enabled;
    clickToPlayButton.classList.toggle("disabled", !enabled);
  };

  if (resetFilesBtn) {
    resetFilesBtn.addEventListener("click", async () => {
      if (!confirm(t("setup.resetFilesConfirm"))) {
        return;
      }
      resetFilesBtn.disabled = true;
      setText(resetFilesBtn, "setup.resetting");
      await clearGameFiles();
      setStorageStatus("status.missing", "missing");
      setPlayAvailability(false);
      progress.style.display = "none";
      errorBox.style.display = "none";
      setText(selectedFileName, "setup.drop");
      zipInput.value = "";
      folderInput.value = "";
      resetFilesBtn.disabled = false;
      setText(resetFilesBtn, "setup.resetFiles");
    });
  }

  // No reset or second import while the worker writes.
  let importing = false;
  const setImporting = (value) => {
    importing = value;
    zipInput.disabled = value;
    folderInput.disabled = value;
    folderBtn.disabled = value;
    zipBtn.disabled = value;
    dropZone.classList.toggle("disabled", value);
    if (resetFilesBtn) resetFilesBtn.disabled = value;
  };

  const ERROR_KEYS = {
    notGameFolder: "errors.notGameFolder",
    discImage: "errors.discImage",
    missingFiles: "errors.missingFiles",
    zip: "errors.zip",
    storage: "errors.storage",
  };

  const runImport = (message) => {
    errorBox.style.display = "none";
    setImporting(true);
    progress.style.display = "block";
    setText(progressLabel, "progress.checking");
    progressPercent.textContent = "0%";
    progressBar.style.width = "0%";
    setPlayAvailability(false);
    setStorageStatus("status.missing", "missing");

    const worker = new Worker(new URL("./convert/worker.js", import.meta.url), { type: "module" });
    const finish = () => {
      setImporting(false);
      worker.terminate();
    };
    worker.onerror = (error) => {
      console.error("[worker error]", error);
      showError("errors.worker", { message: error.message });
      finish();
    };
    worker.onmessage = async (event) => {
      const message = event.data;

      if (message.type === "progress") {
        if (message.phase === "converting") {
          const pct = Math.floor((message.done / message.total) * 100);
          progressBar.style.width = `${pct}%`;
          progressPercent.textContent = `${pct}%`;
          setText(progressLabel, "progress.converting", { done: message.done, total: message.total });
        } else if (message.phase === "unpacking") {
          setText(progressLabel, "progress.unpacking", { file: message.file });
        } else {
          setText(progressLabel, "progress.checking");
        }
        return;
      }

      if (message.type === "warning") {
        console.warn("[import] files differ from the known release:", message.files);
        showError("errors.mismatch", { count: message.files.length });
        return;
      }

      if (message.type === "done") {
        progressBar.style.width = "100%";
        progressPercent.textContent = "100%";
        setText(progressLabel, "progress.verifying");
        const { ready: isReady, reason } = await waitForGameReady();
        setStorageStatus(
          isReady ? "status.ready" : "status.missing",
          isReady ? "ready" : "missing",
        );
        setPlayAvailability(isReady);
        if (isReady) setText(progressLabel, "progress.complete");
        else setText(progressLabel, "progress.verifyFailed", { reason });
        finish();
        return;
      }

      if (message.type === "error") {
        if (message.message) console.error("[import]", message.code, message.message);
        progress.style.display = "none";
        showError(ERROR_KEYS[message.code] || "errors.generic", {
          message: message.message,
          files: (message.files || []).join(", "),
        });
        finish();
      }
    };
    worker.postMessage(message);
  };

  setPlayAvailability(false);

  if (
    !("serviceWorker" in navigator) ||
    !("storage" in navigator && navigator.storage.getDirectory)
  ) {
    setStorageStatus("status.unsupported", "error");
    showError("errors.apis");
    return;
  }

  try {
    if (isLocalDevEnvironment()) {
      console.log("[setup] local dev detected, refreshing SW registration");
      await clearDevelopmentServiceWorkers();
    }

    console.log("[setup] registering SW...");
    await navigator.serviceWorker.register(`${BASE}sw.js`, { updateViaCache: "none" });
    await navigator.serviceWorker.ready;
    console.log("[setup] SW ready");

    if (!navigator.serviceWorker.controller) {
      console.log("[setup] SW not yet controlling page — reloading...");
      window.location.reload();
      return;
    }
  } catch (error) {
    setStorageStatus("status.loadFailed", "error");
    showError("errors.serviceWorker", { message: error.message });
    return;
  }

  const startZip = (file) => {
    setRawText(selectedFileName, file.name);
    if (/\.iso$/i.test(file.name)) {
      showError("errors.discImage");
      return;
    }
    if (!/\.zip$/i.test(file.name)) {
      showError("errors.notZip");
      return;
    }
    runImport({ kind: "zip", file });
  };

  const startFolder = (name, entries) => {
    setRawText(selectedFileName, name);
    runImport({ kind: "folder", entries });
  };

  zipInput.addEventListener("change", () => {
    const file = zipInput.files[0];
    if (file) startZip(file);
  });

  folderInput.addEventListener("change", () => {
    const files = [...folderInput.files];
    if (!files.length) return;
    const entries = files.map((file) => ({ path: file.webkitRelativePath, file }));
    startFolder(entries[0].path.split("/")[0], entries);
  });

  // Chrome and Edge get the native folder picker (no "upload files?" prompt).
  const pickFolder = async () => {
    if (!window.showDirectoryPicker) return folderInput.click();
    try {
      const dir = await window.showDirectoryPicker({ mode: "read" });
      startFolder(dir.name, await readPickedFolder(dir));
    } catch (err) {
      if (err.name !== "AbortError") showError("errors.generic", { message: err.message });
    }
  };
  folderBtn.addEventListener("click", pickFolder);
  zipBtn.addEventListener("click", () => zipInput.click());
  folderBtn.hidden = !canPickFolders();

  bindGameDrop(dropZone, {
    isBusy: () => importing,
    onFile: startZip,
    onFolder: startFolder,
    onError: (err) => showError("errors.generic", { message: err.message }),
  });

  const { ready, reason } = await waitForGameReady(2, 150);
  console.log("[setup] game ready in OPFS:", ready, reason || "");
  if (ready) {
    setStorageStatus("status.ready", "ready");
    setPlayAvailability(true);
    progress.style.display = "none";
    return;
  }

  setStorageStatus("status.missing", "missing");

  console.log("[setup] waiting for file selection");
}

function initCanvasBindings() {
  const canvas = document.getElementById("canvas");
  if (!canvas) {
    return;
  }

  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });
}

function checkBrowserCompatibility() {
  const missing = [];

  if (!("serviceWorker" in navigator)) missing.push("Service Workers");
  if (!("storage" in navigator) || !("getDirectory" in navigator.storage)) missing.push("OPFS");
  if (typeof WebAssembly === "undefined") missing.push("WebAssembly");
  if (typeof Worker === "undefined") missing.push("Web Workers");

  return missing;
}

function initOrientationLock() {
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains("gameIsStarted")) {
      observer.disconnect();
      screen.orientation?.lock("landscape").catch(() => {});
    }
  });
  observer.observe(document.body, { attributeFilter: ["class"] });
}

function initLanguagePicker() {
  const select = document.getElementById("ui-lang");
  if (!select) return;

  select.replaceChildren(
    ...LANGUAGES.map(({ code, label }) => new Option(label, code)),
  );
  select.value = currentLanguage();
  select.addEventListener("change", () => {
    void changeLanguage(select.value);
  });
}

async function boot() {
  applyTranslations();
  initLanguagePicker();
  initCanvasBindings();
  initOrientationLock();

  const missing = checkBrowserCompatibility();
  if (missing.length > 0) {
    const storageStatus = document.getElementById("storage-status");
    const errorBox = document.getElementById("setup-error");
    if (storageStatus) {
      setText(storageStatus, "status.unsupported");
      storageStatus.dataset.state = "error";
    }
    if (errorBox) {
      errorBox.style.display = "block";
      setText(errorBox, "errors.missingFeatures", { features: missing.join(", ") });
    }
    return;
  }

  await initSetupFlow();
  try {
    await loadLegacyScripts();
  } catch (err) {
    showScriptLoadError(err);
  }
}

// A script can fail to load right after a deploy, when the browser still has
// the previous page cached but the files it asks for are gone. Say so instead
// of leaving a Start button that does nothing.
function showScriptLoadError(err) {
  console.error("[boot] failed to load a game script:", err);
  const file = String(err && err.message).split("/").pop();

  const startButton = document.getElementById("click-to-play-button");
  if (startButton) {
    startButton.disabled = true;
    startButton.classList.add("disabled");
  }
  const storageStatus = document.getElementById("storage-status");
  if (storageStatus) {
    setText(storageStatus, "status.loadFailed");
    storageStatus.dataset.state = "error";
  }
  const errorBox = document.getElementById("setup-error");
  if (errorBox) {
    errorBox.style.display = "block";
    setText(errorBox, "errors.scriptLoad", { file });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void boot();
  });
} else {
  void boot();
}
