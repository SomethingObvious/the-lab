// The app folder his agent edits. Every settled change is snapshotted so
// Undo on the phone can step back through them, and the phone pulls the
// whole folder as one bundle whenever the version changes.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';

const KEEP = 30;
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

  constructor(dir: string, history: string, onChange: (version: string) => void) {
    this.dir = dir;
    this.history = history;
    this.onChange = onChange;
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
    if (v === this.version) return;
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
    this.version = this.hash();
    this.onChange(this.version);
    return true;
  }

  static exists(dir: string) { return existsSync(join(dir, 'index.html')); }
}
