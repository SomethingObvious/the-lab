// The "Mac at a glance" numbers for the phone.
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { homedir, hostname, uptime } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAC = process.platform === 'darwin';

export type Mac = {
  kind: 'mac';
  name: string;
  battery: { percent: number; charging: boolean } | null;
  disk: { free: number; total: number };
  uptime: number;
  at: string;
};

// pmset says which source it's drawing from ('AC Power' or 'Battery Power'),
// then gives an InternalBattery line with the percentage. Desktop Macs have
// no InternalBattery line.
export function parseBattery(out: string): Mac['battery'] {
  const line = out.split('\n').find((l) => l.includes('InternalBattery'));
  const percent = line && /(\d+)%/.exec(line);
  if (!percent) return null;
  return { percent: Number(percent[1]), charging: out.includes("'AC Power'") };
}

// A Time Machine snapshot of every APFS volume, taken in a second or two.
// tmutil names it by date and macOS keeps it for about a day.
export async function snapshot(): Promise<string> {
  if (!MAC) throw new Error('Snapshots need a Mac.');
  const { stdout } = await run('tmutil', ['localsnapshot'], { timeout: 30_000 });
  const m = /(\d{4}-\d{2}-\d{2}-\d{6})/.exec(stdout);
  if (!m) throw new Error(stdout.trim() || 'tmutil gave no snapshot name');
  return `com.apple.TimeMachine.${m[1]}.local`;
}

// Seconds since the keyboard or mouse was last touched.
export async function idle(): Promise<number> {
  if (!MAC) return Infinity;
  const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime']);
  const ns = /"HIDIdleTime" = (\d+)/.exec(stdout);
  return ns ? Number(ns[1]) / 1e9 : Infinity;
}

let name = '';

export async function mac(): Promise<Mac> {
  if (!name) name = MAC ? (await run('scutil', ['--get', 'ComputerName']).catch(() => null))?.stdout.trim() || hostname() : hostname();
  const fs = await statfs(homedir());
  const battery = MAC ? parseBattery((await run('pmset', ['-g', 'batt']).catch(() => ({ stdout: '' }))).stdout) : null;
  return {
    kind: 'mac',
    name,
    battery,
    disk: { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize },
    uptime: Math.round(uptime()),
    at: new Date().toISOString(),
  };
}
