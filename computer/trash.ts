// Moves files to the Trash instead of deleting them, so he can put them back
// from Finder. The agent runs this in place of rm.
//
//   node trash.ts PATH...
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS 15 ships /usr/bin/trash, which records where each file came from so
// Finder's Put Back works.
const SYSTEM = '/usr/bin/trash';

export function trash(paths: string[], bin = join(homedir(), '.Trash')): string[] {
  const missing = paths.filter((p) => { try { lstatSync(p); return false; } catch { return true; } });
  if (missing.length) throw new Error(`Nothing at ${missing.join(', ')}, so nothing was moved.`);
  if (process.platform === 'darwin' && existsSync(SYSTEM) && !process.env.LAB_TRASH_DIR) {
    execFileSync(SYSTEM, paths, { stdio: 'inherit' });
    return paths.map((p) => join(bin, basename(p)));
  }
  mkdirSync(bin, { recursive: true });
  return paths.map((p) => {
    const ext = extname(p), stem = basename(p, ext);
    let to = join(bin, basename(p));
    for (let n = 2; existsSync(to); n++) to = join(bin, `${stem} ${n}${ext}`);
    renameSync(resolve(p), to);
    return to;
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = process.argv.slice(2).filter((a) => a !== '--');
  if (!paths.length) { console.error('Usage: trash PATH...'); process.exit(2); }
  try {
    const moved = trash(paths, process.env.LAB_TRASH_DIR);
    console.log(`Moved ${moved.length === 1 ? basename(paths[0]) : `${moved.length} items`} to the Trash.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
