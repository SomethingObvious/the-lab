import { randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { env, platform } from "node:process";

// Every environment variable the code reads comes through here. It is read
// at each call, so a value set after start still counts.
export function setting(name: string): string | undefined {
	return env[name];
}

// The agent's folder. Everything in it is the agent's to change.
export const home = () => setting("LAB_HOME") ?? join(homedir(), "TheLab");
// The server's code, token, history and tools. It sits outside the agent's
// folder, so nothing the agent is let write can lower its own guard rails.
export const labDir = () => setting("LAB_DIR") ?? join(homedir(), ".thelab");

// `name` is what he renamed the computer to on his phone.
// `relay` is the tunnel relay's address, set by `node setup.ts relay`.
export interface Config {
	token: string;
	port: number;
	engine?: "claude" | "codex";
	name?: string;
	relay?: string;
	// Apps and window titles the agent's computer tool never works, as he listed them.
	neverApps?: string[];
}

// Written to a temp file, flushed to the disk and renamed into place, so a
// power cut leaves the old file or the new one and never half of it. On
// Windows an antivirus, the search indexer or a backup holding the file open
// turns the rename into EPERM for a moment, so it tries a few times. A save
// that still fails is logged rather than thrown, as the next save writes the
// whole file again.
export function saveFile(file: string, text: string, mode?: number): boolean {
	for (let i = 1; ; i++) {
		try {
			writeFileSync(`${file}.tmp`, text, {
				flush: true,
				...(mode === undefined ? {} : { mode }),
			});
			renameSync(`${file}.tmp`, file);
			syncFolder(dirname(file));
			return true;
		} catch (e) {
			const code = e instanceof Error && "code" in e ? e.code : "";
			if (i < 6 && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * i);
				continue;
			}
			console.error(
				`couldn't save ${file}: ${e instanceof Error ? e.message : String(e)}`,
			);
			return false;
		}
	}
}

// The rename only lasts a power cut once the folder is flushed too. Windows
// can't open a folder for that and NTFS logs the rename itself.
function syncFolder(dir: string) {
	if (WIN) return;
	try {
		const fd = openSync(dir, "r");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	} catch {
		// Some file systems can't flush a folder, and the file itself is saved.
	}
}

// Created once on first start. The token is what the phone was paired with,
// so it is never regenerated on its own.
export function config(): Config {
	const dir = labDir();
	const file = join(dir, "config.json");
	if (!existsSync(file)) {
		mkdirSync(dir, { recursive: true });
		saveFile(
			file,
			JSON.stringify(
				{ token: randomBytes(32).toString("base64url"), port: 8417 },
				null,
				2,
			),
			0o600,
		);
	}
	const text = readFileSync(file, "utf8");
	const read = readable(text);
	if (read) {
		if (text !== lastGood) {
			lastGood = text;
			saveFile(`${file}.good`, text, 0o600);
		}
		return read;
	}
	// A crash or a bad edit shouldn't stop the server for good. The copy from
	// the last time it read fine keeps the token, so the phone stays paired.
	saveFile(`${file}.bad`, text, 0o600);
	const good = existsSync(`${file}.good`) ? readFileSync(`${file}.good`, "utf8") : "";
	const back = readable(good);
	console.error(
		back
			? `${file} was damaged, so the copy from when it last read fine is back. The damaged one is ${file}.bad.`
			: `${file} was damaged and there's no good copy, so it starts over and the phone has to pair again. The damaged one is ${file}.bad.`,
	);
	if (back) saveFile(file, good, 0o600);
	else rmSync(file, { force: true });
	return back ?? config();
}

let lastGood = "";
function readable(text: string): Config | null {
	try {
		const c = JSON.parse(text);
		return typeof c?.token === "string" && c.token && Number.isInteger(c.port)
			? c
			: null;
	} catch {
		return null;
	}
}

// An undefined field drops that key from config.json, which is how a rename
// goes back to the computer's own name.
export function setConfig(patch: { [K in keyof Config]?: Config[K] | undefined }) {
	saveFile(
		join(labDir(), "config.json"),
		JSON.stringify({ ...config(), ...patch }, null, 2),
		0o600,
	);
}

// The Mac's privacy lists show this name, and the window is called The Lab, so
// a new setup keeps the two apart. One set up before that keeps its old name,
// since macOS ties his permissions to the app.
export const agentAppName = () =>
	existsSync(join(labDir(), "The Lab.app")) ? "The Lab" : "The Lab Agent";

export const WIN = platform === "win32";
// The server's sentences say "the computer" whatever it runs, and name the
// Trash, which Windows calls the Recycle Bin. Only the whole phrase is
// swapped, as the agent's text goes through here too and a folder called
// Trash has to keep its name.
const END = String.raw`(?![\w/\\-]|\.\w)`;
const TRASH = new RegExp(String.raw`\bthe Trash${END}`, "g");
const MACOS = new RegExp(String.raw`(?<![\w/\\.-])macOS${END}`, "g");
export const words = (s: string, win = WIN) =>
	!win ? s : s.replace(MACOS, "Windows").replace(TRASH, "the Recycle Bin");
