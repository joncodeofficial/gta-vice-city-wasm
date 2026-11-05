import {
  LANGUAGES,
  applyTranslations,
  changeLanguage,
  currentLanguage,
  setRawText,
  setText,
  t,
} from "./i18n/index.js";

const ASSET_RELEASE_URL = import.meta.env.VITE_ASSET_URL;

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

    let markerFile;
    try {
      const fh = await root.getFileHandle("_game_ready");
      markerFile = await fh.getFile();
    } catch {
      return "OPFS marker '_game_ready' not found";
    }

    const version = await markerFile.text();
    if (version !== "v4") {
      return `OPFS marker version mismatch: got "${version}", expected "v4"`;
    }

    const requiredFiles = [
      ["vcbr", "vc-sky-en-v6.data", 100 * 1024 * 1024],
      ["vcbr", "vc-sky-en-v6.wasm", 0],
      ["vcsky", "sha256sums.txt", 0],
    ];

    for (const [directoryName, fileName, minSize] of requiredFiles) {
      let dir;
      try {
        dir = await root.getDirectoryHandle(directoryName);
      } catch {
        return `OPFS directory not found: ${directoryName}/`;
      }
      let fh;
      try {
        fh = await dir.getFileHandle(fileName);
      } catch {
        return `OPFS file not found: ${directoryName}/${fileName}`;
      }
      if (minSize > 0) {
        const f = await fh.getFile();
        if (f.size < minSize) {
          return `OPFS file too small: ${directoryName}/${fileName} is ${(f.size / 1024 / 1024).toFixed(1)} MB, need > ${minSize / 1024 / 1024} MB`;
        }
      }
    }

    return null;
  } catch (err) {
    return `checkReady error: ${err.message}`;
  }
}

// Returns null if OK, or a string describing the failure reason.
async function verifyGameServing() {
  const requiredUrls = [
    "/vcbr/vc-sky-en-v6.data",
    "/vcbr/vc-sky-en-v6.wasm",
    "/vcsky/sha256sums.txt",
  ];

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
    for (const name of ["vcbr", "vcsky", "_game_ready"]) {
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

async function initSetupFlow() {
  const overlay = document.getElementById("setup-overlay");
  const downloadLink = document.getElementById("dl-link");
  const fileInput = document.getElementById("game-file-input");
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
    !downloadLink ||
    !fileInput ||
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

  if (ASSET_RELEASE_URL) {
    downloadLink.href = ASSET_RELEASE_URL;
  } else {
    // No archive URL configured for this build (VITE_ASSET_URL unset).
    downloadLink.style.display = "none";
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
      setText(selectedFileName, "setup.noFile");
      fileInput.value = "";
      resetFilesBtn.disabled = false;
      setText(resetFilesBtn, "setup.resetFiles");
    });
  }

  // Neither reset nor a second import may run while the worker is still
  // writing to OPFS. The download link stays usable.
  const filePicker = document.querySelector(`label[for="${fileInput.id}"]`);
  const setImporting = (importing) => {
    fileInput.disabled = importing;
    filePicker?.classList.toggle("disabled", importing);
    if (resetFilesBtn) resetFilesBtn.disabled = importing;
  };

  const runImport = async (file) => {
    errorBox.style.display = "none";
    setImporting(true);
    progress.style.display = "block";
    setText(progressLabel, "progress.readingFile");
    progressPercent.textContent = "0%";
    progressBar.style.width = "0%";
    setPlayAvailability(false);

    const worker = new Worker(`${BASE}extract-worker.js`);
    worker.onerror = (error) => {
      console.error("[worker error]", error);
      showError("errors.worker", { message: error.message });
      setImporting(false);
    };
    worker.postMessage({ file });
    worker.onmessage = async (event) => {
      const message = event.data;

      if (message.type === "progress") {
        progressBar.style.width = `${message.pct}%`;
        progressPercent.textContent = `${message.pct}%`;
        const labels = {
          reading: "progress.reading",
          decompressing: "progress.decompressing",
          extracting: "progress.extracting",
        };
        setText(progressLabel, labels[message.phase] || "progress.working", {
          done: message.done || 0,
          total: message.total || "",
        });
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
        else {
          setText(progressLabel, "progress.verifyFailed", { reason });
            }
        setImporting(false);
        worker.terminate();
        return;
      }

      if (message.type === "error") {
        showError("errors.generic", { message: message.message });
          setImporting(false);
        worker.terminate();
      }
    };
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

  // Attach before the ready check so a file can still be imported after
  // "Reset game data" without reloading the page.
  fileInput.addEventListener("change", async () => {
    console.log("[setup] file selected:", fileInput.files[0]?.name);
    const file = fileInput.files[0];
    if (!file) {
      setText(selectedFileName, "setup.noFile");
      return;
    }

    setRawText(selectedFileName, file.name);

    if (!/\.tar\.gz$|\.gz$/i.test(file.name)) {
      showError("errors.wrongFile");
      return;
    }

    await runImport(file);
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
