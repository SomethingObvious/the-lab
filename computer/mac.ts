// The "Mac at a glance" numbers for the phone.
import { execFile, spawn } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, hostname, totalmem, uptime } from 'node:os';
import { promisify } from 'node:util';
import { config } from './config.ts';

const run = promisify(execFile);
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';
const ps = (script: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 20_000, windowsHide: true });

export type Mac = {
  kind: 'mac';
  name: string;
  os: 'mac' | 'windows' | 'linux';
  battery: { percent: number; charging: boolean } | null;
  disk: { free: number; total: number };
  memory: { free: number; total: number };
  cpu: number;
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

// "72 2" per battery, charge then status, where 2 means it's on mains power.
// Desktops have no battery and print nothing.
export function parseWinBattery(out: string): Mac['battery'] {
  const m = /^(\d+) (\d+)/m.exec(out.trim());
  // Win32_Battery: 2 is on mains, 3 full and 6 to 9 charging. 1, 4 and 5 run on the battery.
  return m ? { percent: Number(m[1]), charging: [2, 3, 6, 7, 8, 9].includes(Number(m[2])) } : null;
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
  if (WIN) {
    const { stdout } = await ps(`Add-Type -Namespace Lab -Name Input -MemberDefinition '[StructLayout(LayoutKind.Sequential)] public struct I { public uint size; public uint time; } [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref I i); public static uint Ms() { var i = new I(); i.size = 8; GetLastInputInfo(ref i); return (uint)Environment.TickCount - i.time; }'; [Lab.Input]::Ms()`);
    return Number(stdout.trim()) / 1000;
  }
  if (!MAC) return Infinity;
  const { stdout } = await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime']);
  const ns = /"HIDIdleTime" = (\d+)/.exec(stdout);
  return ns ? Number(ns[1]) / 1e9 : Infinity;
}

let name = '';

// Busy share of every core since the last call. The first call samples for
// half a second, since the totals since boot say nothing about now.
let last = cpus().map((c) => c.times);
async function cpu(): Promise<number> {
  const tally = (ts: typeof last) => ts.reduce((a, t) => { const all = t.user + t.nice + t.sys + t.idle + t.irq; return { all: a.all + all, idle: a.idle + t.idle }; }, { all: 0, idle: 0 });
  if (!sampled) { sampled = true; last = cpus().map((c) => c.times); await new Promise((r) => setTimeout(r, 500)); }
  const now = cpus().map((c) => c.times);
  const a = tally(last), b = tally(now);
  last = now;
  const all = b.all - a.all;
  return all > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / all)) : 0;
}
let sampled = false;

// macOS counts its file cache as used, so free memory there is what vm_stat
// says could be handed out: free, inactive and speculative pages.
async function memory(): Promise<{ free: number; total: number }> {
  if (!MAC) return { free: freemem(), total: totalmem() };
  const out = (await run('vm_stat').catch(() => ({ stdout: '' }))).stdout;
  const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
  const pages = (k: string) => Number(new RegExp(`Pages ${k}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
  const free = (pages('free') + pages('inactive') + pages('speculative')) * page;
  return { free: free || freemem(), total: totalmem() };
}

export async function mac(): Promise<Mac> {
  if (!name) name = MAC ? (await run('scutil', ['--get', 'ComputerName']).catch(() => null))?.stdout.trim() || hostname() : hostname();
  const fs = await statfs(homedir());
  const battery = MAC ? parseBattery((await run('pmset', ['-g', 'batt']).catch(() => ({ stdout: '' }))).stdout)
    : WIN ? parseWinBattery((await ps('Get-CimInstance Win32_Battery | ForEach-Object { "$($_.EstimatedChargeRemaining) $($_.BatteryStatus)" }').catch(() => ({ stdout: '' }))).stdout) : null;
  return {
    kind: 'mac',
    name: config().name?.trim() || name,
    os: MAC ? 'mac' : WIN ? 'windows' : 'linux',
    battery,
    disk: { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize },
    memory: await memory(),
    cpu: await cpu(),
    uptime: Math.round(uptime()),
    at: new Date().toISOString(),
  };
}

// Holds off idle sleep for as long as this process lives, or until the
// returned function is called. `onPower` only holds it while plugged in, the
// way caffeinate -s does, so a laptop left on battery still sleeps.
export function awake(onPower = false): () => void {
  let p: ReturnType<typeof spawn> | null = null;
  if (MAC) p = spawn('caffeinate', [onPower ? '-s' : '-i', '-w', String(process.pid)], { stdio: 'ignore' });
  else if (WIN) {
    // 2147483649 is ES_CONTINUOUS | ES_SYSTEM_REQUIRED, and 2147483648 lets go.
    const script = `Add-Type -Namespace Lab -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
Add-Type -AssemblyName System.Windows.Forms
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) {
  $on = ${onPower ? '$true' : '$false'} -eq $false -or [System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus -ne 'Offline'
  [void][Lab.Power]::SetThreadExecutionState([uint32]$(if ($on) { 2147483649 } else { 2147483648 }))
  Start-Sleep 30
}`;
    p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  }
  p?.on('error', () => {});
  return () => { p?.kill(); p = null; };
}
