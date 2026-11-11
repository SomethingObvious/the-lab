// Updates The Lab from its GitHub releases with no agent involved. A release
// is merged three ways into what's installed, so fixes made on this computer
// and his own restyled app survive it. The merged copy has to pass the test
// suite before it goes in, and the supervisor in server.ts puts the old one
// back if the new server won't stay up.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statfsSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { constants, setPriority, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import process, { env } from "node:process";
import { saveFile, setting, words } from "./config.ts";
import { lint } from "./design.ts";

export const REPO = "SomethingObvious/the-lab";
const WIN = process.platform === "win32";
// Windows' own tar reads C: paths and opens zips. The GNU tar that Git Bash
// puts first on PATH reads C: in a path as a remote host instead.
export const TAR = WIN
	? join(setting("SystemRoot") ?? "C:\\Windows", "System32", "tar.exe")
	: process.platform === "darwin"
		? "/usr/bin/tar"
		: "tar";

// cmd.exe runs a batch file. Node's shell option leaves a path with a space
// unquoted, and its own quoting uses backslashes that cmd doesn't read, so the
// whole line is quoted here and handed to cmd as it is.
export function batch(cmd: string, a: string[]) {
	if (!(WIN && /\.(bat|cmd)$/i.test(cmd)))
		return { file: cmd, args: a, windowsVerbatimArguments: false };
	const line = [cmd, ...a].map((x) => `"${x}"`).join(" ");
	return {
		file: setting("ComSpec") ?? "cmd.exe",
		args: ["/d", "/s", "/c", `"${line}"`],
		windowsVerbatimArguments: true,
	};
}

// Windows turns a rename or delete into EPERM or EBUSY for a moment while an
// antivirus or the search indexer has the file open.
function retry<T>(f: () => T): T {
	for (let i = 1; ; i++)
		try {
			return f();
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (i >= 6 || !(code === "EPERM" || code === "EBUSY" || code === "EACCES"))
				throw e;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * i);
		}
}

// State files are read back after a crash, so a write that fails has to stop
// whatever depended on it.
function save(file: string, data: unknown) {
	if (!saveFile(file, JSON.stringify(data))) throw new Error(`Couldn't save ${file}.`);
}
// Build output and installed packages, never part of a release.
const SKIP = new Set([
	"node_modules",
	".git",
	"build",
	".gradle",
	".kotlin",
	".cxx",
	".idea",
	"local.properties",
	".wrangler",
]);

// ---------- merging ----------

interface Hunk {
	// base[a0, a1) became other[b0, b1).
	a0: number;
	a1: number;
	b0: number;
	b1: number;
}

// Where `b` differs from `a`, line by line.
export function hunks(a: string[], b: string[]): Hunk[] {
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	if (endA === start && endB === start) return [];
	return walk(a.slice(start, endA), b.slice(start, endB), start);
}

// Whether the furthest path on diagonal k after d edits came down from k + 1
// (a line put in) rather than across from k - 1 (a line taken out).
const fromAbove = (v: Int32Array, off: number, k: number, d: number) =>
	k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0));

// Myers' diff, the fewest lines taken out and put in. Its memory grows with
// how much changed rather than with the square of the file's length, so a
// long app.js with a few edits through it still merges line by line. Returns
// the furthest reach on each diagonal before every round, or null if that
// would take more than 16M cells.
function reach(x: string[], y: string[]): Int32Array[] | null {
	const n = x.length;
	const m = y.length;
	const off = n + m + 1;
	const v = new Int32Array(2 * off + 1);
	const rounds: Int32Array[] = [];
	for (let d = 0; ; d++) {
		// ponytail: one changed block past 16M cells, a linear space Myers if that ever bites.
		if ((d + 1) * v.length > 16_000_000) return null;
		rounds.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let i = fromAbove(v, off, k, d)
				? (v[off + k + 1] ?? 0)
				: (v[off + k - 1] ?? 0) + 1;
			let j = i - k;
			while (i < n && j < m && x[i] === y[j]) {
				i++;
				j++;
			}
			v[off + k] = i;
			if (i >= n && j >= m) return rounds;
		}
	}
}

