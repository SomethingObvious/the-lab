// Moves files to the Trash (the Recycle Bin on Windows) instead of deleting
// them, so he can put them back. The agent runs this in place of rm.
//
//   node trash.ts PATH...
//   node trash.ts --restore PATH...   Windows only: puts PATH back from the Recycle Bin
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// macOS 15 ships /usr/bin/trash, which records where each file came from so
// Finder's Put Back works.
const SYSTEM = '/usr/bin/trash';
const WIN = process.platform === 'win32';
// Windows deletes anything too big for the Recycle Bin for good, without
// asking when no one is there to see the prompt, so big items are refused.
// ponytail: fixed cap, the bin's real size per drive is MaxCapacity under
// HKCU\...\Explorer\BitBucket\Volume if this ever turns something away wrongly.
const WIN_CAP = 2 * 1024 ** 3;

function size(p: string, cap: number): number {
  const s = lstatSync(p);
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const name of readdirSync(p)) { total += size(join(p, name), cap - total); if (total > cap) break; }
  return total;
}

function recycle(paths: string[]) {
  const full = paths.map((p) => resolve(p));
  for (const p of full) {
    if (size(p, WIN_CAP) > WIN_CAP) throw new Error(`${basename(p)} is over 2 GB, too big for the Recycle Bin, so it would be deleted for good. Ask him to delete it himself if he wants it gone.`);
  }
  const script = `Add-Type -AssemblyName Microsoft.VisualBasic
$ErrorActionPreference = 'Stop'
foreach ($p in $env:LAB_TRASH_PATHS -split "\`n") {
  if ([System.IO.DriveInfo]::new($p).DriveType -ne 'Fixed') { throw "$p is on a network or removable drive, which has no Recycle Bin, so it was left alone." }
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }
}`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, LAB_TRASH_PATHS: full.join('\n') }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  } catch (e: any) {
    throw new Error(String(e.stderr ?? e.message).split('\n').find((l) => l.trim())?.replace(/^.*?: /, '') ?? 'The Recycle Bin move failed.');
  }
}

// Each deleted item is a $R file in the drive's bin, next to a $I file that
// holds where it came from: a version, its size, when, then the path.
function binEntries(drive: string) {
  const sid = /S-1-[\d-]+/.exec(execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }))?.[0];
  const dir = join(drive, '$Recycle.Bin', sid ?? '');
  if (!sid || !existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith('$I')).map((n) => {
    const b = readFileSync(join(dir, n));
    const v2 = b.readBigInt64LE(0) === 2n;
    const from = (v2 ? b.subarray(28, 28 + (b.readUInt32LE(24) - 1) * 2) : b.subarray(24, 544)).toString('utf16le').replace(/\0.*$/s, '');
    return { info: join(dir, n), item: join(dir, '$R' + n.slice(2)), from, at: b.readBigUInt64LE(16) };
  });
}

export function restore(paths: string[]): string[] {
  if (!WIN) throw new Error('On a Mac, move things back from ~/.Trash with mv.');
  return paths.map((p) => {
    const want = resolve(p);
    const hit = binEntries(parse(want).root).filter((e) => e.from.toLowerCase() === want.toLowerCase() && existsSync(e.item)).sort((a, b) => Number(b.at - a.at))[0];
    if (!hit) throw new Error(`Nothing from ${want} is in the Recycle Bin.`);
    if (existsSync(want)) throw new Error(`${want} is already there, so the copy in the Recycle Bin was left alone.`);
    mkdirSync(dirname(want), { recursive: true });
    renameSync(hit.item, want);
    rmSync(hit.info, { force: true });
    return want;
  });
}

export function trash(paths: string[], bin?: string): string[] {
  const missing = paths.filter((p) => { try { lstatSync(p); return false; } catch { return true; } });
  if (missing.length) throw new Error(`Nothing at ${missing.join(', ')}, so nothing was moved.`);
  if (!bin && WIN) { recycle(paths); return paths; }
  if (!bin && process.platform === 'darwin' && existsSync(SYSTEM)) {
    execFileSync(SYSTEM, paths, { stdio: 'inherit' });
    return paths.map((p) => join(homedir(), '.Trash', basename(p)));
  }
  const to = bin ?? join(homedir(), '.Trash');
  mkdirSync(to, { recursive: true });
  return paths.map((p) => {
    const ext = extname(p), stem = basename(p, ext);
    let dest = join(to, basename(p));
    for (let n = 2; existsSync(dest); n++) dest = join(to, `${stem} ${n}${ext}`);
    renameSync(resolve(p), dest);
    return dest;
  });
}

// The trash command on the agent's PATH. Git Bash runs the sh one, and
// PowerShell and cmd run trash.cmd.
export function launchers(dir: string) {
  const self = fileURLToPath(import.meta.url);
  mkdirSync(dir, { recursive: true });
  const fwd = (p: string) => p.replace(/\\/g, '/');
  writeFileSync(join(dir, 'trash'), `#!/bin/sh\nexec "${fwd(process.execPath)}" "${fwd(self)}" "$@"\n`);
  if (WIN) writeFileSync(join(dir, 'trash.cmd'), `@"${process.execPath}" "${self}" %*\r\n`);
  else chmodSync(join(dir, 'trash'), 0o755);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const back = process.argv.includes('--restore');
  const paths = process.argv.slice(2).filter((a) => a !== '--' && a !== '--restore');
  if (!paths.length) { console.error('Usage: trash PATH...  or  trash --restore PATH...'); process.exit(2); }
  try {
    const done = back ? restore(paths) : trash(paths, process.env.LAB_TRASH_DIR);
    const what = done.length === 1 ? basename(paths[0]) : `${done.length} items`;
    console.log(back ? `Put ${what} back.` : `Moved ${what} to the ${WIN ? 'Recycle Bin' : 'Trash'}.`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
