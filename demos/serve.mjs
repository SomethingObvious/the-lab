// Serves the real app (computer/template/app) with the scripted mock in
// place of the phone, plus the gallery, so a design can be checked in a
// browser without a Mac or a phone. Run from anywhere: node demos/serve.mjs
import { createServer } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const app = join(root, 'computer', 'template', 'app');
const port = Number(process.env.PORT || 8765);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const [base, rel] = path.startsWith('/app/') ? [app, path.slice(5)] : [root, path.slice(1) || 'demos/index.html'];
  const file = resolve(base, rel || 'index.html');
  if (!file.startsWith(base + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('cache-control', 'no-store');
  if (base === app && rel === 'index.html') {
    res.writeHead(200, { 'content-type': types['.html'] });
    return res.end(readFileSync(file, 'utf8').replace(/<head([^>]*)>/i, '<head$1><script src="/demos/mock-bridge.js"></script>'));
  }
  res.writeHead(200, { 'content-type': types[extname(file).toLowerCase()] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/demos/`));