// The hunks between x and y, which start `at` lines into their files.
function walk(x: string[], y: string[], at: number): Hunk[] {
	const rounds = reach(x, y);
	if (!rounds) return [{ a0: at, a1: at + x.length, b0: at, b1: at + y.length }];
	const off = x.length + y.length + 1;
	const out: Hunk[] = [];
	let i = x.length;
	let j = y.length;
	// Walked back from the end, so each edit lands just before the ones found so far.
	for (let d = rounds.length - 1; d > 0; d--) {
		const before = rounds[d] as Int32Array;
		const k = i - j;
		const down = fromAbove(before, off, k, d);
		const pk = down ? k + 1 : k - 1;
		const pi = before[off + pk] ?? 0;
		const pj = pi - pk;
		const h = {
			a0: at + pi,
			a1: at + pi + (down ? 0 : 1),
			b0: at + pj,
			b1: at + pj + (down ? 1 : 0),
		};
		const next = out[0];
		if (next && next.a0 === h.a1 && next.b0 === h.b1) {
			next.a0 = h.a0;
			next.b0 = h.b0;
		} else out.unshift(h);
		i = pi;
		j = pj;
	}
	return out;
}

// The lines of `side` for base[lo, hi), given its hunks inside that range.
function span(base: string[], side: string[], hs: Hunk[], lo: number, hi: number) {
	const out: string[] = [];
	let at = lo;
	for (const h of hs) {
		out.push(...base.slice(at, h.a0), ...side.slice(h.b0, h.b1));
		at = h.a1;
	}
	out.push(...base.slice(at, hi));
	return out;
}

// A three-way merge of two edits of `base`. Where both changed the same
// lines differently, `prefer` wins and it counts as a conflict.
export function merge3(
	base: string,
	ours: string,
	theirs: string,
	prefer: "ours" | "theirs",
): { text: string; conflicts: number } {
	const b = base.split("\n");
	const o = ours.split("\n");
	const t = theirs.split("\n");
	const ho = hunks(b, o);
	const ht = hunks(b, t);
	const out: string[] = [];
	let conflicts = 0;
	let at = 0;
	let i = 0;
	let j = 0;
	while (i < ho.length || j < ht.length) {
		const lo = Math.min(
			ho[i]?.a0 ?? Number.POSITIVE_INFINITY,
			ht[j]?.a0 ?? Number.POSITIVE_INFINITY,
		);
		out.push(...b.slice(at, lo));
		let hi = lo;
		const mine: Hunk[] = [];
		const yours: Hunk[] = [];
		// Edits that touch or overlap go together, which is how git groups them too.
		for (let grew = true; grew; ) {
			grew = false;
			const x = ho[i];
			if (x && x.a0 <= hi) {
				mine.push(x);
				hi = Math.max(hi, x.a1);
				i++;
				grew = true;
			}
			const y = ht[j];
			if (y && y.a0 <= hi) {
				yours.push(y);
				hi = Math.max(hi, y.a1);
				j++;
				grew = true;
			}
		}
		const a = span(b, o, mine, lo, hi);
		const c = span(b, t, yours, lo, hi);
		if (mine.length === 0) out.push(...c);
		else if (yours.length === 0 || a.join("\n") === c.join("\n")) out.push(...a);
		else {
			conflicts++;
			out.push(...(prefer === "ours" ? a : c));
		}
		at = hi;
	}
	out.push(...b.slice(at));
	return { text: out.join("\n"), conflicts };
}

const read = (p: string) => (existsSync(p) ? readFileSync(p) : undefined);
const readJson = <T>(p: string): T | null => {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
};
const same = (x?: Buffer, y?: Buffer) =>
	x === undefined ? y === undefined : y !== undefined && x.equals(y);
const isText = (x: Buffer) => !x.subarray(0, 8000).includes(0);

// Relative paths of every file under dir, with / between parts.
export function files(dir: string, at = ""): string[] {
	if (!existsSync(join(dir, at))) return [];
	const out: string[] = [];
	for (const name of readdirSync(join(dir, at))) {
		if (SKIP.has(name)) continue;
		const rel = at ? `${at}/${name}` : name;
		if (statSync(join(dir, rel)).isDirectory()) out.push(...files(dir, rel));
		else out.push(rel);
	}
	return out;
}

