// Moves files to the Trash (the Recycle Bin on Windows) instead of deleting
// them, so he can put them back. The agent runs this in place of rm.
//
//   node trash.ts PATH...
//   node trash.ts --restore PATH...   Windows only: puts PATH back from the Recycle Bin
import { execFile, execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import process, { env } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setting } from "./config.ts";

// macOS 15 ships /usr/bin/trash, which records where each file came from so
// Finder's Put Back works.
const SYSTEM = "/usr/bin/trash";
const WIN = process.platform === "win32";
// Windows deletes anything too big for the Recycle Bin for good, without
// asking when no one is there to see the prompt, so big items are refused.
// ponytail: fixed cap, the bin's real size per drive is MaxCapacity under
// HKCU\...\Explorer\BitBucket\Volume if this ever turns something away wrongly.
const WIN_CAP = 2 * 1024 ** 3;
const run = promisify(execFile);

function size(p: string, cap: number): number {
	const s = lstatSync(p);
	if (!s.isDirectory()) return s.size;
	let total = 0;
	for (const name of readdirSync(p)) {
		total += size(join(p, name), cap - total);
		if (total > cap) break;
	}
	return total;
}

// A move that hangs, on a slow drive or behind a file held open, gives up
// rather than holding the server.
const TRASH_MS = 60_000;

async function recycle(paths: string[]) {
	const full = paths.map((p) => resolve(p));
	for (const p of full) {
		if (size(p, WIN_CAP) > WIN_CAP)
			throw new Error(
				`${basename(p)} is over 2 GB, too big for the Recycle Bin, so it would be deleted for good. Ask him to delete it himself if he wants it gone.`,
			);
	}
	// The shell's own move, with every dialog turned off: ALLOWUNDO, SILENT,
	// NOCONFIRMATION, NOCONFIRMMKDIR and NOERRORUI. Visual Basic's version
	// still shows error dialogs, like File In Use, to a desktop nobody watches.
	// Fail writes its own line, as a thrown error is wrapped at the console width.
	const script = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LabBin {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct Op { public IntPtr hwnd; public uint func; public string from; public string to; public ushort flags; public bool aborted; public IntPtr map; public string title; }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHFileOperationW(ref Op op);
  public static int Recycle(string p) { var o = new Op { func = 3, from = p + "\\0\\0", flags = 0x654 }; int r = SHFileOperationW(ref o); return r != 0 ? r : o.aborted ? -1 : 0; }
}
'@
$ErrorActionPreference = 'Stop'
function Fail($why) { [Console]::Error.WriteLine($why); exit 1 }
foreach ($p in $env:LAB_TRASH_PATHS -split "\`n") {
  if ([System.IO.DriveInfo]::new($p).DriveType -ne 'Fixed') { Fail "$p is on a network or removable drive, which has no Recycle Bin, so it was left alone." }
  $r = [LabBin]::Recycle($p)
  if ($r -ne 0) { Fail ("Windows couldn't move $p to the Recycle Bin (error 0x{0:X}). Something may have it open, so close that and try again." -f $r) }
}`;
	try {
		await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			env: { ...env, LAB_TRASH_PATHS: full.join("\n") },
			timeout: TRASH_MS,
			windowsHide: true,
		});
	} catch (e) {
		const err = typeof e === "object" && e !== null ? e : {};
		if ("killed" in err && err.killed)
			throw new Error(
				`Moving to the Recycle Bin took over ${TRASH_MS / 1000} seconds, so it was stopped. Check what's still there before trying again.`,
				{ cause: e },
			);
		const why =
			("stderr" in err ? err.stderr : undefined) ??
			("message" in err ? err.message : undefined);
		throw new Error(
			String(why)
				.split("\n")
				.find((l) => l.trim())
				?.replace(/^.*?: /, "") ?? "The Recycle Bin move failed.",
			{ cause: e },
		);
	}
}

// Each deleted item is a $R file in the drive's bin, next to a $I file that
// holds where it came from: a version, its size, when, then the path.
function binEntries(drive: string) {
	const sid = /S-1-[\d-]+/.exec(
		execFileSync(
			join(setting("SystemRoot") ?? "C:\\Windows", "System32", "whoami.exe"),
			["/user", "/fo", "csv", "/nh"],
			{ encoding: "utf8", windowsHide: true },
		),
	)?.[0];
	const dir = join(drive, "$Recycle.Bin", sid ?? "");
	if (!(sid && existsSync(dir))) return [];
	return readdirSync(dir)
		.filter((n) => n.startsWith("$I"))
		.map((n) => {
			const b = readFileSync(join(dir, n));
			const v2 = b.readBigInt64LE(0) === 2n;
			const from = (
				v2 ? b.subarray(28, 28 + (b.readUInt32LE(24) - 1) * 2) : b.subarray(24, 544)
			)
				.toString("utf16le")
				.replace(/\0.*$/s, "");
			return {
				info: join(dir, n),
				item: join(dir, `$R${n.slice(2)}`),
				from,
				at: b.readBigUInt64LE(16),
			};
		});
}

