// The app folder his agent edits. Every settled change is snapshotted so
// Undo on the phone can step back through them, and the phone pulls the
// whole folder as one bundle whenever the version changes.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	watch,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { labDir } from "./config.ts";

const KEEP = 30;

// The same rules this repo's own code passes. They sit outside his Lab
// folder, so the agent can't loosen them.
const RULES = fileURLToPath(new URL("./app-lint.json", import.meta.url));
const BIOME = (() => {
	try {
		return createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome");
	} catch {
		return null;
	}
})();
const LINTED = /\.(m?js|css|html|json)$/;

// Every finding in these files, as "app/app.js line 3: what's wrong". `fix`
// applies the safe fixes and the formatting first.
export function lint(dir: string, files: string[], fix = false): string[] {
	const found: string[] = [];
	const name = (f: string) => `app/${relative(dir, f).split(sep).join("/")}`;
	for (const f of files) {
		// A silenced rule or a note to finish later is the slop the rules are for.
		readFileSync(f, "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (/biome-ignore|eslint-disable/.test(line))
					found.push(
						`${name(f)} line ${i + 1}: a comment that switches a rule off. Fix the code instead.`,
					);
				else if (/\b(TODO|FIXME|XXX)\b/.test(line))
					found.push(
						`${name(f)} line ${i + 1}: an unfinished note. Finish it or take it out.`,
					);
			});
	}
	if (!BIOME || files.length === 0) return found;
	const r = spawnSync(
		process.execPath,
		[
			BIOME,
			"check",
			`--config-path=${RULES}`,
			"--reporter=github",
			"--colors=off",
			"--max-diagnostics=none",
			...(fix ? ["--write"] : []),
			...files,
		],
		{ cwd: dir, encoding: "utf8", timeout: 30_000, windowsHide: true },
	);
	for (const [, rule = "", file = "", line, text = ""] of (r.stdout ?? "").matchAll(
		/^::\w+ title=([^,]+),file=([^,]+),line=(\d+)[^:]*::(.*)$/gm,
	))
		found.push(
			`${name(decodeURIComponent(file))} line ${line}: ${rule === "format" ? "isn't laid out the way the rest is (check-app --fix lays it out)" : `${text} (${rule})`}`,
		);
	return found;
}

const count = (found: string[], file: string) =>
	found.filter((f) => f.startsWith(`${file} `)).length;

// Findings a change adds over `base`, the version the phone has. Comparing
// keeps an app from before these rules working, while it can't get worse.
function newFindings(dir: string, files: string[], base?: string): string[] {
	const now = lint(dir, files);
	if (!base || now.length === 0) return now;
	const there = files
		.map((f) => join(base, relative(dir, f)))
		.filter((f) => existsSync(f));
	const before = lint(base, there);
	const worse = new Set(
		files
			.map((f) => `app/${relative(dir, f).split(sep).join("/")}`)
			.filter((n) => count(now, n) > count(before, n)),
	);
	return now.filter((f) => worse.has(f.split(" ")[0] ?? ""));
}

// The newest snapshot in a Design's history, which is what the phone has.
export function published(history: string): string | undefined {
	if (!existsSync(history)) return undefined;
	const newest = readdirSync(history)
		.filter((n) => /^\d+$/.test(n))
		.toSorted((a, b) => Number(a) - Number(b))
		.at(-1);
	return newest === undefined ? undefined : join(history, newest);
}

// What would leave the phone with a blank screen (no index.html, a script
// that doesn't parse, or JSON that doesn't), then anything that adds lint
// findings over `base`. `only` checks one file.
export function checkApp(dir: string, only?: string, base?: string): string | null {
	if (!existsSync(join(dir, "index.html")))
		return "app/index.html is missing, and the phone needs it to open the app.";
	for (const f of only ? [only] : walk(dir)) {
		const name = `app/${relative(dir, f).split(sep).join("/")}`;
		if (!existsSync(f)) continue;
		if (/\.m?js$/.test(f)) {
			const r = spawnSync(process.execPath, ["--check", f], {
				encoding: "utf8",
				timeout: 15_000,
				windowsHide: true,
			});
			if (r.status !== 0)
				return `${name} has a mistake that stops it running: ${(r.stderr || "").replace(f, name).trim().split("\n").filter(Boolean).slice(0, 6).join(" | ").slice(0, 600)}`;
		} else if (f.endsWith(".json")) {
			try {
				JSON.parse(readFileSync(f, "utf8"));
			} catch (e) {
				return `${name} isn't valid JSON: ${(e as Error).message}`;
			}
		}
	}
	const files = (only ? [only] : walk(dir)).filter(
		(f) => LINTED.test(f) && existsSync(f),
	);
	const found = newFindings(dir, files, base);
	if (found.length === 0) return null;
	return `${found.length === 1 ? "it breaks one of the code rules" : `it breaks the code rules ${found.length} times`}: ${found.slice(0, 6).join(" | ")}${found.length > 6 ? " | and more" : ""}. Run check-app to see them all.`;
}
const MAX_BYTES = 25 * 1024 * 1024;

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		if (name.startsWith(".")) continue;
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p, out);
		else out.push(p);
	}
	return out;
}

export class Design {
	version = "";
	private timer: NodeJS.Timeout | null = null;
	private readonly dir: string;
	private readonly history: string;
	private readonly onChange: (version: string) => void;
	private readonly onBroken: (problem: string) => void;
	// Why the newest change was held back, until a later one fixes it.
	broken: string | null = null;