export interface Merged {
	// What changes in ours: path to new contents, or null to delete it.
	writes: Map<string, Buffer | null>;
	conflicts: string[];
}

// Merges theirs into ours over base, file by file. `paths` limits it to some files.
// What setup's gate and the desktop build compare against.
export function treeHash(dir: string): string {
	const h = createHash("sha256");
	for (const rel of files(dir)) {
		h.update(rel);
		h.update(readFileSync(join(dir, rel)));
	}
	return h.digest("hex");
}

// The window is built from desktop/ with the Allow card from shared/ inside it.
export const windowHash = (source: string): string =>
	treeHash(join(source, "desktop")) + treeHash(join(source, "shared"));

// An update that changed either needs the window built again, once setup
// has built it the first time.
export function desktopStale(source: string, lab: string): boolean {
	const built = join(lab, "desktop", "built");
	return existsSync(built) && readFileSync(built, "utf8") !== windowHash(source);
}

export function mergeTree(
	base: string,
	ours: string,
	theirs: string,
	prefer: "ours" | "theirs",
	paths = [...new Set([...files(base), ...files(ours), ...files(theirs)])],
): Merged {
	const writes = new Map<string, Buffer | null>();
	const conflicts: string[] = [];
	for (const rel of paths) {
		const b = read(join(base, rel));
		const o = read(join(ours, rel));
		const t = read(join(theirs, rel));
		if (same(o, t) || same(t, b)) continue;
		if (same(o, b)) {
			writes.set(rel, t ?? null);
			continue;
		}
		// Changed on both sides, or changed on one and deleted on the other.
		if (o && t && isText(o) && isText(t)) {
			const m = merge3(
				b?.toString("utf8") ?? "",
				o.toString("utf8"),
				t.toString("utf8"),
				prefer,
			);
			if (m.conflicts > 0) conflicts.push(rel);
			if (m.text !== o.toString("utf8")) writes.set(rel, Buffer.from(m.text));
		} else {
			conflicts.push(rel);
			if (prefer === "theirs") writes.set(rel, t ?? null);
		}
	}
	return { writes, conflicts };
}

function write(root: string, writes: Map<string, Buffer | null>) {
	for (const [rel, data] of writes) {
		const p = join(root, rel);
		if (data === null) rmSync(p, { force: true });
		else {
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, data);
		}
	}
}

// ---------- his Lab folder ----------

// The template is written for both systems. Each copy in his Lab folder keeps
// only the blocks for its own system, and on Windows it names the Recycle Bin.
export function fitted(file: string, data: Buffer): Buffer {
	if (!/\.(md|js|html|json|css)$/.test(file)) return data;
	const other = WIN ? "mac" : "windows";
	return Buffer.from(
		words(
			data
				.toString("utf8")
				.replace(new RegExp(`<!-- ${other} -->[\\s\\S]*?<!-- end -->\\n?`, "g"), "")
				.replace(/<!-- (mac|windows|end) -->\n?/g, "")
				.replace(/\n{3,}/g, "\n\n"),
		),
	);
}

// What a template file is called in his Lab folder. His own notes and lists
// are his from the first copy, so they have no entry and an update never
// touches them.
export function inHome(rel: string): string[] {
	const [top, ...rest] = rel.split("/");
	if (top === "skill")
		return [".claude", ".agents"].map((d) => [d, "skills", ...rest].join("/"));
	if (top === "app" || top === "CLAUDE.md" || top === "DESIGN.md") return [rel];
	return [];
}

// Codex reads AGENTS.md where Claude reads CLAUDE.md, so it's a link to it.
// Where a link can't be made it's a copy, and whichever of the two changed
// last is copied over the other.
export function linkAgents(home: string) {
	const guide = join(home, "CLAUDE.md");
	const agents = join(home, "AGENTS.md");
	if (!existsSync(guide)) return;
	const was = lstatSync(agents, { throwIfNoEntry: false });
	if (!was) {
		try {
			symlinkSync("CLAUDE.md", agents);
		} catch {
			cpSync(guide, agents);
		}
		return;
	}
	if (was.isSymbolicLink() || readFileSync(agents).equals(readFileSync(guide))) return;
	if (was.mtimeMs > statSync(guide).mtimeMs) cpSync(agents, guide);
	else cpSync(guide, agents);
}

