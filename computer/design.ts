// The app folder his agent edits. Every settled change is snapshotted so
// Undo on the phone can step back through them, and the phone pulls the
// whole folder as one bundle whenever the version changes.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';

const KEEP = 30;

// What would leave the phone with a blank screen: no index.html, a script
// that doesn't parse, or JSON that doesn't. `only` checks one file.
export function checkApp(dir: string, only?: string): string | null {
  if (!existsSync(join(dir, 'index.html'))) return 'app/index.html is missing, and the phone needs it to open the app.';
  for (const f of only ? [only] : walk(dir)) {
    const name = 'app/' + relative(dir, f).split(sep).join('/');
    if (!existsSync(f)) continue;
    if (/\.m?js$/.test(f)) {
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
      if (r.status !== 0) return `${name} has a mistake that stops it running: ${(r.stderr || '').replace(f, name).trim().split('\n').filter(Boolean).slice(0, 6).join(' | ').slice(0, 600)}`;
    } else if (f.endsWith('.json')) {
      try { JSON.parse(readFileSync(f, 'utf8')); } catch (e) { return `${name} isn't valid JSON: ${(e as Error).message}`; }
    }
  }
  return null;
}
const MAX_BYTES = 25 * 1024 * 1024;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export class Design {
  version = '';
  private timer: NodeJS.Timeout | null = null;
  private dir: string;
  private history: string;
  private onChange: (version: string) => void;
  private onBroken: (problem: string) => void;
  // Why the newest change was held back, until a later one fixes it.
  broken: string | null = null;

  constructor(dir: string, history: string, onChange: (version: string) => void, onBroken: (problem: string) => void = () => {}) {
    this.dir = dir;
    this.history = history;
    this.onChange = onChange;
    this.onBroken = onBroken;
    mkdirSync(this.history, { recursive: true });
    this.version = this.hash();
    if (this.snapshots().length === 0) this.snapshot();
    watch(this.dir, { recursive: true, persistent: false }, () => {
      if (this.timer) clearTimeout(this.timer);
      // Editors write in bursts (temp file, rename, chmod), so wait for quiet.
      this.timer = setTimeout(() => this.settle(), 600);
    });
  }

  private hash(): string {
    const h = createHash('sha256');
    for (const f of walk(this.dir).sort()) {
      h.update(relative(this.dir, f).split(sep).join('/'));
      h.update(readFileSync(f));
    }
    return h.digest('hex').slice(0, 16);
  }

  private snapshots(): string[] {
    return readdirSync(this.history).filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b));
  }

  private snapshot() {
    cpSync(this.dir, join(this.history, String(Date.now())), { recursive: true, filter: (src) => !src.split(sep).pop()!.startsWith('.') || src === this.dir });
    const all = this.snapshots();
    for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(join(this.history, old), { recursive: true, force: true });
  }

  private settle() {
    let v: string;
    try { v = this.hash(); } catch { return; } // a file vanished mid-walk, the next event retries
    if (v === this.version) { this.broken = null; return; }
    const problem = checkApp(this.dir);
    if (problem) {
      if (problem !== this.broken) { this.broken = problem; this.onBroken(problem); }
      return;
    }
    this.broken = null;
    this.version = v;
    this.snapshot();
    this.onChange(v);
  }

  bundle(): { version: string; files: Record<string, string> } {
    const files: Record<string, string> = {};
    let total = 0;
    for (const f of walk(this.dir)) {
      const data = readFileSync(f);
      total += data.length;
      if (total > MAX_BYTES) throw new Error(`The app folder is over ${MAX_BYTES / 1048576} MB, which is too big to send to the phone.`);
      files[relative(this.dir, f).split(sep).join('/')] = data.toString('base64');
    }
    return { version: this.version, files };
  }

  // Drops the newest snapshot and puts the one before it back.
  undo(): boolean {
    const all = this.snapshots();
    if (all.length < 2) return false;
    rmSync(join(this.history, all.at(-1)!), { recursive: true, force: true });
    const prev = join(this.history, all.at(-2)!);
    for (const name of readdirSync(this.dir)) {
      if (!name.startsWith('.')) rmSync(join(this.dir, name), { recursive: true, force: true });
    }
    cpSync(prev, this.dir, { recursive: true });
    this.broken = null;
    this.version = this.hash();
    this.onChange(this.version);
    return true;
  }

  static exists(dir: string) { return existsSync(join(dir, 'index.html')); }
}
