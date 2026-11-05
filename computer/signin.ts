// Notices when the engine has lost its sign-in, and signs it back in from the
// phone. Neither engine's own status command helps with the noticing, since
// both still say signed in with tokens that stopped working long ago.
import { type ChildProcess, spawn } from "node:child_process";
import process from "node:process";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { agentBin, claudeSignedIn } from "./checks.ts";
import { codexBin } from "./codex.ts";
import { cleanEnv, type Lab } from "./lab.ts";

export interface Login {
	url: string;
	// A code he types into the page, for Codex.
	code?: string;
	// Whether the page gives him a code to paste back, for Claude.
	paste: boolean;
}
export type SignedIn = "in" | "out" | "unknown";

const GIVE_UP_MS = 15 * 60_000;
const USAGE_MS = 10_000;
const MESSAGE_MS = 25_000;
// Nothing runs under this name. Without it the sign-in page would open on the
// computer, where he probably isn't.
const NO_BROWSER = "the-lab-no-browser";

interface Reply {
	id?: number;
	method?: string;
	params?: { success?: boolean; error?: string | null };
	result?: Record<string, unknown>;
	error?: { message: string };
}

function appServer(home: string) {
	const proc = spawn(process.execPath, [codexBin(), "app-server"], {
		cwd: home,
		stdio: ["pipe", "pipe", "ignore"],
		env: cleanEnv(),
	});
	const waiting = new Map<number, (m: Reply) => void>();
	let next = 0;
	let onNote: ((m: Reply) => void) | undefined;
	const gone = (why: string) => {
		for (const answer of waiting.values()) answer({ error: { message: why } });
		waiting.clear();
	};
	proc.on("error", (e) => gone(`Codex couldn't run (${e.message})`));
	proc.on("exit", (code) => gone(`Codex quit (${code})`));
	// A write to one that just quit fails with EPIPE, and the exit reports it.
	proc.stdin.on("error", () => proc.kill());
	createInterface({ input: proc.stdout }).on("line", (line) => {
		let m: Reply;
		try {
			m = JSON.parse(line);
		} catch {
			return;
		}
		const answer = m.id === undefined ? undefined : waiting.get(m.id);
		if (answer && m.id !== undefined) {
			waiting.delete(m.id);
			answer(m);
		} else if (m.method) onNote?.(m);
	});
	const call = (method: string, params: unknown) =>
		new Promise<Record<string, unknown>>((ok, no) => {
			const id = ++next;
			waiting.set(id, (m) =>
				m.error ? no(new Error(m.error.message)) : ok(m.result ?? {}),
			);
			proc.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	const ready = (async () => {
		await call("initialize", {
			clientInfo: { name: "the_lab", title: "The Lab", version: "1.0.0" },
			capabilities: null,
		});
		proc.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
	})();
	return {
		proc,
		call,
		ready,
		notes: (fn: (m: Reply) => void) => {
			onNote = fn;
		},
	};
}

const within = <T>(ms: number, work: Promise<T>, otherwise: T): Promise<T> =>
	Promise.race([work, sleep(ms, otherwise, { ref: false })]);

export class SignIn {
	private readonly lab: Lab;
	private readonly engine: "claude" | "codex";
	private readonly home: string;
	private readonly claudeCommand: string[];
	// Asking again while one is open returns the same page, so a slow start or
	// a sheet closed by accident doesn't throw away a sign-in he's partway through.
	private login: Promise<Login> | null = null;
	private proc: ChildProcess | null = null;
	private finished: Promise<void> | null = null;

	constructor(
		lab: Lab,
		engine: "claude" | "codex",
		home: string,
		claudeCommand: string[] = [],
	) {
		this.lab = lab;
		this.engine = engine;
		this.home = home;
		this.claudeCommand = claudeCommand;
	}

	begin(): Promise<Login> {
		this.login ??= (
			this.engine === "codex" ? this.beginCodex() : this.beginClaude()
		).catch((e) => {
			this.end();
			throw e;
		});
		return this.login;
	}

	private end() {
		this.login = null;
		this.finished = null;
		this.proc?.kill();
		this.proc = null;
	}

	private beginClaude(): Promise<Login> {
		const [file = agentBin(), ...args] = this.claudeCommand;
		const proc = spawn(file, [...args, "auth", "login"], {
			cwd: this.home,
			stdio: "pipe",
			env: cleanEnv({ BROWSER: NO_BROWSER }),
		});
		this.proc = proc;
		const giveUp = setTimeout(() => proc.kill(), GIVE_UP_MS);
		giveUp.unref();
		let out = "";
		return new Promise<Login>((ok, no) => {
			// It prints two addresses in effect, and only this one ends on a page
			// that shows a code. The other redirects to localhost on the computer.
			const read = (d: Buffer) => {
				out += d.toString();
				const url = /visit: (https:\S+)/.exec(out)?.[1];
				if (url) ok({ url, paste: true });
			};
			proc.stdout.on("data", read);
			proc.stderr.on("data", read);
			proc.stdin.on("error", () => proc.kill());
			proc.on("error", (e) => no(new Error(`Claude couldn't run (${e.message})`)));
			this.finished = new Promise<void>((done, failed) => {
				proc.on("exit", (code) => {
					clearTimeout(giveUp);
					if (this.proc !== proc) return;
					const why = /Login failed: (.*)/.exec(out)?.[1]?.trim();
					this.end();
					if (code === 0) {
						this.lab.signedIn();
						return done();
					}
					const problem = new Error(
						why ?? `The sign-in stopped (${code}). Try it again.`,
					);
					no(problem);
					failed(problem);
				});
			});
			// A sign-in nobody finishes isn't a failure anyone is waiting to hear about.
			this.finished.catch(() => undefined);
		});
	}

	// The page gives a one-time code, which goes to the login still waiting
	// here and never into a log or the history.
	async paste(code: string) {
		const proc = this.proc;
		const finished = this.finished;
		if (!(proc && finished))
			throw new Error("That sign-in has ended, so start it again for a new code.");
		proc.stdin?.write(`${code}\n`);
		await finished;
	}

	private async beginCodex(): Promise<Login> {
		const s = appServer(this.home);
		this.proc = s.proc;
		const giveUp = setTimeout(() => this.proc === s.proc && this.end(), GIVE_UP_MS);
		giveUp.unref();
		// Otherwise the next Sign In would hand back a code nothing is waiting on.
		s.proc.on("exit", () => {
			clearTimeout(giveUp);
			if (this.proc === s.proc) this.end();
		});
		s.notes((m) => {
			if (m.method !== "account/login/completed" || this.proc !== s.proc) return;
			clearTimeout(giveUp);
			this.end();
			if (m.params?.success) this.lab.signedIn();
			else
				this.lab.signedOut(
					`The ChatGPT sign-in didn't finish (${m.params?.error ?? "no reason given"}).`,
				);
		});
		await s.ready;
		const r = await s.call("account/login/start", { type: "chatgptDeviceCode" });
		return {
			url: String(r["verificationUrl"]),
			code: String(r["userCode"]),
			paste: false,
		};
	}

	private async probeCodex(): Promise<SignedIn> {
		const s = appServer(this.home);
		try {
			const read = async (): Promise<SignedIn> => {
				await s.ready;
				// Not refreshToken: true. The Codex app can share this sign-in and its
				// refresh tokens are single use, so forcing one every hour could be
				// what signs him out. This call already fails on a dead sign-in.
				const a = await s.call("account/read", { refreshToken: false });
				return a["account"] || !a["requiresOpenaiAuth"] ? "in" : "out";
			};
			return await within(MESSAGE_MS, read(), "unknown");
		} catch {
			return "unknown";
		} finally {
			s.proc.kill();
		}
	}

	private async probeClaude(): Promise<SignedIn> {
		const who = claudeSignedIn();
		if (!who.loggedIn) return "out";
		// An API key doesn't expire the way a plan sign-in does, and the message
		// below would be billed to it.
		if (who.authMethod !== "claude.ai") return "in";
		const options = {
			cwd: this.home,
			env: cleanEnv(),
			persistSession: false,
			settingSources: [],
		};
		// The plan's usage costs nothing to read, and it only comes back with a
		// sign-in that works.
		const usage = query({
			// A prompt that ends closes the engine, so it stays open for the answer.
			prompt: (async function* () {
				await sleep(USAGE_MS, undefined, { ref: false });
				yield* [];
			})(),
			options,
		});
		try {
			const read = usage.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({
				skipBehaviors: true,
			});
			const got = await within(
				USAGE_MS,
				read.catch(() => null),
				null,
			);
			if (got?.rate_limits) return "in";
		} finally {
			usage.close();
		}
		// It also comes back empty when the computer is offline, and only a real
		// message can tell those apart. This is a few tokens of Haiku, and it only
		// runs when the free check looks wrong.
		const ask = query({
			prompt: "Reply with OK.",
			options: { ...options, model: "haiku", maxTurns: 1, tools: [], systemPrompt: "" },
		});
		const answer = async (): Promise<SignedIn> => {
			for await (const m of ask) {
				if (m.type === "auth_status" && m.error) return "out";
				if (m.type === "assistant") {
					if (m.error === "authentication_failed") return "out";
					return m.error ? "unknown" : "in";
				}
			}
			return "unknown";
		};
		try {
			return await within(
				MESSAGE_MS,
				answer().catch(() => "unknown" as const),
				"unknown",
			);
		} finally {
			ask.close();
		}
	}

	probe(): Promise<SignedIn> {
		return this.engine === "codex" ? this.probeCodex() : this.probeClaude();
	}

	// Offline says nothing either way, so "unknown" changes nothing.
	async check(): Promise<SignedIn> {
		const now = await this.probe();
		if (now === "out" && !this.lab.state.signedOut) this.lab.signedOut();
		if (now === "in" && this.lab.state.signedOut) this.lab.signedIn();
		return now;
	}
}