// The template as his Lab folder would have it, written to `out`.
export function fitTemplate(template: string, out: string) {
	rmSync(out, { recursive: true, force: true });
	for (const rel of files(template))
		for (const dest of inHome(rel)) {
			const p = join(out, dest);
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, fitted(rel, readFileSync(join(template, rel))));
		}
	// A longer word for another system can push a line past the layout width.
	const app = join(out, "app");
	lint(
		app,
		files(app).map((rel) => join(app, rel)),
		true,
	);
}

// Merges the template into his Lab folder over `base`, the fitted template
// his folder matches. His side wins wherever both changed the same lines,
// and app/ only changes if the merged app passes `checkApp`. Returns the
// files it couldn't bring over. A held file whose copy in .lab-update is gone
// was brought together by hand, so its base moves to that release.
export function syncHome(
	home: string,
	template: string,
	base: string,
	checkApp: (dir: string) => string | null,
): { changed: string[]; held: string[] } {
	const next = join(tmpdir(), `lab-template-${process.pid}`);
	fitTemplate(template, next);
	if (!existsSync(base)) {
		// Nothing to compare with, so what's there now counts as up to date.
		cpSync(next, base, { recursive: true });
		rmSync(next, { recursive: true, force: true });
		return { changed: [], held: [] };
	}
	const waiting = `${base}.held.json`;
	const copy = join(home, ".lab-update");
	for (const rel of readJson<string[]>(waiting) ?? [])
		if (!existsSync(join(copy, rel))) {
			rmSync(join(base, rel), { force: true });
			if (existsSync(join(next, rel))) {
				mkdirSync(dirname(join(base, rel)), { recursive: true });
				cpSync(join(next, rel), join(base, rel));
			}
		}
	linkAgents(home);
	const m = mergeTree(base, home, next, "ours", [
		...new Set([...files(base), ...files(next)]),
	]);
	const held = [...m.conflicts];
	const app = [...m.writes].filter(([rel]) => rel.startsWith("app/"));
	if (app.length > 0) {
		const trial = join(tmpdir(), `lab-app-${process.pid}`);
		rmSync(trial, { recursive: true, force: true });
		cpSync(join(home, "app"), trial, { recursive: true });
		write(trial, new Map(app.map(([rel, data]) => [rel.slice("app/".length), data])));
		const problem = checkApp(trial);
		rmSync(trial, { recursive: true, force: true });
		if (problem)
			for (const [rel] of app) {
				m.writes.delete(rel);
				held.push(rel);
			}
	}
	write(home, m.writes);
	linkAgents(home);
	// The new template becomes the base for what came over. A held file keeps
	// its old base, so the next update tries it again.
	const keep = new Set(held);
	for (const rel of files(next))
		if (!keep.has(rel)) {
			mkdirSync(dirname(join(base, rel)), { recursive: true });
			cpSync(join(next, rel), join(base, rel));
		}
	saveFile(waiting, JSON.stringify([...keep]));
	if (held.length > 0) {
		rmSync(copy, { recursive: true, force: true });
		for (const rel of held) {
			mkdirSync(dirname(join(copy, rel)), { recursive: true });
			if (existsSync(join(next, rel))) cpSync(join(next, rel), join(copy, rel));
		}
	}
	rmSync(next, { recursive: true, force: true });
	return { changed: [...m.writes.keys()], held: [...new Set(held)] };
}

// ---------- releases ----------

const newer = (a: string, b: string) => {
	const x = a.split(".").map(Number);
	const y = b.split(".").map(Number);
	for (let k = 0; k < 3; k++)
		if ((x[k] ?? 0) !== (y[k] ?? 0)) return (x[k] ?? 0) > (y[k] ?? 0);
	return false;
};

async function github(path: string): Promise<Response> {
	return await fetch(`https://api.github.com/repos/${REPO}${path}`, {
		headers: { accept: "application/vnd.github+json", "user-agent": "the-lab" },
		signal: AbortSignal.timeout(60_000),
	});
}

