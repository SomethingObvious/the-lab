import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, renameSync, statSync, truncateSync, watch, writeFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { config, home } from './config.ts';
import { cleanSchedules, due, type Schedule } from './schedule.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.zip': 'application/zip', '.heic': 'image/heic',
};
const typeOf = (p: string) => TYPES[extname(p).toLowerCase()] ?? 'application/octet-stream';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

type Shortcut = { id: string; label: string; text: string };
// The agent edits shortcuts.json by hand too, so bad entries are dropped
// rather than failing the whole list.
const cleanShortcuts = (a: unknown): Shortcut[] | null => !Array.isArray(a) ? null : a
  .filter((s) => typeof s?.label === 'string' && typeof s?.text === 'string' && s.label.trim() && s.text.trim())
  .slice(0, 50)
  .map((s) => ({ id: typeof s.id === 'string' && s.id ? s.id.slice(0, 64) : randomUUID(), label: s.label.trim().slice(0, 40), text: s.text.trim().slice(0, 2000) }));

if (process.env.LAB_CHILD) serve();
else supervise();

// Keeps one server child alive and, on a Mac, holds off system sleep while
// on power for as long as this process lives.
function supervise() {
  const log = join(home(), '.lab', 'server.log');
  if (existsSync(log) && statSync(log).size > 5 * 1024 * 1024) truncateSync(log, 0);
  if (process.platform === 'darwin') spawn('caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });

  let child: ReturnType<typeof spawn> | null = null;
  let quickExits = 0;
  const run = () => {
    const started = Date.now();
    child = spawn(process.execPath, process.argv.slice(1), { env: { ...process.env, LAB_CHILD: '1' }, stdio: 'inherit' });
    child.on('exit', (code, signal) => {
      child = null;
      quickExits = Date.now() - started < 10_000 ? quickExits + 1 : 0;
      const wait = Math.min(2000 * 2 ** quickExits, 60_000);
      console.error(`${new Date().toISOString()} server exited (${signal ?? code}), restarting in ${wait / 1000}s`);
      setTimeout(run, wait);
    });
  };
  run();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => { child?.kill(sig); process.exit(0); });
  }
}

