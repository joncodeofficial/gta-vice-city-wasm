(() => {
    var isPthread = typeof ENVIRONMENT_IS_PTHREAD != "undefined" && ENVIRONMENT_IS_PTHREAD;
    var isWasmWorker = typeof ENVIRONMENT_IS_WASM_WORKER != "undefined" && ENVIRONMENT_IS_WASM_WORKER;
    if (isPthread || isWasmWorker) return;
    var isNode = globalThis.process && globalThis.process.versions && globalThis.process.versions.node && globalThis.process.type != "renderer";
    async function loadPackage(metadata) {
        var PACKAGE_PATH = "";
        if (typeof window === "object") {
            PACKAGE_PATH = window["encodeURIComponent"](window.location.pathname.substring(0, window.location.pathname.lastIndexOf("/")) + "/")
        } else if (typeof process === "undefined" && typeof location !== "undefined") {
            PACKAGE_PATH = encodeURIComponent(location.pathname.substring(0, location.pathname.lastIndexOf("/")) + "/")
        }
        var PACKAGE_NAME = "/home/caiiiycuk/vc/vc-sky/index.data";
        var REMOTE_PACKAGE_BASE = "index.data";
        var REMOTE_PACKAGE_NAME = Module["locateFile"] ? Module["locateFile"](REMOTE_PACKAGE_BASE, "") : REMOTE_PACKAGE_BASE;
        var REMOTE_PACKAGE_SIZE = metadata["remote_package_size"];
        async function fetchRemotePackage(packageName, packageSize) {
            if (isNode) {
                var contents = require("fs").readFileSync(packageName);
                return new Uint8Array(contents).buffer
            }
            if (!Module["dataFileDownloads"]) Module["dataFileDownloads"] = {};
            try {
                var response = await fetch(packageName)
            } catch (e) {
                throw new Error(`Network Error: ${packageName}`, {
                    e
                })
            }
            if (!response.ok) {
                throw new Error(`${response.status}: ${response.url}`)
            }
            const chunks = [];
            const headers = response.headers;
            const total = Number(headers.get("Content-Length") || packageSize);
            let loaded = 0;
            Module["setStatus"] && Module["setStatus"]("Downloading data...");
            const reader = response.body.getReader();
            while (1) {
                var {
                    done,
                    value
                } = await reader.read();
                if (done) break;
                chunks.push(value);
                loaded += value.length;
                Module["dataFileDownloads"][packageName] = {
                    loaded,
                    total
                };
                let totalLoaded = 0;
                let totalSize = 0;
                for (const download of Object.values(Module["dataFileDownloads"])) {
                    totalLoaded += download.loaded;
                    totalSize += download.total
                }
                Module["setStatus"] && Module["setStatus"](`Downloading data... (${totalLoaded}/${totalSize})`)
            }
            const packageData = new Uint8Array(chunks.map(c => c.length).reduce((a, b) => a + b, 0));
            let offset = 0;
            for (const chunk of chunks) {
                packageData.set(chunk, offset);
                offset += chunk.length
            }
            return packageData.buffer
        }
        var fetchPromise;
        var fetched = Module["getPreloadedPackage"] && Module["getPreloadedPackage"](REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE);
        if (!fetched) {
            fetchPromise = fetchRemotePackage(REMOTE_PACKAGE_NAME, REMOTE_PACKAGE_SIZE)
        }
        async function runWithFS(Module) {
            function assert(check, msg) {
                if (!check) throw new Error(msg)
            }
            // Directories from the package index.
            var dirs = new Set();
            for (var file of metadata["files"]) {
                var parts = file["filename"].split("/").slice(1, -1);
                for (var i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
            }
            for (var dir of [...dirs].sort((a, b) => a.split("/").length - b.split("/").length)) {
                var cut = dir.lastIndexOf("/");
                var parent = cut < 0 ? "/" : "/" + dir.slice(0, cut);
                Module["FS_createPath"](parent, dir.slice(cut + 1), true, true);
            }
            for (var file of metadata["files"]) {
                var name = file["filename"];
                Module["addRunDependency"](`fp ${name}`)
            }
            async function processPackageData(arrayBuffer) {
                assert(arrayBuffer, "Loading data file failed.");
                assert(arrayBuffer.constructor.name === ArrayBuffer.name, "bad input to processPackageData " + arrayBuffer.constructor.name);
                var byteArray = new Uint8Array(arrayBuffer);
                for (var file of metadata["files"]) {
                    var name = file["filename"];
                    var data = byteArray.subarray(file["start"], file["end"]);
                    Module["FS_createDataFile"](name, null, data, true, true, true);
                    Module["removeRunDependency"](`fp ${name}`)
                }
                Module["removeRunDependency"]("datafile_/home/caiiiycuk/vc/vc-sky/index.data")
            }
            Module["addRunDependency"]("datafile_/home/caiiiycuk/vc/vc-sky/index.data");
            if (!Module["preloadResults"]) Module["preloadResults"] = {};
            Module["preloadResults"][PACKAGE_NAME] = {
                fromCache: false
            };
            if (!fetched) {
                fetched = await fetchPromise
            }
            processPackageData(fetched)
        }
        if (Module["calledRun"]) {
            runWithFS(Module)
        } else {
            if (!Module["preRun"]) Module["preRun"] = [];
            Module["preRun"].push(runWithFS)
        }
    }
    loadPackage(window.DATA_PACKAGE)
})();
