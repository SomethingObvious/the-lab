// Updates The Lab from its GitHub releases with no agent involved. A release
// is merged three ways into what's installed, so fixes made on this computer
// and his own restyled app survive it. The merged copy has to pass the test
// suite before it goes in, and the supervisor in server.ts puts the old one
// back if the new server won't stay up.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { constants, setPriority, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import process, { env } from "node:process";
import { setting, words } from "./config.ts";
import { lint } from "./design.ts";

export const REPO = "SomethingObvious/the-lab";
const WIN = process.platform === "win32";
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
	// ponytail: plain LCS table, Myers diff if a file ever has thousands of changed lines.
	if ((endA - start) * (endB - start) > 16_000_000)
		return [{ a0: start, a1: endA, b0: start, b1: endB }];
	return walk(a.slice(start, endA), b.slice(start, endB), start);
}

// The longest common subsequence table for x and y, row by row.
function table(x: string[], y: string[]): Uint32Array {
	const w = y.length + 1;
	const lcs = new Uint32Array((x.length + 1) * w);
	for (let i = x.length - 1; i >= 0; i--)
		for (let j = y.length - 1; j >= 0; j--)
			lcs[i * w + j] =
				x[i] === y[j]
					? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
					: Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
	return lcs;
}

// The hunks between x and y, which start `at` lines into their files.
function walk(x: string[], y: string[], at: number): Hunk[] {
	const lcs = table(x, y);
	const w = y.length + 1;
	const out: Hunk[] = [];
	let i = 0;
	let j = 0;
	let open: Hunk | null = null;
	while (i < x.length || j < y.length) {
		if (i < x.length && j < y.length && x[i] === y[j]) {
			if (open) out.push(open);
			open = null;
			i++;
			j++;
			continue;
		}
		open ??= { a0: at + i, a1: at + i, b0: at + j, b1: at + j };
		const takeY =
			j < y.length &&
			(i === x.length || (lcs[i * w + j + 1] ?? 0) >= (lcs[(i + 1) * w + j] ?? 0));
		if (takeY) open.b1 = at + ++j;
		else open.a1 = at + ++i;
	}
	if (open) out.push(open);
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

// An update that changed desktop/ needs the window built again, once setup
// has built it the first time.
export function desktopStale(source: string, lab: string): boolean {
	const built = join(lab, "desktop", "built");
	return (
		existsSync(built) &&
		readFileSync(built, "utf8") !== treeHash(join(source, "desktop"))
	);
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
// files it couldn't bring over.
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
	// The new template becomes the base for what came over. A held file keeps
	// its old base, so the next update tries it again.
	const keep = new Set(held);
	for (const rel of files(next))
		if (!keep.has(rel)) {
			mkdirSync(dirname(join(base, rel)), { recursive: true });
			cpSync(join(next, rel), join(base, rel));
		}
	if (held.length > 0) {
		const copy = join(home, ".lab-update");
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

// The repository is private for now, so GitHub only answers with a token.
// gh's is used when it's signed in, and a public repository needs none.
function token(): string | undefined {
	for (const gh of WIN ? ["gh"] : ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"]) {
		const r = spawnSync(gh, ["auth", "token"], { encoding: "utf8", windowsHide: true });
		if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	}
	return setting("GH_TOKEN") ?? setting("GITHUB_TOKEN");
}

async function github(path: string): Promise<Response> {
	const key = token();
	return await fetch(`https://api.github.com/repos/${REPO}${path}`, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "the-lab",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		signal: AbortSignal.timeout(60_000),
	});
}

// The newest release tag, if it's newer than `current`.
export async function latest(current: string): Promise<string | null> {
	const r = await github("/tags?per_page=50");
	if (r.status === 404)
		throw new Error(
			"GitHub didn't show The Lab's releases. The repository is private, so gh has to be signed in to an account that can see it.",
		);
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
	const x = await run("tar", ["-xzf", file, "-C", dir], { timeout: 5 * 60_000 });
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
	opts: { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; timeout: number },
): Promise<{ status: number | null; out: string }> {
	return new Promise((done) => {
		const p = spawn(cmd, args, { ...opts, windowsHide: true });
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
	const base = join(lab, "base");
	// Without a base the source counts as unchanged, so the release goes in whole.
	const m = mergeTree(existsSync(base) ? base : source, source, theirs, "theirs");
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
		const npm = await run(WIN ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], {
			cwd: join(trial, "computer"),
			shell: WIN,
			timeout: 15 * 60_000,
		});
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
	writeFileSync(join(dir, "ready.json"), JSON.stringify(ready));
	return ready;
}

const readJson = <T>(p: string): T | null => {
	try {
		return JSON.parse(readFileSync(p, "utf8")) as T;
	} catch {
		return null;
	}
};

// Run by the supervisor with the server stopped. Every file it replaces is
// kept in update/previous first, so rollback() can put it back.
export function apply(source: string, lab: string): string | null {
	const dir = work(lab);
	const ready = readJson<Ready>(join(dir, "ready.json"));
	if (!ready) return null;
	const prev = join(dir, "previous");
	rmSync(prev, { recursive: true, force: true });
	mkdirSync(prev, { recursive: true });
	const touched = [...ready.writes, ...ready.deletes];
	writeFileSync(join(dir, "touched.json"), JSON.stringify(touched));
	try {
		for (const rel of touched)
			if (existsSync(join(source, rel))) {
				mkdirSync(dirname(join(prev, rel)), { recursive: true });
				cpSync(join(source, rel), join(prev, rel));
			}
		for (const rel of ready.writes) {
			mkdirSync(dirname(join(source, rel)), { recursive: true });
			cpSync(join(dir, "trial", rel), join(source, rel));
		}
		for (const rel of ready.deletes) rmSync(join(source, rel), { force: true });
		if (ready.modules) {
			renameSync(join(source, "computer", "node_modules"), join(prev, "node_modules"));
			renameSync(
				join(dir, "trial", "computer", "node_modules"),
				join(source, "computer", "node_modules"),
			);
		}
		const base = join(lab, "base");
		if (existsSync(base)) renameSync(base, join(prev, "base"));
		renameSync(join(dir, "new", readdirSync(join(dir, "new"))[0] ?? ""), base);
	} catch (e) {
		rollback(source, lab);
		throw e;
	}
	// The release passed its checks, so setup's gate starts from it.
	writeFileSync(join(lab, "source-ok"), treeHash(source));
	rmSync(join(dir, "ready.json"), { force: true });
	rmSync(join(dir, "trial"), { recursive: true, force: true });
	rmSync(join(dir, "new"), { recursive: true, force: true });
	writeFileSync(
		join(dir, "trial.json"),
		JSON.stringify({ version: ready.version, conflicts: ready.conflicts }),
	);
	return ready.version;
}

// Puts back what apply() replaced, and remembers the version so it isn't tried again.
export function rollback(source: string, lab: string) {
	const dir = work(lab);
	const prev = join(dir, "previous");
	const touched = readJson<string[]>(join(dir, "touched.json")) ?? [];
	for (const rel of touched) {
		if (existsSync(join(prev, rel))) cpSync(join(prev, rel), join(source, rel));
		else rmSync(join(source, rel), { force: true });
	}
	if (existsSync(join(prev, "node_modules"))) {
		rmSync(join(source, "computer", "node_modules"), { recursive: true, force: true });
		renameSync(join(prev, "node_modules"), join(source, "computer", "node_modules"));
	}
	if (existsSync(join(prev, "base"))) {
		rmSync(join(lab, "base"), { recursive: true, force: true });
		renameSync(join(prev, "base"), join(lab, "base"));
	}
	const trial = readJson<{ version: string }>(join(dir, "trial.json"));
	if (trial)
		writeFileSync(join(dir, "bad.json"), JSON.stringify({ version: trial.version }));
	rmSync(join(dir, "trial.json"), { force: true });
	rmSync(join(dir, "touched.json"), { force: true });
	writeFileSync(join(lab, "source-ok"), treeHash(source));
}

// The new server calls this once it has stayed up, and gets the version it
// came from an update to.
export function confirm(lab: string): { version: string; conflicts: string[] } | null {
	const dir = work(lab);
	const trial = readJson<{ version: string; conflicts: string[] }>(
		join(dir, "trial.json"),
	);
	if (!trial) return null;
	rmSync(join(dir, "trial.json"), { force: true });
	rmSync(join(dir, "previous"), { recursive: true, force: true });
	rmSync(join(dir, "touched.json"), { force: true });
	return trial;
}

export const onTrial = (lab: string) => existsSync(join(work(lab), "trial.json"));
export const bad = (lab: string) =>
	readJson<{ version: string }>(join(work(lab), "bad.json"))?.version;