// The newest release tag, if it's newer than `current`.
export async function latest(current: string): Promise<string | null> {
	const r = await github("/tags?per_page=50");
	if (!r.ok) throw new Error(`GitHub answered ${r.status} when asked for releases.`);
	const tags = ((await r.json()) as { name: string }[])
		.map((t) => /^v(\d+\.\d+\.\d+)$/.exec(t.name)?.[1])
		.filter((v): v is string => v !== undefined);
	const best = tags.reduce((a, v) => (newer(v, a) ? v : a), current);
	return best === current ? null : best;
}

// Unpacks release `version` into `dir` and returns the folder it's in.
async function download(version: string, dir: string): Promise<string> {
	const r = await github(`/tarball/v${version}`);
	if (!r.ok)
		throw new Error(`GitHub answered ${r.status} for the v${version} download.`);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "release.tar.gz");
	writeFileSync(file, Buffer.from(await r.arrayBuffer()));
	const x = await run(TAR, ["-xzf", file, "-C", dir], { timeout: 5 * 60_000 });
	if (x.status !== 0) throw new Error(`Couldn't unpack the release: ${x.out.trim()}`);
	rmSync(file);
	const top = readdirSync(dir).find((n) => statSync(join(dir, n)).isDirectory());
	if (!top) throw new Error("The release download was empty.");
	return join(dir, top);
}

// ---------- installing ----------

// Runs a command without holding up the server, at the lowest priority so a
// download or a test run never slows down the agent or a game.
function run(
	cmd: string,
	args: string[],
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout: number },
): Promise<{ status: number | null; out: string }> {
	return new Promise((done) => {
		const b = batch(cmd, args);
		const p = spawn(b.file, b.args, {
			...opts,
			windowsHide: true,
			windowsVerbatimArguments: b.windowsVerbatimArguments,
		});
		if (p.pid)
			try {
				setPriority(p.pid, constants.priority.PRIORITY_LOW);
			} catch {
				// Priority is a courtesy, and the run still works without it.
			}
		let out = "";
		p.stdout?.on("data", (d) => {
			out = (out + String(d)).slice(-200_000);
		});
		p.stderr?.on("data", (d) => {
			out = (out + String(d)).slice(-200_000);
		});
		const timer = setTimeout(() => p.kill(), opts.timeout);
		p.on("error", (e) => {
			clearTimeout(timer);
			done({ status: null, out: `${out}${e.message}` });
		});
		p.on("close", (status) => {
			clearTimeout(timer);
			done({ status, out });
		});
	});
}

export interface Ready {
	version: string;
	writes: string[];
	deletes: string[];
	modules: boolean;
	conflicts: string[];
}

export const work = (lab: string) => join(lab, "update");

// Downloads `version`, merges it into the source, installs its packages and
// runs the tests on the result. Leaves update/ready.json once it all passed.
export async function prepare(
	version: string,
	source: string,
	lab: string,
	say: (detail: string) => void,
): Promise<Ready> {
	say("Downloading");
	const base = join(lab, "base");
	if (!existsSync(base)) {
		// A change made here is one against the release this was installed from.
		const old = join(work(lab), "old");
		try {
			const pkg = JSON.parse(
				readFileSync(join(source, "computer", "package.json"), "utf8"),
			) as { version: string };
			renameSync(await download(pkg.version, old), base);
		} catch {
			// Without it stage() counts every difference as a change made here.
		}
		rmSync(old, { recursive: true, force: true });
	}
	const theirs = await download(version, join(work(lab), "new"));
	return await stage(version, theirs, source, lab, say);
}

