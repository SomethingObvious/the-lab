// report: sends a problem in The Lab to its GitHub repository. With a fix
// in the folder it's given, that's a pull request. Without one, or when the
// fix can't go onto main cleanly, it's an issue with the change written out.
//
//   report --copy DIR                 copy The Lab's code into DIR to work on
//   report "Title" "What happened" [--from DIR]
//
// A fix only goes up once it passes the repository's lint rules and tests,
// the same ones every change to The Lab passes.

import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process, { env } from "node:process";
import { fileURLToPath } from "node:url";
import { labDir } from "./config.ts";
import { files, hunks, mergeTree, REPO } from "./update.ts";

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === "win32";
const SKIP = new Set([
	"node_modules",
	".git",
	"build",
	".gradle",
	".kotlin",
	".cxx",
	".idea",
]);

const sh = (cmd: string, args: string[], cwd?: string) => {
	const r = spawnSync(cmd, args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		timeout: 10 * 60_000,
	});
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
};
const say = (s: string) => process.stdout.write(`${s}\n`);
function fail(s: string): never {
	process.stderr.write(`${s}\n`);
	process.exit(1);
}

// The files in `dir` that differ from the release this computer installed.
function changes(base: string, dir: string): string[] {
	const all = new Set([...files(base), ...files(dir)]);
	return [...all].filter((rel) => {
		const a = join(base, rel);
		const b = join(dir, rel);
		if (!(existsSync(a) && existsSync(b))) return true;
		return !readFileSync(a).equals(readFileSync(b));
	});
}

// The change written out line by line, for an issue.
function written(base: string, dir: string, paths: string[]): string {
	const out: string[] = [];
	for (const rel of paths) {
		const a = existsSync(join(base, rel))
			? readFileSync(join(base, rel), "utf8").split("\n")
			: [];
		const b = existsSync(join(dir, rel))
			? readFileSync(join(dir, rel), "utf8").split("\n")
			: [];
		out.push(`--- ${rel}`);
		for (const h of hunks(a, b)) {
			out.push(`@@ line ${h.a0 + 1}`);
			for (const l of a.slice(h.a0, h.a1)) out.push(`-${l}`);
			for (const l of b.slice(h.b0, h.b1)) out.push(`+${l}`);
		}
	}
	return out.join("\n").slice(0, 60_000);
}

// The repository's own checks: its lint rules (warnings count), the type
// check and the computer's tests. Returns what failed.
export function verify(dir: string): string | null {
	const modules = join(dir, "computer", "node_modules");
	if (!existsSync(modules))
		symlinkSync(join(SOURCE, "computer", "node_modules"), modules, "junction");
	const r = sh(
		process.execPath,
		[
			join(modules, "@biomejs", "biome", "bin", "biome"),
			"ci",
			"--error-on-warnings",
			"--colors=off",
			`--config-path=${join(dir, "biome.json")}`,
			".",
		],
		dir,
	);
	if (!r.ok) return `the lint rules turned it down:\n${r.out.slice(0, 3000)}`;
	const tsc = join(modules, "typescript", "bin", "tsc");
	if (existsSync(tsc)) {
		const types = sh(process.execPath, [tsc], join(dir, "computer"));
		if (!types.ok) return `the type check turned it down:\n${types.out.slice(0, 3000)}`;
	}
	const sandbox = mkdtempSync(join(tmpdir(), "lab-report-"));
	const t = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test.ts"], {
		cwd: join(dir, "computer"),
		encoding: "utf8",
		windowsHide: true,
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
		const failed = [...(t.stdout ?? "").matchAll(/^not ok \d+ - (.+)$/gm)].map(
			(x) => x[1],
		);
		return `the tests failed: ${[...new Set(failed)].join(", ") || (t.stderr ?? "").slice(-1000)}`;
	}
	return null;
}

function gh(): { ok: boolean; login: string } {
	const r = sh("gh", ["api", "user", "--jq", ".login"]);
	return { ok: r.ok && Boolean(r.out), login: r.out };
}

