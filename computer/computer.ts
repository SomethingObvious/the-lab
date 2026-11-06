// Lets the agent use other apps on the computer, by reading and pressing their
// controls rather than from screenshots. It costs far fewer tokens than a
// picture and doesn't take the mouse away from him.
//
//   computer apps [words]
//   computer look APP [words]           The controls in APP's window, numbered
//   computer do APP STEP [STEP...]      Then shows the window again
//   computer shot APP [FILE]            A picture of that one window
//
// A STEP is press:N, toggle:N, focus:N, click:N, set:N=TEXT, type=TEXT or keys=ctrl+s.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { config, labDir, WIN } from "./config.ts";

export interface Window {
	app: string;
	pid: number;
	title: string;
	window: string;
}
export interface Element {
	id: string;
	role: string;
	name: string;
	can: string[];
	value?: string;
	secret?: boolean;
	off?: boolean;
	on?: boolean;
}
export interface Step {
	do: string;
	id?: string;
	text?: string;
	keys?: string;
	file?: string;
}

const LIMIT = 300;
const NATIVE_MS = 30_000;
// Long enough for his answer on the phone, which the server waits five minutes for.
const ASK_MS = 330_000;

// Apps it never works, whatever he's told it. Anything else he adds goes in
// neverApps in ~/.thelab/config.json, which the agent can't change.
const NEVER =
	/1password|bitwarden|lastpass|keepass|dashlane|enpass|nordpass|proton ?pass|keychain|credential manager|windows security|privacy & security|authenticator|\bauthy\b/i;

export const never = (w: Pick<Window, "app" | "title">, extra: string[] = []) => {
	const label = `${w.app} ${w.title}`;
	const lower = label.toLowerCase();
	return NEVER.test(label) || extra.some((x) => x && lower.includes(x.toLowerCase()));
};

// Controls whose press can't be taken back or reaches other people.
const LASTING =
	/\b(send|submit|pay|buy|purchase|order|checkout|delete|remove|erase|transfer|confirm|post|publish|share|reply|sign)\b/i;

export const irreversible = (s: Step, el?: Element) => {
	if (s.do === "keys") return /\b(enter|return)\b/i.test(s.keys ?? "");
	if (s.do === "type") return /\n/.test(s.text ?? "");
	return ["press", "click"].includes(s.do) && LASTING.test(el?.name ?? "");
};

export function pickWindow(all: Window[], want: string): Window {
	if (/^\d+$/.test(want)) {
		const byId = all.find((w) => w.window === want || String(w.pid) === want);
		if (byId) return byId;
	}
	const lower = want.toLowerCase();
	const hits = all.filter(
		(w) => w.app.toLowerCase().includes(lower) || w.title.toLowerCase().includes(lower),
	);
	const exact = hits.filter((w) => w.app.toLowerCase() === lower);
	const only = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : undefined;
	if (only) return only;
	if (hits.length === 0)
		throw new Error(
			`No open window matches "${want}". Open the app first (open -a NAME on a Mac, start NAME on Windows), then run computer apps.`,
		);
	throw new Error(
		`"${want}" matches ${hits.length} windows. Use one of these numbers:\n${hits.map(row).join("\n")}`,
	);
}

const row = (w: Window) => `${w.window}  ${w.app}: ${w.title}`;

export function drawn(elements: Element[], words: string[] = []): string {
	const lower = words.map((w) => w.toLowerCase());
	const lines = elements.flatMap((e, i) => {
		if (
			lower.length > 0 &&
			!lower.some((w) => `${e.name} ${e.value ?? ""}`.toLowerCase().includes(w))
		)
			return [];
		const value = e.secret
			? " = (hidden)"
			: e.value
				? ` = ${JSON.stringify(e.value)}`
				: "";
		const state = `${e.on === undefined ? "" : e.on ? " on" : " off"}${e.off ? " disabled" : ""}`;
		return [`${i + 1} ${e.role} ${JSON.stringify(e.name)}${value}${state}`];
	});
	if (elements.length >= LIMIT)
		lines.push(
			`Only the first ${LIMIT} controls are shown. Add words to narrow it down.`,
		);
	return lines.join("\n") || "Nothing there matches.";
}

export function parseStep(raw: string): Step {
	const [, verb = "", n = "", , text = ""] =
		/^(press|toggle|select|expand|focus|click|set):(\d+)(=([\s\S]*))?$/.exec(raw) ?? [];
	if (verb) {
		const step: Step = {
			do: verb === "toggle" || verb === "select" || verb === "expand" ? "press" : verb,
			id: n,
		};
		if (verb === "set") step.text = text;
		return step;
	}
	if (raw.startsWith("type=")) return { do: "type", text: raw.slice(5) };
	if (raw.startsWith("keys=")) return { do: "keys", keys: raw.slice(5) };
	throw new Error(
		`"${raw}" isn't a step. Use press:N, focus:N, click:N, set:N=TEXT, type=TEXT or keys=ctrl+s.`,
	);
}

const here = fileURLToPath(new URL(".", import.meta.url));

