function shouldIgnoreEntry(name) {
    const parts = name.split('/');
    const base = parts[parts.length - 1];
    return !name || base === '.DS_Store' || base.startsWith('._');
}

function* parseTarEntries(buffer) {
    const view = new Uint8Array(buffer);
    let offset = 0;
    let pendingLongName = null;
    const dec = new TextDecoder();

    while (offset + 512 <= view.length) {
        let allZero = true;
        for (let i = 0; i < 512; i++) {
            if (view[offset + i] !== 0) {
                allZero = false;
                break;
            }
        }
        if (allZero) break;

        const header = view.subarray(offset, offset + 512);
        const readStr = (start, len) => {
            let end = start;
            while (end < start + len && header[end] !== 0) end++;
            return dec.decode(header.subarray(start, end));
        };

        const typeflag = String.fromCharCode(header[156]);
        const rawName = readStr(0, 100);
        const prefix = readStr(345, 155);
        const size = parseInt(readStr(124, 12).trim(), 8) || 0;
        const dataOffset = offset + 512;
        const paddedSize = Math.ceil(size / 512) * 512;
        offset += 512 + paddedSize;

        if (typeflag === 'L') {
            pendingLongName = dec.decode(view.subarray(dataOffset, dataOffset + size)).replace(/\0/g, '');
            continue;
        }
        if (typeflag !== '0' && typeflag !== '' && typeflag !== '\0') {
            pendingLongName = null;
            continue;
        }

        let name = pendingLongName || (prefix ? prefix + '/' + rawName : rawName);
        pendingLongName = null;
        name = name.replace(/\0/g, '').replace(/\/$/, '');
        if (shouldIgnoreEntry(name)) continue;

        yield {
            name,
            data: view.subarray(dataOffset, dataOffset + size),
        };
    }
}

async function decompressGzip(arrayBuffer) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(arrayBuffer));
    writer.close();

    const chunks = [];
    const reader = ds.readable.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }

    const totalSize = chunks.reduce((n, c) => n + c.byteLength, 0);
    const result = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result.buffer;
}

async function writeToOPFS(name, data) {
    const root = await navigator.storage.getDirectory();
    const parts = name.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
        dir = await dir.getDirectoryHandle(parts[i], { create: true });
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
    const writable = await fh.createWritable();
    await writable.write(data);
    await writable.close();
}

self.onmessage = async (event) => {
    const { file } = event.data;
    try {
        self.postMessage({ type: 'progress', phase: 'reading', pct: 0 });
        const reader = file.stream().getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.byteLength;
            const pct = Math.round((loaded / file.size) * 10);
            self.postMessage({ type: 'progress', phase: 'reading', pct });
        }
        const compressed = new Uint8Array(loaded);
        let readOffset = 0;
        for (const chunk of chunks) {
            compressed.set(chunk, readOffset);
            readOffset += chunk.byteLength;
        }

        self.postMessage({ type: 'progress', phase: 'decompressing', pct: 10 });
        const tarBuffer = await decompressGzip(compressed.buffer);

        self.postMessage({ type: 'progress', phase: 'extracting', pct: 30 });
        let total = 0;
        for (const _entry of parseTarEntries(tarBuffer)) {
            total++;
        }
        let done = 0;

        for (const entry of parseTarEntries(tarBuffer)) {
            await writeToOPFS(entry.name, entry.data);
            done++;
            if (done % 200 === 0 || done === total) {
                const pct = 30 + Math.round((done / total) * 65);
                self.postMessage({ type: 'progress', phase: 'extracting', pct, done, total });
            }
        }

        const root = await navigator.storage.getDirectory();
        const marker = await root.getFileHandle('_game_ready', { create: true });
        const w = await marker.createWritable();
        await w.write(new TextEncoder().encode('v4'));
        await w.close();

        self.postMessage({ type: 'done' });
    } catch (err) {
        self.postMessage({ type: 'error', message: err.message });
    }
};