	constructor(
		dir: string,
		history: string,
		onChange: (version: string) => void,
		onBroken: (problem: string) => void = () => {
			// A caller that doesn't show held-back changes has nothing to do here.
		},
	) {
		this.dir = dir;
		this.history = history;
		this.onChange = onChange;
		this.onBroken = onBroken;
		mkdirSync(this.history, { recursive: true });
		// The agent can move app/ to the Trash without asking, and a server that
		// can't watch it would never start again.
		mkdirSync(this.dir, { recursive: true });
		// A change held back before a restart stays held back. Otherwise whatever
		// changed while the server was off is the newest version.
		const problem = checkApp(this.dir, undefined, published(this.history));
		if (problem && this.snapshots().length > 0) {
			this.version = this.hash(this.latest());
			this.broken = problem;
		} else {
			this.version = this.hash();
			if (this.snapshots().length === 0 || this.hash(this.latest()) !== this.version)
				this.snapshot();
		}
		this.watch();
	}

	private watch() {
		const ino = statSync(this.dir).ino;
		const w = watch(this.dir, { recursive: true, persistent: false }, () => {
			// On Windows a watch on a deleted folder reports it again and again as
			// fast as it can, so it moves to app/ as it is now, made afresh if need be.
			if (statSync(this.dir, { throwIfNoEntry: false })?.ino !== ino) {
				w.close();
				mkdirSync(this.dir, { recursive: true });
				this.watch();
			}
			if (this.timer) clearTimeout(this.timer);
			// Editors write in bursts (temp file, rename, chmod), so wait for quiet.
			this.timer = setTimeout(() => this.settle(), 600);
		}).on("error", (e) => console.error("app watch:", e));
	}

	private hash(dir = this.dir): string {
		const h = createHash("sha256");
		// Code unit order rather than the locale's, so an unchanged folder always
		// hashes the same.
		for (const f of walk(dir).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
			h.update(relative(dir, f).split(sep).join("/"));
			h.update(readFileSync(f));
		}
		return h.digest("hex").slice(0, 16);
	}

	private latest() {
		const newest = this.snapshots().at(-1);
		if (newest === undefined)
			throw new Error(`${this.history} has no snapshots in it.`);
		return join(this.history, newest);
	}

	private snapshots(): string[] {
		return readdirSync(this.history)
			.filter((n) => /^\d+$/.test(n))
			.toSorted((a, b) => Number(a) - Number(b));
	}

	private snapshot() {
		cpSync(this.dir, join(this.history, String(Date.now())), {
			recursive: true,
			filter: (src) =>
				!(src.split(sep).pop() ?? "").startsWith(".") || src === this.dir,
		});
		const all = this.snapshots();
		for (const old of all.slice(0, Math.max(0, all.length - KEEP)))
			rmSync(join(this.history, old), { recursive: true, force: true });
	}

	// A file that vanishes or is locked partway through throws, and the next
	// change tries again rather than the throw taking the server down.
	private settle() {
		try {
			this.publish();
		} catch (e) {
			console.error("app change:", e);
		}
	}

	private publish() {
		const v = this.hash();
		if (v === this.version) {
			this.broken = null;
			return;
		}
		const problem = checkApp(this.dir, undefined, this.latest());
		if (problem) {
			if (problem !== this.broken) {
				this.broken = problem;
				this.onBroken(problem);
			}
			return;
		}
		this.broken = null;
		this.version = v;
		this.snapshot();
		this.onChange(v);
	}

	// From the newest snapshot, which is always the published version, so a
	// change that's held back never reaches the phone under its name.
	bundle(): { version: string; files: Record<string, string> } {
		const files: Record<string, string> = {};
		const dir = this.latest();
		let total = 0;
		for (const f of walk(dir)) {
			const data = readFileSync(f);
			total += data.length;
			if (total > MAX_BYTES)
				throw new Error(
					`The app folder is over ${MAX_BYTES / 1_048_576} MB, which is too big to send to the phone.`,
				);
			files[relative(dir, f).split(sep).join("/")] = data.toString("base64");
		}
		return { version: this.version, files };
	}

	// Drops the newest snapshot and puts the one before it back.
	undo(): boolean {
		const [before, newest] = this.snapshots().slice(-2);
		if (before === undefined || newest === undefined) return false;
		rmSync(join(this.history, newest), { recursive: true, force: true });
		const prev = join(this.history, before);
		for (const name of readdirSync(this.dir)) {
			if (!name.startsWith("."))
				rmSync(join(this.dir, name), { recursive: true, force: true });
		}
		cpSync(prev, this.dir, { recursive: true });
		this.broken = null;
		this.version = this.hash();
		this.onChange(this.version);
		return true;
	}

	static exists(dir: string) {
		return existsSync(join(dir, "index.html"));
	}
}

// check-app, for the agent: every finding in app/, whatever the phone has.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const fix = process.argv.includes("--fix");
	const dir = resolve(process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "app");
	if (!existsSync(dir)) {
		console.error(`There's no app folder at ${dir}.`);
		process.exit(2);
	}
	const files = () => walk(dir).filter((f) => LINTED.test(f));
	// Findings already in the version the phone has aren't this change's, and
	// the server only turns down new ones, so only new ones are listed.
	const base = published(join(labDir(), "design-history"));
	if (fix) lint(dir, files(), true);
	const broken = checkApp(dir, undefined, base);
	if (!broken) process.exit(0);
	const found = newFindings(dir, files(), base);
	for (const f of found.length > 0 ? found : [broken]) console.error(f);
	process.exit(1);
}
