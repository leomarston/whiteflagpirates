// Production static server for the built game. Zero dependencies.
// Serves dist/ on process.env.PORT (Railway/Render/Fly set this) bound to 0.0.0.0.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const PORT = Number(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

async function tryFile(pathname) {
  // resolve within ROOT; block path traversal
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let filePath = join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) return null;
  try {
    const s = await stat(filePath);
    if (s.isDirectory()) filePath = join(filePath, 'index.html');
    const body = await readFile(filePath);
    return { filePath, body };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let hit = await tryFile(url.pathname === '/' ? '/index.html' : url.pathname);

    // SPA / single-page fallback: unknown non-asset paths serve index.html
    if (!hit && !extname(url.pathname)) hit = await tryFile('/index.html');

    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 — off the edge of the chart.');
      return;
    }

    const ext = extname(hit.filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // hashed assets (Vite emits content-hashed names under /assets) cache hard;
    // html is always revalidated so deploys take effect immediately.
    const cache = hit.filePath.includes(`${'/assets/'}`) && ext !== '.html'
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(hit.body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('500 — the ship has sprung a leak.');
    console.error('[server]', err);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`⚑ WhiteFlagPirates serving dist/ on http://${HOST}:${PORT}`);
});