function native(request: object): Promise<{ apps?: Window[]; elements?: Element[] }> {
	const [bin, args] = WIN
		? ([
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					join(here, "computer-win.ps1"),
				],
			] as const)
		: ([join(labDir(), "bin", "lab-ax"), []] as const);
	if (!(WIN || existsSync(bin)))
		throw new Error(
			"The Mac helper isn't built. Tell him it needs Apple's Command Line Tools: run xcode-select --install in Terminal, then node setup.ts in the repo. Every other way of doing the task is still fine to try first.",
		);
	return new Promise((done, fail) => {
		const child = execFile(
			bin,
			[...args],
			{ timeout: NATIVE_MS, maxBuffer: 32 * 1024 * 1024 },
			(e, out) => {
				if (e && !out) return fail(new Error(`The helper failed: ${e.message}`));
				try {
					const r = JSON.parse(out) as {
						ok: boolean;
						error?: string;
						apps?: Window[];
						elements?: Element[];
					};
					if (!r.ok) return fail(new Error(r.error ?? "The helper failed."));
					done(r);
				} catch {
					fail(new Error(`The helper said something unexpected: ${out.slice(0, 200)}`));
				}
			},
		);
		child.stdin?.end(JSON.stringify(request));
	});
}

const refsFile = (w: Window) => join(tmpdir(), `the-lab-computer-${w.window}.json`);

function remembered(w: Window): Element[] {
	try {
		return JSON.parse(readFileSync(refsFile(w), "utf8")) as Element[];
	} catch {
		return [];
	}
}

// The server puts the question on his phone and holds the answer, so this
// works the same for both engines and can't be answered from here.
async function may(w: Window, doing: string, final: boolean, reads: boolean) {
	const { token, port } = config();
	const r = await fetch(`http://127.0.0.1:${port}/computer/ask`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({ app: w.app, doing, final, reads }),
		signal: AbortSignal.timeout(ASK_MS),
	});
	const { allow } = (await r.json()) as { allow?: boolean };
	if (allow !== true)
		throw new Error(`He didn't allow this: ${doing}. Don't try another way to do it.`);
}

const neverList = () => {
	const c = config() as { neverApps?: unknown };
	return Array.isArray(c.neverApps) ? c.neverApps.map(String) : [];
};

async function windows(): Promise<Window[]> {
	const { apps = [] } = await native({ op: "apps" });
	const extra = neverList();
	return apps.filter((w) => !never(w, extra));
}

async function look(w: Window, words: string[]) {
	const { elements = [] } = await native({
		window: w.window,
		limit: LIMIT,
		steps: [{ do: "look" }],
	});
	writeFileSync(refsFile(w), JSON.stringify(elements));
	return drawn(elements, words);
}

async function act(w: Window, raw: string[]) {
	const known = remembered(w);
	const steps = raw.map(parseStep).map((s) => {
		if (s.id === undefined) return { step: s, el: undefined };
		const el = known[Number(s.id) - 1];
		if (!el) throw new Error(`There's no control ${s.id}. Run computer look first.`);
		return { step: { ...s, id: el.id }, el };
	});
	const say = ({ step, el }: { step: Step; el: Element | undefined }) =>
		step.do === "keys"
			? `Press ${step.keys} in ${w.app}`
			: step.do === "type"
				? `Type in ${w.app}`
				: `${step.do === "set" ? "Fill in" : "Press"} "${el?.name ?? ""}" in ${w.app}`;
	const hard = steps.find(({ step, el }) => irreversible(step, el));
	await may(w, hard ? say(hard) : `Use ${w.app}`, Boolean(hard), false);
	const { elements = [] } = await native({
		window: w.window,
		limit: LIMIT,
		steps: [...steps.map((s) => s.step), { do: "look" }],
	});
	writeFileSync(refsFile(w), JSON.stringify(elements));
	return drawn(elements);
}

async function main([verb = "", target = "", ...rest]: string[]) {
	if (verb === "apps") {
		const wanted = [target, ...rest].filter(Boolean).map((x) => x.toLowerCase());
		const all = await windows();
		return (
			all
				.filter(
					(open) =>
						wanted.length === 0 ||
						wanted.some((x) => `${open.app} ${open.title}`.toLowerCase().includes(x)),
				)
				.map(row)
				.join("\n") || "No windows match."
		);
	}
	if (!(["look", "do", "shot"].includes(verb) && target))
		throw new Error(
			"Use computer apps, computer look APP, computer do APP STEP... or computer shot APP.",
		);
	const w = pickWindow(await windows(), target);
	if (verb === "look") {
		await may(w, `Use ${w.app}`, false, true);
		return look(w, rest);
	}
	if (verb === "do") {
		if (rest.length === 0)
			throw new Error("Say what to do, like computer do Notes press:4.");
		return act(w, rest);
	}
	await may(w, `Take a picture of ${w.app}`, false, true);
	const file = resolve(rest[0] ?? join(tmpdir(), `the-lab-window-${Date.now()}.png`));
	await native({ window: w.window, limit: 0, steps: [{ do: "shot", file }] });
	return file;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(out) => process.stdout.write(`${out}\n`),
		(e: unknown) => {
			process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
			process.exitCode = 1;
		},
	);
}