async function serve() {
  // Loaded here so the supervisor never pays for the SDK.
  const { Lab } = await import('./lab.ts');
  const { Design } = await import('./design.ts');
  const { token, port } = config();
  const HOME = home();
  const appDir = join(HOME, 'app');
  const lab = new Lab({ home: HOME, model: process.env.LAB_MODEL || undefined });
  const design = new Design(appDir, join(HOME, '.lab', 'design-history'), (version) => lab.store.live({ kind: 'design', version }));
  const bridge = readFileSync(new URL('./web-bridge.js', import.meta.url));
  const want = Buffer.from(token);

  const { mac } = await import('./mac.ts');
  let macNow = await mac().catch(() => null);
  setInterval(async () => {
    macNow = await mac().catch(() => macNow);
    if (macNow) lab.store.live(macNow);
  }, 60_000).unref();

  const shortcutsFile = join(HOME, 'shortcuts.json');
  const readShortcuts = () => {
    try { return cleanShortcuts(JSON.parse(readFileSync(shortcutsFile, 'utf8'))); } catch { return null; }
  };
  let shortcuts = readShortcuts() ?? [];
  let sent = JSON.stringify(shortcuts);
  const pushShortcuts = () => {
    if (JSON.stringify(shortcuts) === sent) return;
    sent = JSON.stringify(shortcuts);
    lab.store.live({ kind: 'shortcuts', items: shortcuts });
  };
  let settle: NodeJS.Timeout | undefined;
  watch(HOME, { persistent: false }, (_, name) => {
    if (name !== 'shortcuts.json') return;
    clearTimeout(settle);
    // A half-written or broken file keeps the last good list.
    settle = setTimeout(() => { shortcuts = readShortcuts() ?? shortcuts; pushShortcuts(); }, 300);
  });

  const schedulesFile = join(HOME, 'schedules.json');
  const ranFile = join(HOME, '.lab', 'schedules-ran.json');
  let ran: { keys: string[]; known: string[] } = { keys: [], known: [] };
  try { ran = { ...ran, ...JSON.parse(readFileSync(ranFile, 'utf8')) }; } catch { /* nothing has run yet */ }
  let schedules: Schedule[] = [];
  setInterval(() => {
    if (existsSync(schedulesFile)) {
      try { schedules = cleanSchedules(JSON.parse(readFileSync(schedulesFile, 'utf8'))) ?? schedules; } catch { /* a broken file keeps the last good list */ }
    }
    const keys = new Set(ran.keys);
    const fresh = new Set(schedules.map((s) => s.id).filter((id) => !ran.known.includes(id)));
    const runs = due(schedules, new Date(), keys);
    if (!runs.length && !fresh.size) return;
    for (const { item, key } of runs) {
      keys.add(key);
      // A new entry whose time already passed today waits for its next one.
      if (!fresh.has(item.id)) lab.send(item.text, randomUUID(), [], item.label);
    }
    ran = { keys: [...keys].slice(-500), known: [...new Set([...ran.known, ...fresh])].slice(-500) };
    writeFileSync(ranFile + '.tmp', JSON.stringify(ran));
    renameSync(ranFile + '.tmp', ranFile);
  }, 20_000).unref();

  const authed = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const cookie = /(?:^|;\s*)lab=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : decodeURIComponent(cookie));
    return got.length === want.length && timingSafeEqual(got, want);
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const body = (req: IncomingMessage): Promise<any> => new Promise((ok, fail) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) { fail(new Error('Request body is over 256 KB.')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { fail(new Error('Request body is not JSON.')); } });
    req.on('error', fail);
  });

  const file = (res: ServerResponse, path: string, extra: Record<string, string> = {}) => {
    const size = statSync(path).size;
    res.writeHead(200, { 'content-type': typeOf(path), 'content-length': size, ...extra });
    createReadStream(path).pipe(res);
  };

  const events = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const raw = req.headers['last-event-id'] ?? url.searchParams.get('after');
    const after = raw === undefined || raw === null || raw === '' ? null : Number(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ server: pkg.version, design: design.version, status: lab.status, mac: macNow, shortcuts })}\n\n`);
    // Replay and subscribe in the same tick, so nothing can land in between.
    for (const e of lab.store.since(Number.isFinite(after) ? after : null)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write('event: loaded\ndata: {}\n\n');
    const off = lab.store.listen((e) => res.write('id' in e ? `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(ping); });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab');
    const path = decodeURIComponent(url.pathname);
    try {
      if (path === '/health') return json(res, 200, { ok: true, server: pkg.version });
      if (path === '/pair' && req.method === 'GET') {
        const t = url.searchParams.get('t') ?? '';
        if (Buffer.from(t).length !== want.length || !timingSafeEqual(Buffer.from(t), want)) return json(res, 401, { error: 'That pairing link is not valid.' });
        res.writeHead(303, { 'set-cookie': `lab=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: '/' });
        return res.end();
      }
      if (!authed(req)) return json(res, 401, { error: 'Not paired with this computer.' });

      if (req.method === 'GET' && path === '/events') return events(req, res, url);
      if (req.method === 'POST' && path === '/send') {
        const { text, cid, files } = await body(req);
        const attached = files === undefined ? [] : lab.attached(files);
        if (typeof text !== 'string' || text.length > 50_000 || (!text.trim() && !attached.length)) return json(res, 400, { error: 'A message needs text (up to 50,000 characters) or a file.' });
        if (typeof cid !== 'string' || !UUID.test(cid)) return json(res, 400, { error: `cid must be a UUID, got ${JSON.stringify(cid)}.` });
        return json(res, 202, { accepted: lab.send(text.trim(), cid.toLowerCase(), attached) });
      }
      if (req.method === 'POST' && path === '/upload') {
        const name = url.searchParams.get('name') ?? '';
        const given = String(req.headers['content-type'] ?? '').split(';')[0];
        const type = given && given !== 'application/octet-stream' ? given : typeOf(name);
        return json(res, 200, await lab.upload(name, type, req));
      }
      if (req.method === 'POST' && path === '/shortcuts') {
        const items = cleanShortcuts((await body(req)).items);
        if (!items) return json(res, 400, { error: 'items must be a list of { label, text }.' });
        writeFileSync(shortcutsFile + '.tmp', JSON.stringify(items, null, 2) + '\n');
        renameSync(shortcutsFile + '.tmp', shortcutsFile);
        shortcuts = items;
        pushShortcuts();
        return json(res, 200, { items });
      }
      if (req.method === 'POST' && path === '/stop') { await lab.stop(); return json(res, 202, {}); }
      if (req.method === 'POST' && path === '/answer') {
        const { ref, allow } = await body(req);
        return lab.answer(String(ref), allow === true) ? json(res, 200, {}) : json(res, 404, { error: 'That question was already answered or has expired.' });
      }
      if (req.method === 'GET' && path === '/design') return json(res, 200, design.bundle());
      if (req.method === 'POST' && path === '/design/undo') return json(res, design.undo() ? 200 : 409, { version: design.version });
      if (req.method === 'GET' && path.startsWith('/files/')) {
        const p = lab.fileFor(path.slice(7));
        return p ? file(res, p, { 'cache-control': 'private, max-age=31536000, immutable' }) : json(res, 404, { error: 'That file is gone.' });
      }
      if (req.method === 'GET' && path === '/web-bridge.js') {
        res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
        return res.end(bridge);
      }
      // The desktop view of the same app, for checking a design change on
      // the Mac itself.
      if (req.method === 'GET') {
        const p = resolve(appDir, '.' + (path === '/' ? '/index.html' : path));
        if (!p.startsWith(appDir + sep) || !existsSync(p) || !statSync(p).isFile()) return json(res, 404, { error: `No such file: ${path}` });
        if (p.endsWith('index.html')) {
          const html = readFileSync(p, 'utf8').replace(/<head([^>]*)>/i, '<head$1><script src="/web-bridge.js"></script>');
          res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
          return res.end(html);
        }
        return file(res, p, { 'cache-control': 'no-store' });
      }
      json(res, 404, { error: `No route for ${req.method} ${path}` });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`${new Date().toISOString()} The Lab ${pkg.version} on 127.0.0.1:${port}, home ${HOME}`));
}
