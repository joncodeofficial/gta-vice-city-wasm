const OPFS_MARKER = '_game_ready';

// Request types that make up the app itself; game data is served from OPFS.
const REVALIDATED_DESTINATIONS = new Set(['document', 'script', 'style', 'worker', 'manifest']);

const CONTENT_TYPES = new Map([
    ['.wasm', 'application/wasm'],
    ['.js', 'application/javascript'],
    ['.json', 'application/json'],
    ['.html', 'text/html; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.gif', 'image/gif'],
    ['.svg', 'image/svg+xml'],
    ['.wav', 'audio/wav'],
    ['.mp3', 'audio/mpeg'],
    ['.ogg', 'audio/ogg'],
    ['.adf', 'application/octet-stream'],
    ['.dat', 'application/octet-stream'],
    ['.dff', 'application/octet-stream'],
    ['.txd', 'application/octet-stream'],
    ['.col', 'application/octet-stream'],
    ['.ipl', 'application/octet-stream'],
    ['.ide', 'application/octet-stream'],
    ['.ifp', 'application/octet-stream'],
    ['.img', 'application/octet-stream'],
    ['.dir', 'application/octet-stream'],
    ['.raw', 'application/octet-stream'],
    ['.bin', 'application/octet-stream'],
]);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const path = url.pathname;
    if ((path.startsWith('/vcsky/') || path.startsWith('/vcbr/')) &&
        (event.request.method === 'GET' || event.request.method === 'HEAD')) {
        event.respondWith(serveFromOPFS(event.request, path));
        return;
    }

    // GitHub Pages lets the browser reuse the page and its scripts for 10
    // minutes without asking, so a deploy can be invisible for that long (or
    // mix an old page with new files). Make the browser check with the server
    // first: an unchanged file costs a 304, a changed one is fetched fresh.
    if (event.request.method === 'GET' && url.origin === self.location.origin &&
        REVALIDATED_DESTINATIONS.has(event.request.destination)) {
        event.respondWith(
            fetch(event.request, { cache: 'no-cache' })
                // offline: fall back to whatever the browser still has
                .catch(() => fetch(event.request, { cache: 'force-cache' }))
        );
    }
});

function getContentType(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.wasm.br')) return 'application/wasm';
    if (lower.endsWith('.js.br')) return 'application/javascript';
    if (lower.endsWith('.json.br')) return 'application/json';
    if (lower.endsWith('.css.br')) return 'text/css; charset=utf-8';
    if (lower.endsWith('.html.br')) return 'text/html; charset=utf-8';

    for (const [ext, type] of CONTENT_TYPES) {
        if (lower.endsWith(ext)) return type;
    }
    return 'application/octet-stream';
}

function buildHeaders(filename, size) {
    const headers = new Headers();
    headers.set('Content-Type', getContentType(filename));
    headers.set('Content-Length', String(size));
    headers.set('Accept-Ranges', 'bytes');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

    if (filename.toLowerCase().endsWith('.br')) {
        headers.set('Content-Encoding', 'br');
    }

    return headers;
}

function parseRange(rangeHeader, size) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || '');
    if (!match) return null;

    let start = match[1] === '' ? null : Number(match[1]);
    let end = match[2] === '' ? null : Number(match[2]);

    if (start === null && end === null) return null;
    if (start === null) {
        start = Math.max(0, size - end);
        end = size - 1;
    } else if (end === null || end >= size) {
        end = size - 1;
    }

    if (start > end || start < 0 || end >= size) return null;
    return { start, end };
}

async function serveFromOPFS(request, pathname) {
    try {
        const root = await navigator.storage.getDirectory();
        const parts = pathname.replace(/^\//, '').split('/').map(decodeURIComponent);
        let dir = root;
        for (let i = 0; i < parts.length - 1; i++) {
            dir = await dir.getDirectoryHandle(parts[i]);
        }
        const filename = parts[parts.length - 1];
        const fileHandle = await dir.getFileHandle(filename);
        const file = await fileHandle.getFile();
        const headers = buildHeaders(filename, file.size);

        if (request.method === 'HEAD') {
            return new Response(null, { status: 200, headers });
        }

        const range = parseRange(request.headers.get('Range'), file.size);
        if (range) {
            headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
            headers.set('Content-Length', String(range.end - range.start + 1));
            return new Response(file.slice(range.start, range.end + 1), {
                status: 206,
                headers,
            });
        }

        return new Response(file, { status: 200, headers });
    } catch (error) {
        return new Response('Not found', { status: 404 });
    }
}

self.addEventListener('message', async event => {
    if (event.data.type === 'IS_READY') {
        const ready = await isGameReady();
        const port = event.ports[0] || event.source;
        if (port) port.postMessage({ type: 'IS_READY', ready });
    }
});

async function isGameReady() {
    try {
        const root = await navigator.storage.getDirectory();
        await root.getFileHandle(OPFS_MARKER);
        return true;
    } catch {
        return false;
    }
}