// The merge, install and test half of prepare(), for a release already
// unpacked in update/new.
export async function stage(
	version: string,
	theirs: string,
	source: string,
	lab: string,
	say: (detail: string) => void,
): Promise<Ready> {
	const dir = work(lab);
	// Without a base every file that differs from the release counts as changed
	// here, so it is kept as a .mine copy, and a file only here stays.
	const m = mergeTree(join(lab, "base"), source, theirs, "theirs");
	const trial = join(dir, "trial");
	rmSync(trial, { recursive: true, force: true });
	say("Merging");
	cpSync(source, trial, {
		recursive: true,
		filter: (src) => !SKIP.has(src.split(sep).pop() ?? ""),
	});
	write(trial, m.writes);
	const conflicts = join(dir, "conflicts");
	rmSync(conflicts, { recursive: true, force: true });
	for (const rel of m.conflicts)
		if (existsSync(join(source, rel))) {
			mkdirSync(dirname(join(conflicts, rel)), { recursive: true });
			cpSync(join(source, rel), join(conflicts, `${rel}.mine`));
		}
	const lock = "computer/package-lock.json";
	const modules = !same(read(join(source, lock)), read(join(trial, lock)));
	if (modules) {
		say("Installing packages");
		// A PATH from the sign-in items may not have npm, which sits beside node.
		const beside = join(dirname(process.execPath), WIN ? "npm.cmd" : "npm");
		const npm = await run(
			existsSync(beside) ? beside : WIN ? "npm.cmd" : "npm",
			["ci", "--no-audit", "--no-fund"],
			{ cwd: join(trial, "computer"), timeout: 15 * 60_000 },
		);
		if (npm.status !== 0)
			throw new Error(`npm ci failed: ${npm.out.trim().slice(-400)}`);
	} else
		symlinkSync(
			join(source, "computer", "node_modules"),
			join(trial, "computer", "node_modules"),
			"junction",
		);
	say("Testing");
	const sandbox = join(dir, "sandbox");
	rmSync(sandbox, { recursive: true, force: true });
	const t = await run(process.execPath, ["--test", "--test-reporter=tap", "test.ts"], {
		cwd: join(trial, "computer"),
		timeout: 10 * 60_000,
		env: {
			...env,
			LAB_CHILD: "",
			LAB_HOME: join(sandbox, "home"),
			LAB_DIR: join(sandbox, "dir"),
		},
	});
	rmSync(sandbox, { recursive: true, force: true });
	if (t.status !== 0) {
		const failed = [...t.out.matchAll(/^not ok \d+ - (.+)$/gm)].map((x) => x[1]);
		throw new Error(
			`The merged v${version} failed its tests${failed.length > 0 ? `: ${[...new Set(failed)].slice(0, 3).join(", ")}` : ""}.`,
		);
	}
	const ready: Ready = {
		version,
		writes: [...m.writes].filter(([, d]) => d !== null).map(([rel]) => rel),
		deletes: [...m.writes].filter(([, d]) => d === null).map(([rel]) => rel),
		modules,
		conflicts: m.conflicts,
	};
	save(join(dir, "ready.json"), ready);
	return ready;
}

const size = (p: string) => (existsSync(p) ? statSync(p).size : 0);

// Run by the supervisor with the server stopped. Every file it replaces is
// kept in update/previous before anything changes, so rollback() can put it back.
export function apply(source: string, lab: string): string | null {
	const dir = work(lab);
	const ready = readJson<Ready>(join(dir, "ready.json"));
	if (!ready) return null;
	const release = readdirSync(join(dir, "new"))[0];
	if (!release) throw new Error("The downloaded release is gone.");
	const prev = join(dir, "previous");
	const base = join(lab, "base");
	const touched = [...ready.writes, ...ready.deletes];
	const need =
		touched.reduce((n, rel) => n + size(join(source, rel)), 0) +
		ready.writes.reduce((n, rel) => n + size(join(dir, "trial", rel)), 0);
	const disk = statfsSync(dir);
	if (disk.bavail * disk.bsize < need + 50_000_000)
		throw new Error("There isn't enough free space for the update.");
	try {
		retry(() => rmSync(prev, { recursive: true, force: true }));
		mkdirSync(prev, { recursive: true });
		for (const rel of touched)
			if (existsSync(join(source, rel))) {
				mkdirSync(dirname(join(prev, rel)), { recursive: true });
				cpSync(join(source, rel), join(prev, rel));
			}
		if (!existsSync(base)) writeFileSync(join(prev, "no-base"), "");
	} catch (e) {
		rmSync(prev, { recursive: true, force: true });
		throw e;
	}
	// From here on a file in touched with no copy in previous is one the update added.
	save(join(dir, "touched.json"), touched);
	try {
		for (const rel of ready.writes) {
			mkdirSync(dirname(join(source, rel)), { recursive: true });
			retry(() => cpSync(join(dir, "trial", rel), join(source, rel)));
		}
		for (const rel of ready.deletes)
			retry(() => rmSync(join(source, rel), { force: true }));
		if (ready.modules) {
			retry(() =>
				renameSync(
					join(source, "computer", "node_modules"),
					join(prev, "node_modules"),
				),
			);
			retry(() =>
				renameSync(
					join(dir, "trial", "computer", "node_modules"),
					join(source, "computer", "node_modules"),
				),
			);
		}
		if (existsSync(base)) retry(() => renameSync(base, join(prev, "base")));
		retry(() => renameSync(join(dir, "new", release), base));
		save(join(dir, "trial.json"), {
			version: ready.version,
			conflicts: ready.conflicts,
		});
	} catch (e) {
		// If this throws too, touched.json without trial.json tells the
		// supervisor to try again before it starts the server.
		rollback(source, lab);
		throw e;
	}
	// The release passed its checks, so setup's gate starts from it.
	saveFile(join(lab, "source-ok"), treeHash(source));
	rmSync(join(dir, "ready.json"), { force: true });
	rmSync(join(dir, "trial"), { recursive: true, force: true });
	rmSync(join(dir, "new"), { recursive: true, force: true });
	return ready.version;
}

