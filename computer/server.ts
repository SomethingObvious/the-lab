import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, watch, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { extname, join, resolve, sep } from 'node:path';
import { config, home, labDir, setConfig, words } from './config.ts';
import { awake } from './mac.ts';
import { launchers } from './trash.ts';
import { cleanSettings, DEFAULTS, type Settings } from './settings.ts';
import { cleanSchedules, due, GRACE, missed, next, type Schedule } from './schedule.ts';
import { startTunnel } from './tunnel.ts';

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

const writeJson = (file: string, value: unknown) => {
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  renameSync(file + '.tmp', file);
};

if (process.env.LAB_CHILD) serve();
else supervise();

// Keeps one server child alive and holds off system sleep while on power
// for as long as this process lives.
function supervise() {
  const log = join(labDir(), 'server.log');
  // On Windows cmd.exe holds the log open for its redirect, so cutting it
  // can fail. The next start that isn't redirected trims it instead.
  try { if (existsSync(log) && statSync(log).size > 5 * 1024 * 1024) truncateSync(log, 0); } catch (e) { console.error(`${new Date().toISOString()} couldn't trim the log: ${(e as Error).message}`); }
  awake(true);

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
  const { mac, idle } = await import('./mac.ts');
  const { token, port, engine, relay } = config();
  const HOME = home();
  const DIR = labDir();
  const appDir = join(HOME, 'app');
  const settingsFile = join(HOME, 'settings.json');
  const readSettings = () => { try { return cleanSettings(JSON.parse(readFileSync(settingsFile, 'utf8'))); } catch { return null; } };
  let settings: Settings = readSettings() ?? { ...DEFAULTS };
  // A model picked under Claude means nothing to Codex, so it only counts for
  // the engine it was picked on.
  const picked = () => (typeof settings.model === 'string' && settings.model && (!settings.modelEngine || settings.modelEngine === engine) && settings.model) || process.env.LAB_MODEL || undefined;
  const lab = new Lab({ home: HOME, dir: DIR, model: picked(), engine });

  // The agent deletes with this, which moves files to the Trash.
  launchers(join(DIR, 'bin'));

  // Codex has no send_to_phone tool, so it copies files in here instead.
  const toPhone = join(HOME, 'to-phone');
  const drop = async (name: string) => {
    const p = join(toPhone, name);
    if (name.startsWith('.') || !existsSync(p) || !statSync(p).isFile()) return;
    // Wait until the copy has finished growing.
    for (let size = -1; size !== statSync(p).size;) { size = statSync(p).size; await new Promise((r) => setTimeout(r, 800)); }
    const r = await lab.sendFile(p);
    if ('isError' in r) lab.store.add({ kind: 'notice', text: `Couldn't send ${name} to your phone. ${r.content[0].text}` });
    rmSync(p, { force: true });
  };
  const sending = new Set<string>();
  let watcher: ReturnType<typeof watch> | null = null;
  // Deleting the folder used to take the server down, so it's put back, and
  // watched again, whenever it goes missing.
  const sweep = () => {
    try {
      if (!existsSync(toPhone)) { watcher?.close(); watcher = null; }
      mkdirSync(toPhone, { recursive: true });
      watcher ??= watch(toPhone, { persistent: false }, sweep).on('error', () => { watcher?.close(); watcher = null; });
      for (const name of readdirSync(toPhone)) {
        if (sending.has(name)) continue;
        sending.add(name);
        drop(name).catch((e) => console.error('to-phone:', e)).finally(() => sending.delete(name));
      }
    } catch (e) { console.error('to-phone:', e); }
  };
  sweep();
  setInterval(sweep, 60_000).unref();
  // A change to app/ that can't run stays on the computer. The agent hears why,
  // and he hears about it once the turn is over.
  let told = '';
  const HELD = 'Your last change to app/ was held back';
  const design = new Design(appDir, join(DIR, 'design-history'), (version) => { lab.unnote(HELD); lab.store.live({ kind: 'design', version }); },
    (problem) => lab.note(`${HELD} from the phone because ${problem} Fix that first.`));
  lab.store.listen((e) => {
    if (e.kind !== 'done' || !design.broken || told === design.broken) return;
    told = design.broken;
    // After this done has reached every listener, so it keeps the lower id.
    setImmediate(() => lab.store.add({ kind: 'notice', text: 'The last change to this app had a mistake in it, so your phone kept the version before. Ask for it again, or tap Fix It.', action: { label: 'Fix It', send: 'Your last change to the app had a mistake in it, so my phone kept the version before. Fix it and tell me what was wrong.' } }));
  });

  // What the page on the phone reports going wrong, for the agent to fix.
  const errorsFile = join(DIR, 'app-errors.log');
  let undoneTo: string | null = null;
  const reported = new Set<string>();
  const bridge = readFileSync(new URL('./web-bridge.js', import.meta.url));
  const want = Buffer.from(token);
  // The agent can't read the token, so it checks a design change through
  // this link instead. It only reads, and never reaches the pairing QR, so it
  // can't answer its own Allow cards or pair a phone.
  const previewFile = join(DIR, 'preview-link');
  const preview = Buffer.from(randomBytes(24).toString('base64url'));
  writeFileSync(previewFile, `http://127.0.0.1:${port}/pair?p=${preview}
`, { mode: 0o600 });

  let macNow = await mac().catch(() => null);
  setInterval(async () => {
    macNow = await mac().catch(() => macNow);
    if (macNow) lab.store.live(macNow);
  }, 60_000).unref();

  // While The Lab is open and in front on the computer and he's using it, the
  // phone doesn't buzz for what he can already see.
  let atMacUntil = 0;
  lab.store.atMac = () => Date.now() < atMacUntil;

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
  let sentSettings = JSON.stringify(settings);
  const pushSettings = () => {
    lab.setModel(picked());
    if (JSON.stringify(settings) === sentSettings) return;
    sentSettings = JSON.stringify(settings);
    lab.store.live({ kind: 'settings', values: settings });
  };
  const settle: Record<string, NodeJS.Timeout> = {};
  watch(HOME, { persistent: false }, (_, name) => {
    if (name !== 'shortcuts.json' && name !== 'settings.json') return;
    clearTimeout(settle[name]);
    // A half-written or broken file keeps the last good one.
    settle[name] = setTimeout(() => {
      if (name === 'shortcuts.json') { shortcuts = readShortcuts() ?? shortcuts; pushShortcuts(); }
      else { settings = readSettings() ?? settings; pushSettings(); }
    }, 300);
  });

  // ---------- schedules ----------

  const schedulesFile = join(HOME, 'schedules.json');
  const ranFile = join(DIR, 'schedules-ran.json');
  type Run = { at: string; result: 'ok' | 'silent' | 'failed' | 'stopped'; fails: number };
  let ran: { keys: string[]; known: string[]; checked?: string; last: Record<string, Run> } = { keys: [], known: [], last: {} };
  try { ran = { ...ran, ...JSON.parse(readFileSync(ranFile, 'utf8')) }; } catch { /* nothing has run yet */ }
  const saveRan = () => writeJson(ranFile, ran);
  let schedules: Schedule[] = [];
  const readSchedules = () => {
    if (!existsSync(schedulesFile)) return;
    try { schedules = cleanSchedules(JSON.parse(readFileSync(schedulesFile, 'utf8'))) ?? schedules; } catch { /* a broken file keeps the last good list */ }
  };
  // The you event of each scheduled run still going, so its done can be
  // put down as that entry's last result.
  const running = new Map<number, string>();
  let silentSeen = false;
  lab.store.listen((e) => {
    if (!('id' in e)) return;
    if (e.kind === 'reply' && e.silent) silentSeen = true;
    if (e.kind !== 'done') return;
    for (const [you, id] of running) {
      if (e.upto && you > Number(e.upto)) continue;
      running.delete(you);
      const prev = ran.last[id];
      const result: Run['result'] = e.stopped ? 'stopped' : !e.ok ? 'failed' : silentSeen ? 'silent' : 'ok';
      const fails = result === 'failed' ? (prev?.fails ?? 0) + 1 : 0;
      ran.last[id] = { at: e.at, result, fails };
      const item = schedules.find((s) => s.id === id);
      // Once, at the third, rather than every time after.
      if (fails === 3 && item) lab.store.add({ kind: 'notice', text: `"${item.label}" has failed three times in a row. Ask the agent to look into it, or pause it under Schedules.` });
    }
    silentSeen = false;
    saveRan();
  });

  setInterval(() => {
    // The page hangs every event on the newest turn, so a run mid-request
    // would take over the one he's in. It isn't marked as run, so it goes
    // on the first idle tick inside the grace window.
    if (lab.status.working) return;
    readSchedules();
    const now = new Date();
    const keys = new Set(ran.keys);
    const fresh = new Set(schedules.map((s) => s.id).filter((id) => !ran.known.includes(id)));
    const old = schedules.filter((s) => !fresh.has(s.id));
    // Runs too late to send now. Nothing is replayed, he just hears about it.
    for (const m of ran.checked ? missed(old, new Date(Date.parse(ran.checked) - GRACE), now, keys) : []) {
      keys.add(m.key);
      const when = m.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      const after = next(m.item, now);
      lab.store.add({
        kind: 'notice',
        text: `"${m.item.label}" didn't run at ${when}, because the computer was asleep, off or busy. ${after ? `It runs next ${after.toDateString() === now.toDateString() ? 'today' : 'on ' + after.toLocaleDateString([], { weekday: 'long' })} at ${after.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : "It won't run again."}`,
        action: { label: 'Run It Now', send: m.item.text },
      });
    }
    for (const { item, key } of due(schedules, now, keys)) {
      keys.add(key);
      // A new entry whose time already passed today waits for its next one.
      if (fresh.has(item.id)) continue;
      lab.send(item.text, randomUUID(), [], { label: item.label, quiet: item.quiet });
      const you = lab.store.events.findLast((e) => e.kind === 'you');
      if (you) running.set(you.id, item.id);
      // The page shows one run at a time, so the rest wait for the next tick.
      break;
    }
    ran = { ...ran, keys: [...keys].slice(-500), known: [...new Set([...ran.known, ...fresh])].slice(-500), checked: now.toISOString() };
    saveRan();
  }, 20_000).unref();

  const scheduleView = () => {
    readSchedules();
    const now = new Date();
    return schedules.map((s) => ({ ...s, next: next(s, now)?.toISOString() ?? null, last: ran.last[s.id] ?? null }));
  };

  // ---------- pairing ----------

  // One-time codes. A scanned QR code turns into a second, shorter-lived
  // code the app trades for the token, so the token itself never sits in
  // the phone browser's history.
  const codes = new Map<string, { until: number; kind: 'scan' | 'claim' }>();
  const code = (kind: 'scan' | 'claim', ms: number) => {
    const c = randomBytes(12).toString('base64url');
    codes.set(c, { until: Date.now() + ms, kind });
    return c;
  };
  const spend = (c: string, kind: 'scan' | 'claim') => {
    const got = codes.get(c);
    codes.delete(c);
    return !!got && got.kind === kind && got.until > Date.now();
  };
  const urlFile = join(DIR, 'url');

  const tunnel = startTunnel({ dir: DIR, port, relay, lanPort: port + 1, lanHost: process.env.LAB_LAN_HOST });
  const reach = () => ({ kind: 'reach' as const, lan: tunnel.spec().lan, relay: relay ?? null });
  // Everything the phone needs to find and trust this computer. The Pixel
  // camera opens a thelab:// link straight into the app (it won't follow an
  // intent:// one), so none of it passes through a web page.
  const pairLink = (claim: string) => {
    const s = tunnel.spec();
    return `thelab://pair?${new URLSearchParams({ r: s.relay ?? '', o: s.room, k: s.key, p: s.pass, l: s.lan.join(','), c: claim })}`;
  };

  // Behind tailscale serve every request carries the Tailscale login it came
  // from. The phone's is kept at the first visit, and a request from any
  // other login is turned away even with the right token.
  const login = (req: IncomingMessage) => String(req.headers['tailscale-user-login'] ?? '');
  const sameLogin = (req: IncomingMessage) => {
    const who = login(req);
    if (!who) return true;
    if (!lab.state.login) { lab.state.login = who; lab.save(); }
    return lab.state.login === who;
  };

  const authed = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const cookie = /(?:^|;\s*)lab=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : decodeURIComponent(cookie));
    return got.length === want.length && timingSafeEqual(got, want) && sameLogin(req);
  };
  const previewing = (req: IncomingMessage, path: string) => {
    const got = Buffer.from(decodeURIComponent(/(?:^|;\s*)labp=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''));
    return req.method === 'GET' && path !== '/pair-phone' && got.length === preview.length && timingSafeEqual(got, preview);
  };

  const json = (res: ServerResponse, status: number, body: any) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(typeof body?.error === 'string' ? { ...body, error: words(body.error) } : body));
  };
  const html = (res: ServerResponse, status: number, title: string, body: string) => {
    res.writeHead(status, { 'content-type': TYPES['.html'], 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${words(title)}</title><style>body{font:18px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;color:#1d1b20;background:#fdf7ff}h1{font-size:1.6rem;line-height:1.2}a.btn{display:inline-block;background:#5a2ee6;color:#fff;padding:.9rem 1.6rem;border-radius:2rem;text-decoration:none;font-weight:600}img{width:100%;max-width:22rem;display:block;margin:1.5rem 0;image-rendering:pixelated}@media (prefers-color-scheme:dark){body{background:#141218;color:#e6e0e9}}</style></head><body>${words(body)}</body></html>`);
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
    res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ server: pkg.version, design: design.version, status: lab.status, mac: macNow, shortcuts, live: [{ kind: 'settings', values: settings }, reach()] })}\n\n`);
    // Replay and subscribe in the same tick, so nothing can land in between.
    for (const e of lab.store.since(Number.isFinite(after) ? after : null)) res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
    res.write('event: loaded\ndata: {}\n\n');
    const off = lab.store.listen((e) => res.write('id' in e ? `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n` : `data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { off(); clearInterval(ping); });
  };

  // What the Check Setup button reports, in his words.
  const check = async () => {
    const { claudeSignedIn, codexSignedIn, tailscaleState } = await import('./checks.ts');
    const out: { ok: boolean; title: string; detail?: string }[] = [{ ok: true, title: `The Lab ${pkg.version} is running on the computer` }];
    const signed = engine === 'codex' ? codexSignedIn() : claudeSignedIn().loggedIn;
    out.push(signed ? { ok: true, title: `Signed in to ${engine === 'codex' ? 'ChatGPT' : 'Claude'}` }
      : { ok: false, title: `Signed out of ${engine === 'codex' ? 'ChatGPT' : 'Claude'}`, detail: `Open the ${engine === 'codex' ? 'Codex' : 'Claude'} app on the computer and ask it to sign The Lab back in.` });
    const t = tunnel.state;
    if (t.relay === 'connected') out.push({ ok: true, title: 'Connected to the relay, so the phone can reach the computer from anywhere' });
    else if (t.relay === 'off') out.push({ ok: false, title: 'No relay is set up', detail: existsSync(urlFile) ? 'The phone reaches the computer on the same Wi-Fi or through Tailscale. Ask the agent on the computer to set up the relay so it works everywhere.' : 'The phone only reaches the computer on the same Wi-Fi. Ask the agent on the computer to set up the relay so it works everywhere.' });
    else out.push({ ok: false, title: "Can't reach the relay", detail: `The phone can still reach the computer on the same Wi-Fi. The relay link is ${t.relay}.` });
    out.push(t.lan === 'on' ? { ok: true, title: 'Listening on the local network' } : { ok: false, title: "Not listening on the local network", detail: `The phone can't reach the computer directly on the same Wi-Fi (${t.lan}).` });
    if (existsSync(urlFile)) {
      const ts = tailscaleState();
      out.push(ts.installed && 'running' in ts && ts.running ? { ok: true, title: 'Tailscale is running on the computer' } : { ok: false, title: 'Tailscale is off on the computer', detail: 'The relay and the local network still work. Open Tailscale and sign in to use it too.' });
    }
    const m = await mac().catch(() => null);
    if (m?.battery && !m.battery.charging) out.push({ ok: false, title: `The computer is on battery (${m.battery.percent}%)`, detail: 'It will go to sleep when idle. Plug it in to keep The Lab going.' });
    if (m && m.disk.free < 5e9) out.push({ ok: false, title: 'The computer is nearly out of space', detail: 'Ask the agent what is taking up room.' });
    if (process.platform === 'darwin') out.push(lab.snapshotAt ? { ok: true, title: 'Time Machine snapshots are working' } : { ok: false, title: 'No Time Machine snapshot yet', detail: 'One is taken before each task. If this stays, turn on Time Machine in System Settings.' });
    const mem = lab.memory();
    if (mem.chars > mem.cap * 0.8) out.push({ ok: false, title: 'Memory is nearly full', detail: 'Open Memory and remove what is no longer true.' });
    return out;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://lab');
    const path = decodeURIComponent(url.pathname);
    try {
      if (path === '/health') return json(res, 200, { ok: true, server: pkg.version });
      if (path === '/pair' && req.method === 'GET') {
        // Scanned from the QR code on the phone, inside Tailscale.
        const c = url.searchParams.get('c');
        if (c !== null) {
          if (!spend(c, 'scan')) return html(res, 410, 'Pairing Link Used', '<h1>That Code Has Expired</h1><p>Each code works once, for 10 minutes. Ask the agent on the computer for a new one.</p>');
          const base = existsSync(urlFile) ? readFileSync(urlFile, 'utf8').trim() : `https://${req.headers.host}`;
          const claim = code('claim', 120_000);
          const intent = `intent://pair?u=${encodeURIComponent(base)}&c=${claim}#Intent;scheme=thelab;package=com.somethingobvious.thelab;end`;
          return html(res, 200, 'Pair The Lab', `<h1>Pair This Phone With Your Computer</h1><p>Tap the button to open The Lab and finish pairing.</p><p><a class="btn" href="${intent}">Open The Lab</a></p>`);
        }
        const pv = Buffer.from(url.searchParams.get('p') ?? '');
        if (pv.length) {
          if (pv.length !== preview.length || !timingSafeEqual(pv, preview)) return json(res, 401, { error: 'That preview link is from before a restart. Read preview-link again.' });
          res.writeHead(303, { 'set-cookie': `labp=${preview}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
          return res.end();
        }
        const t = url.searchParams.get('t') ?? '';
        if (Buffer.from(t).length !== want.length || !timingSafeEqual(Buffer.from(t), want)) return json(res, 401, { error: 'That pairing link is not valid.' });
        const nextPath = url.searchParams.get('next') === '/pair-phone' ? '/pair-phone' : '/';
        res.writeHead(303, { 'set-cookie': `lab=${encodeURIComponent(t)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, location: nextPath });
        return res.end();
      }
      if (path === '/pair/claim' && req.method === 'POST') {
        const { code: c } = await body(req);
        if (typeof c !== 'string' || !spend(c, 'claim')) return json(res, 410, { error: 'That pairing code has expired. Scan a new one on the computer.' });
        if (login(req)) { lab.state.login = login(req); lab.save(); }
        return json(res, 200, { token });
      }
      if (!authed(req) && !previewing(req, path)) return json(res, 401, { error: req.method === 'GET' ? 'Not paired with this computer.' : 'The preview only looks. Send from the phone instead.' });

      if (req.method === 'GET' && path === '/pair-phone') {
        if (!relay && !existsSync(urlFile)) return html(res, 409, 'Pair a Phone', '<h1>There Is No Relay Yet</h1><p>Pair the phone over its USB cable instead, or ask the agent on the computer to set up the relay first.</p>');
        const { qrSvg } = await import('./qr.ts');
        const link = relay ? pairLink(code('claim', 10 * 60_000)) : `${readFileSync(urlFile, 'utf8').trim()}/pair?c=${code('scan', 10 * 60_000)}`;
        const img = `data:image/svg+xml;base64,${Buffer.from(qrSvg(link)).toString('base64')}`;
        return html(res, 200, 'Pair a Phone', `<h1>Point the Phone's Camera at This</h1><p>${relay ? 'Tap the link the camera finds and The Lab opens.' : 'Turn on Tailscale on the phone first.'} The code works once and lasts 10 minutes.</p><img src="${img}" alt="Pairing code"><p>Reload this page for a new code.</p>`);
      }
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
        writeJson(shortcutsFile, items);
        shortcuts = items;
        pushShortcuts();
        return json(res, 200, { items });
      }
      if (req.method === 'POST' && path === '/stop') { await lab.stop(); return json(res, 202, {}); }
      // Setup calls this after an update or a new relay. The supervisor
      // starts a fresh child, which reads the new code and config.
      if (req.method === 'POST' && path === '/restart') {
        json(res, 202, {});
        setTimeout(() => process.exit(0), 200);
        return;
      }
      if (req.method === 'POST' && path === '/answer') {
        const { ref, allow, always } = await body(req);
        return lab.answer(String(ref), allow === true, always === true) ? json(res, 200, {}) : json(res, 404, { error: 'That question was already answered or has expired.' });
      }
      if (path === '/memory') {
        if (req.method === 'POST') {
          const b = await body(req);
          const list = (a: unknown) => Array.isArray(a) ? a.filter((s) => typeof s === 'string' && s.trim()).map((s: string) => s.trim().slice(0, 500)).slice(0, 100) : undefined;
          return json(res, 200, lab.saveMemory({ about: list(b.about), notes: list(b.notes), ...(typeof b.paused === 'boolean' ? { paused: b.paused } : {}) }));
        }
        return json(res, 200, lab.memory());
      }
      if (path === '/schedules') {
        if (req.method === 'POST') {
          const items = cleanSchedules((await body(req)).items);
          if (!items) return json(res, 400, { error: 'items must be a list of { label, text, time }.' });
          writeJson(schedulesFile, items);
          schedules = items;
        }
        return json(res, 200, { items: scheduleView() });
      }
      if (path === '/allowed') {
        if (req.method === 'POST') {
          const { remove } = await body(req);
          if (Number.isInteger(remove)) { lab.rules.splice(remove, 1); lab.saveRules(); }
        }
        // The page shows where each rule applies, so the agent's own folder gets a name.
        return json(res, 200, { items: lab.rules.map((r) => ({ ...r, where: r.cwd === HOME ? 'In your Lab folder' : r.cwd.startsWith(HOME + sep) ? `In ${r.cwd.slice(HOME.length + 1)} in your Lab folder` : `In ${r.cwd}` })) });
      }
      if (path === '/settings') {
        if (req.method === 'POST') {
          const { values } = await body(req);
          const next = cleanSettings({ ...settings, ...(values && typeof values === 'object' ? values : {}) });
          if (!next) return json(res, 400, { error: 'values must be an object of settings.' });
          writeJson(settingsFile, next);
          settings = next;
          pushSettings();
        }
        return json(res, 200, { values: settings });
      }
      if (req.method === 'GET' && path === '/models') return json(res, 200, await lab.models());
      if (req.method === 'POST' && path === '/model') {
        const { model } = await body(req);
        if (model !== null && (typeof model !== 'string' || !/^[\w.:/@\[\]-]{1,120}$/.test(model))) return json(res, 400, { error: `That isn't a model name: ${JSON.stringify(model)}.` });
        settings = cleanSettings({ ...settings, model: model === 'default' ? null : model, modelEngine: model && model !== 'default' ? engine : null })!;
        writeJson(settingsFile, settings);
        pushSettings();
        return json(res, 200, { chosen: settings.model });
      }
      if (req.method === 'POST' && path === '/app-error') {
        const { message, where, version, fatal } = await body(req);
        const text = String(message ?? '').slice(0, 500);
        // Reports from an older version of the app are already gone.
        if (!text || (version && version !== design.version)) return json(res, 200, {});
        appendFileSync(errorsFile, `${new Date().toISOString()} ${design.version} ${String(where ?? '').slice(0, 80)} ${text}\n`);
        if (statSync(errorsFile).size > 1024 * 1024) truncateSync(errorsFile, 0);
        if (fatal === true && version === undoneTo) {
          lab.note(`The phone still couldn't open the app after the server put the earlier version back (${text}), so it left it there. The cause may be on the phone, not in app/.`);
        } else if (fatal === true && design.undo()) {
          undoneTo = design.version;
          lab.store.add({ kind: 'notice', text: "The last change to this app didn't open on your phone, so the version before it is back." });
          lab.note(`Your last change to app/ stopped the phone app from opening (${text}), so the server put the version before it back. Find what broke before trying again.`);
        } else if (!reported.has(text) && reported.size < 20) {
          reported.add(text);
          lab.note(`The phone app hit an error in ${String(where ?? 'the page').slice(0, 80)}: "${text}". If it comes from a change you made to app/, fix it.`);
        }
        return json(res, 200, {});
      }
      if (req.method === 'POST' && path === '/name') {
        const { name } = await body(req);
        if (typeof name !== 'string' || name.trim().length > 40) return json(res, 400, { error: 'A name has to be 40 characters or fewer.' });
        // A blank name goes back to the one the computer calls itself.
        setConfig({ name: name.trim() || undefined });
        macNow = await mac().catch(() => macNow);
        if (macNow) lab.store.live(macNow);
        return json(res, 200, { name: macNow?.name ?? name.trim() });
      }
      if (req.method === 'GET' && path === '/check') return json(res, 200, { items: (await check()).map((i) => ({ ...i, title: words(i.title), ...(i.detail ? { detail: words(i.detail) } : {}) })) });
      if (req.method === 'POST' && path === '/presence') {
        // Only counts when someone is actually at the keyboard, so a browser
        // tab left open in front doesn't silence the phone all evening.
        if ((await idle().catch(() => Infinity)) < 120) atMacUntil = Date.now() + 45_000;
        return json(res, 200, {});
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
      // the computer itself.
      if (req.method === 'GET') {
        const p = resolve(appDir, '.' + (path === '/' ? '/index.html' : path));
        if (!p.startsWith(appDir + sep) || !existsSync(p) || !statSync(p).isFile()) return json(res, 404, { error: `No such file: ${path}` });
        if (p.endsWith('index.html')) {
          const page = readFileSync(p, 'utf8').replace(/<head([^>]*)>/i, '<head$1><script src="/web-bridge.js"></script>');
          res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
          return res.end(page);
        }
        return file(res, p, { 'cache-control': 'no-store' });
      }
      json(res, 404, { error: `No route for ${req.method} ${path}` });
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(`${new Date().toISOString()} The Lab ${pkg.version} on 127.0.0.1:${port}, home ${HOME}`));
  // Addresses change when the computer moves networks, so the phone hears
  // the new ones over whichever route still works.
  let sentReach = JSON.stringify(reach());
  setInterval(() => {
    const now = reach();
    if (JSON.stringify(now) === sentReach) return;
    sentReach = JSON.stringify(now);
    lab.store.live(now);
  }, 60_000).unref();
}