function save(title: string, body: string): never {
	const dir = join(labDir(), "reports", new Date().toISOString().replace(/[:.]/g, "-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "report.md"), `# ${title}\n\n${body}\n`);
	say(
		`gh isn't signed in on this computer, so nothing went to GitHub. The report is saved in ${dir}. Running gh auth login, then this again, sends it.`,
	);
	process.exit(0);
}

function issue(title: string, body: string) {
	const r = sh("gh", [
		"issue",
		"create",
		"--repo",
		REPO,
		"--title",
		title,
		"--body",
		body,
	]);
	if (!r.ok) fail(`GitHub didn't take the issue: ${r.out}`);
	say(`Opened an issue: ${r.out.split("\n").at(-1)}`);
}

// Puts the fix on a branch of main and opens a pull request for it. Returns
// false when it can't go onto main cleanly.
function pull(
	title: string,
	body: string,
	base: string,
	dir: string,
	paths: string[],
	login: string,
): boolean {
	if (!sh("git", ["--version"]).ok) return false;
	const clone = mkdtempSync(join(tmpdir(), "lab-pr-"));
	try {
		if (!sh("gh", ["repo", "clone", REPO, clone, "--", "--depth", "1"]).ok)
			return false;
		const m = mergeTree(base, clone, dir, "theirs", paths);
		if (m.conflicts.length > 0) return false;
		for (const [rel, data] of m.writes) {
			const p = join(clone, rel);
			if (data === null) rmSync(p, { force: true });
			else {
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, data);
			}
		}
		const branch = `fix/${title
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 40)}-${Date.now().toString(36)}`;
		const git = (...a: string[]) => sh("git", a, clone);
		const id = sh("gh", ["api", "user", "--jq", ".id"]).out;
		git("checkout", "-b", branch);
		git("add", "-A");
		const done = git(
			"-c",
			`user.name=${login}`,
			"-c",
			`user.email=${id}+${login}@users.noreply.github.com`,
			"commit",
			"-m",
			title,
		);
		if (!done.ok) return false;
		const canPush =
			sh("gh", ["api", `repos/${REPO}`, "--jq", ".permissions.push"]).out === "true";
		let head = branch;
		if (!canPush) {
			if (
				!sh("gh", ["repo", "fork", REPO, "--remote", "--remote-name", "fork"], clone).ok
			)
				return false;
			head = `${login}:${branch}`;
		}
		if (!git("push", canPush ? "origin" : "fork", branch).ok) return false;
		const pr = sh(
			"gh",
			[
				"pr",
				"create",
				"--repo",
				REPO,
				"--head",
				head,
				"--title",
				title,
				"--body",
				body,
			],
			clone,
		);
		if (!pr.ok) return false;
		say(`Opened a pull request: ${pr.out.split("\n").at(-1)}`);
		return true;
	} finally {
		rmSync(clone, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const at = (flag: string) => {
		const i = args.indexOf(flag);
		return i >= 0 ? args.splice(i, 2)[1] : undefined;
	};
	const copy = at("--copy");
	if (copy) {
		cpSync(SOURCE, resolve(copy), {
			recursive: true,
			filter: (p) => !SKIP.has(p.split(/[\\/]/).pop() ?? ""),
		});
		say(
			`The Lab's code is in ${resolve(copy)}. Fix it there, then run report with --from ${resolve(copy)}.`,
		);
		process.exit(0);
	}
	const from = resolve(at("--from") ?? SOURCE);
	const [title, what] = args;
	if (!(title && what))
		fail('Usage: report "Title" "What happened" [--from DIR], or report --copy DIR');
	const base = join(labDir(), "base");
	const paths = existsSync(base) ? changes(base, from) : [];
	const pkg = JSON.parse(
		readFileSync(join(SOURCE, "computer", "package.json"), "utf8"),
	) as { version: string };
	let body = `${what}\n\nThe Lab v${pkg.version} on ${WIN ? "Windows" : process.platform === "darwin" ? "macOS" : process.platform}.`;
	if (paths.length > 0) {
		const problem = verify(from);
		if (problem)
			fail(
				`The fix isn't ready to send, as ${problem}\nFix that and run report again.`,
			);
		body += `\n\nChanged: ${paths.join(", ")}. It passes the lint rules and the tests on this computer.`;
	}
	const who = gh();
	if (!who.ok)
		save(
			title,
			paths.length > 0
				? `${body}\n\n\`\`\`diff\n${written(base, from, paths)}\n\`\`\``
				: body,
		);
	if (paths.length > 0 && pull(title, body, base, from, paths, who.login))
		process.exit(0);
	issue(
		title,
		paths.length > 0
			? `${body}\n\nIt couldn't go onto main as a pull request, so here it is written out.\n\n\`\`\`diff\n${written(base, from, paths)}\n\`\`\``
			: body,
	);
}