// An apply() that stopped partway, or a rollback that couldn't finish.
export const halfway = (lab: string) =>
	existsSync(join(work(lab), "touched.json")) &&
	!existsSync(join(work(lab), "trial.json"));

// Puts back what apply() replaced, base included, and remembers the version so
// it isn't tried again. It can be run again after it throws partway.
export function rollback(source: string, lab: string) {
	const dir = work(lab);
	const prev = join(dir, "previous");
	const base = join(lab, "base");
	const touched = readJson<string[]>(join(dir, "touched.json")) ?? [];
	for (const rel of touched)
		retry(() => {
			if (existsSync(join(prev, rel))) cpSync(join(prev, rel), join(source, rel));
			else rmSync(join(source, rel), { force: true });
		});
	if (existsSync(join(prev, "node_modules"))) {
		retry(() =>
			rmSync(join(source, "computer", "node_modules"), {
				recursive: true,
				force: true,
			}),
		);
		retry(() =>
			renameSync(join(prev, "node_modules"), join(source, "computer", "node_modules")),
		);
	}
	if (existsSync(join(prev, "base"))) {
		retry(() => rmSync(base, { recursive: true, force: true }));
		retry(() => renameSync(join(prev, "base"), base));
	} else if (existsSync(join(prev, "no-base")))
		retry(() => rmSync(base, { recursive: true, force: true }));
	const trial = readJson<{ version: string }>(join(dir, "trial.json"));
	if (trial) save(join(dir, "bad.json"), { version: trial.version });
	rmSync(join(dir, "trial.json"), { force: true });
	rmSync(join(dir, "touched.json"), { force: true });
	saveFile(join(lab, "source-ok"), treeHash(source));
}

// The supervisor's count of how often the release on trial has stopped.
// Every stop before it confirms counts, however long it ran, except an exit 0,
// which is a restart he asked for, and an exit 98, which means something else
// held the port. The third one puts the old version back.
export function trialExit(
	source: string,
	lab: string,
	code: number | null,
	fails: number,
): { fails: number; back: boolean } {
	if (!onTrial(lab)) return { fails: 0, back: false };
	if (code === 0 || code === 98) return { fails, back: false };
	if (fails + 1 < 3) return { fails: fails + 1, back: false };
	rollback(source, lab);
	return { fails: 0, back: true };
}

// The new server calls this once it has stayed up, and gets the version it
// came from an update to. A trial.json that can't be read counts as no trial.
export function confirm(lab: string): { version: string; conflicts: string[] } | null {
	const dir = work(lab);
	if (!existsSync(join(dir, "trial.json"))) return null;
	const trial = readJson<{ version: string; conflicts: string[] }>(
		join(dir, "trial.json"),
	);
	rmSync(join(dir, "trial.json"), { force: true });
	rmSync(join(dir, "previous"), { recursive: true, force: true });
	rmSync(join(dir, "touched.json"), { force: true });
	return trial;
}

export const onTrial = (lab: string) =>
	readJson<{ version: string }>(join(work(lab), "trial.json")) !== null;
export const bad = (lab: string) =>
	readJson<{ version: string }>(join(work(lab), "bad.json"))?.version;