export function restore(paths: string[]): string[] {
	if (!WIN) throw new Error("On a Mac, move things back from ~/.Trash with mv.");
	return paths.map((p) => {
		const want = resolve(p);
		const hit = binEntries(parse(want).root)
			.filter((e) => e.from.toLowerCase() === want.toLowerCase() && existsSync(e.item))
			.toSorted((a, b) => Number(b.at - a.at))[0];
		if (!hit) throw new Error(`Nothing from ${want} is in the Recycle Bin.`);
		if (existsSync(want))
			throw new Error(
				`${want} is already there, so the copy in the Recycle Bin was left alone.`,
			);
		mkdirSync(dirname(want), { recursive: true });
		renameSync(hit.item, want);
		rmSync(hit.info, { force: true });
		return want;
	});
}

export async function trash(paths: string[], bin?: string): Promise<string[]> {
	const missing = paths.filter((p) => {
		try {
			lstatSync(p);
			return false;
		} catch {
			return true;
		}
	});
	if (missing.length > 0)
		throw new Error(`Nothing at ${missing.join(", ")}, so nothing was moved.`);
	if (!bin && WIN) {
		await recycle(paths);
		return paths;
	}
	if (!bin && process.platform === "darwin" && existsSync(SYSTEM)) {
		await run(SYSTEM, paths, { timeout: TRASH_MS });
		return paths.map((p) => join(homedir(), ".Trash", basename(p)));
	}
	const to = bin ?? join(homedir(), ".Trash");
	mkdirSync(to, { recursive: true });
	return paths.map((p) => {
		const ext = extname(p);
		const stem = basename(p, ext);
		let dest = join(to, basename(p));
		for (let n = 2; existsSync(dest); n++) dest = join(to, `${stem} ${n}${ext}`);
		renameSync(resolve(p), dest);
		return dest;
	});
}

const fwd = (p: string) => p.replace(/\\/g, "/");

// The commands on the agent's PATH: trash, check-app, which holds app/ to
// the same code rules the server does, and report, for The Lab's own bugs. Git Bash runs the sh ones, and
// PowerShell and cmd run the .cmd ones.
export function launchers(dir: string) {
	mkdirSync(dir, { recursive: true });
	for (const [name, script] of [
		["trash", fileURLToPath(import.meta.url)],
		["check-app", fileURLToPath(new URL("./design.ts", import.meta.url))],
		["report", fileURLToPath(new URL("./report.ts", import.meta.url))],
		["recall", fileURLToPath(new URL("./recall.ts", import.meta.url))],
		["box", fileURLToPath(new URL("./box.ts", import.meta.url))],
		["computer", fileURLToPath(new URL("./computer.ts", import.meta.url))],
	] as const) {
		writeFileSync(
			join(dir, name),
			`#!/bin/sh\nexec "${fwd(process.execPath)}" "${fwd(script)}" "$@"\n`,
		);
		// cmd reads this file in the console's code page, so it switches to UTF-8
		// for a path like C:\Users\José and then puts the agent's console back.
		if (WIN)
			writeFileSync(
				join(dir, `${name}.cmd`),
				[
					"@echo off",
					'for /f "tokens=2 delims=:." %%c in (\'chcp\') do set "LAB_CP=%%c"',
					"chcp 65001 >nul",
					`"${process.execPath}" "${script}" %*`,
					'set "LAB_RC=%errorlevel%"',
					"if defined LAB_CP chcp %LAB_CP% >nul",
					"exit /b %LAB_RC%",
					"",
				].join("\r\n"),
			);
		else chmodSync(join(dir, name), 0o755);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const back = process.argv.includes("--restore");
	const paths = process.argv.slice(2).filter((a) => a !== "--" && a !== "--restore");
	if (paths.length === 0) {
		console.error("Usage: trash PATH...  or  trash --restore PATH...");
		process.exit(2);
	}
	try {
		const done = back ? restore(paths) : await trash(paths, setting("LAB_TRASH_DIR"));
		const what = done.length === 1 ? basename(paths[0] ?? "") : `${done.length} items`;
		process.stdout.write(
			back
				? `Put ${what} back.\n`
				: `Moved ${what} to the ${WIN ? "Recycle Bin" : "Trash"}.\n`,
		);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
