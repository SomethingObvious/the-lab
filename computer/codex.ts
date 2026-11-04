// Runs the conversation through Codex instead of Claude, for someone whose
// plan is ChatGPT. It talks to `codex app-server` over stdio, which is the
// one Codex interface with approval requests, and maps its items onto the
// same events the phone already draws.
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, delimiter, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { setting } from "./config.ts";
import { type Judgement, judge, needsOk } from "./guard.ts";
import { type Card, cleanEnv, type Lab, STOP_MS, UNFINISHED } from "./lab.ts";
import { scheduleProblem } from "./schedule.ts";
import { clip, title } from "./steps.ts";

// The parts of the app-server protocol this file reads.
interface CommandAction {
	type: string;
	path?: string | null;
	name?: string;
	query?: string | null;
}
interface CommandItem {
	type: "commandExecution";
	id: string;
	command: string;
	commandActions?: CommandAction[];
	status?: string;
	aggregatedOutput?: string | null;
	exitCode?: number | null;
}
interface FileChangeItem {
	type: "fileChange";
	id: string;
	changes?: { path: string; diff: string }[];
	status?: string;
}
interface McpItem {
	type: "mcpToolCall";
	id: string;
	server: string;
	tool: string;
	arguments?: Record<string, unknown> | null;
	status?: string;
	error?: { message?: string } | null;
}
interface MessageItem {
	type: "agentMessage";
	id: string;
	phase?: string;
	text?: string;
}
interface SearchItem {
	type: "webSearch";
	id: string;
	query?: string;
	action?: { query?: string; url?: string } | null;
}
interface StatusItem {
	type: "reasoning" | "contextCompaction";
	id: string;
}
type Item =
	| CommandItem
	| FileChangeItem
	| McpItem
	| MessageItem
	| SearchItem
	| StatusItem;

interface TurnEnd {
	status: string;
	durationMs?: number | null;
	error?: { message: string; codexErrorInfo?: unknown } | null;
}
interface Turn extends TurnEnd {
	id: string;
}

// Notifications and the approval requests, which share one params object.
interface Params {
	turn?: Turn;
	item?: Item;
	willRetry?: boolean;
	command?: string;
	approvalId?: string;
	itemId?: string;
	cwd?: string;
	networkApprovalContext?: { host?: string } | null;
	reason?: string | null;
	permissions?: { network?: unknown; fileSystem?: unknown } | null;
	serverName?: string;
	message?: string;
	mode?: string;
}

interface CodexModel {
	id?: string;
	model?: string;
	displayName?: string;
	description?: string;
	isDefault?: boolean;
}

// What a call resolves with, across every method this file calls.
interface Reply {
	data?: CodexModel[];
	turn?: { id: string };
	thread?: { id: string };
	model?: string | null;
	account?: unknown;
	requiresOpenaiAuth?: boolean;
}

interface Incoming {
	id?: number | string;
	method?: string;
	params?: Params;
	result?: Reply;
	error?: { message: string; code?: number };
}
interface Outgoing {
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message: string; code?: number };
}

const SIGNED_OUT =
	"The computer is signed out of ChatGPT. Open the Codex app on the computer and sign in, then send your message again.";
const NOTICE: Record<string, string> = {
	unauthorized: SIGNED_OUT,
	usageLimitExceeded:
		"The ChatGPT plan hit its usage limit for now. It will carry on once the limit resets.",
};

const CALL_MS = 60_000;

// The npm package's launcher picks the right native binary for this computer.
export const codexBin = () =>
	setting("LAB_CODEX_BIN") ??
	createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js");

// `bash -lc '...'` is how every command arrives, which is noise on a phone.
export function unwrap(command: string): string {
	const m = /^(?:\S*\/)?(?:bash|zsh|sh) -lc (['"])([\s\S]*)\1$/.exec(command.trim());
	const inner = m?.[2];
	if (inner !== undefined) return inner.replace(/'\\''/g, "'");
	// On Windows it runs everything through PowerShell.
	const ps =
		/^"?(?:[^"]*[\\/])?(?:powershell|pwsh)(?:\.exe)?"?(?:\s+-\w+)*?\s+-Command\s+(['"]?)([\s\S]*)\1$/i.exec(
			command.trim(),
		);
	return ps?.[2] ?? command;
}

// The tool name its commands are judged as, since Windows runs them in PowerShell.
const SHELL = process.platform === "win32" ? "PowerShell" : "Bash";

// One line for a command item, from Codex's own parse of it where it has one.
export function commandTitle(item: {
	command: string;
	commandActions?: CommandAction[];
}): string {
	const acts = item.commandActions ?? [];
	const [a] = acts;
	if (acts.length === 1 && a) {
		if (a.type === "read") return title("Read", { file_path: a.path ?? a.name });
		if (a.type === "listFiles")
			return `Looking in ${a.path ? title("Read", { file_path: a.path }).slice(8) : "the folder"}`;
		if (a.type === "search" && a.query) return title("Grep", { pattern: a.query });
	}
	const cmd = unwrap(item.command);
	const sent =
		/^(?:cp|mv)\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)\s+\S*to-phone\/?\S*$/.exec(
			cmd,
		)?.[1];
	if (sent)
		return title("mcp__lab__send_to_phone", {
			path: sent.replace(/^["']|["']$/g, ""),
		});
	return clip(cmd, 80);
}

export class Codex {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private ready: Promise<void> | null = null;
	private next = 1;
	private readonly pending = new Map<
		number,
		{ ok: (r: Reply) => void; fail: (e: Error) => void }
	>();
	private turn: string | null = null;
	private started = 0;
	private queue: { text: string; images: string[]; you: number }[] = [];
	private starting: Promise<void> | null = null;
	private taken = 0;
	private lastError: Error | null = null;
	private readonly seen = new Map<
		string,
		{ tool: string; title: string; detail: string }
	>();
	// Every path each file change touches, as its approval names none.
	private readonly changes = new Map<string, string[]>();

	private readonly lab: Lab;
	private readonly home: string;
	private readonly prompt: string;
	private model: string | undefined;

	constructor(lab: Lab, home: string, prompt: string, model?: string) {
		this.lab = lab;
		this.home = home;
		this.prompt = prompt;
		this.model = model;
	}

	// `you` is the id of his message's event, so the turn's done can say which
	// messages it answered.
	send(text: string, images: string[], you: number) {
		this.queue.push({ text, images, you });
		this.pump().catch((e) => this.broke(e));
	}

	setModel(model: string | undefined) {
		this.model = model;
	}

	// Effort sticks to the thread too, so once one has been sent, Normal is
	// sent as medium, which is Codex's own default.
	private effortSent = false;
	private turnEffort(): string | undefined {
		if (this.lab.effort) this.effortSent = true;
		return this.lab.effort ?? (this.effortSent ? "medium" : undefined);
	}

	// A model given to turn/start sticks to the thread, so going back to the
	// default has to name the default.
	private picked = false;
	private async turnModel(): Promise<string | undefined> {
		if (this.model) {
			this.picked = true;
			return this.model;
		}
		if (!this.picked) return undefined;
		const r = await this.call("model/list", { limit: 100 }).catch(() => null);
		const def = r?.data?.find((m) => m.isDefault);
		if (def) this.picked = false;
		return def ? String(def.model ?? def.id) : undefined;
	}

	async models() {
		await this.start();
		const r = await this.call("model/list", { limit: 100 });
		return (r.data ?? []).map((m) => ({
			id: String(m.model ?? m.id),
			name: String(m.displayName ?? m.model ?? m.id),
			description: String(m.description ?? ""),
		}));
	}

	close() {
		const p = this.proc;
		this.proc = null;
		p?.kill();
	}

	async stop() {
		this.queue = [];
		await this.starting?.catch(() => {
			// A start that failed has already been reported where it was started.
		});
		const turn = this.turn;
		if (turn && this.lab.state.threadId) {
			// An app-server that stopped responding never ends the turn, so after
			// 15 seconds it's ended here and a fresh one starts on the next message.
			setTimeout(() => {
				if (this.turn !== turn) return;
				this.finish({ status: "interrupted" });
				this.proc?.kill();
			}, STOP_MS).unref();
			await this.call("turn/interrupt", {
				threadId: this.lab.state.threadId,
				turnId: turn,
			}).catch(() => {
				// An interrupt that fails means the turn already ended.
			});
			return;
		}
		// Stopped before a turn began, so nothing else will end it.
		this.lab.store.add({ kind: "done", ok: false, stopped: true, ms: 0 });
		this.lab.state.open = null;
		this.lab.save();
		this.lab.setStatus(false);
	}

	private input({ text, images }: { text: string; images: string[] }) {
		return [
			{ type: "text", text, text_elements: [] },
			...images.map((path) => ({ type: "localImage", path })),
		];
	}

	private async pump() {
		if (this.queue.length === 0) return;
		await this.start();
		// A turn still being started has no id to steer into yet. This must not
		// await when nothing is starting, or a second message slips in between.
		while (this.starting)
			await this.starting.catch(() => {
				// A start that failed has already been reported where it was started.
			});
		const threadId = this.lab.state.threadId;
		if (threadId === undefined) throw new Error("Codex started without a thread.");
		// A message sent mid-task joins the running turn, the same as with
		// Claude. If it can't, it waits for the turn to end.
		if (this.turn) {
			const m = this.queue[0];
			if (!m) return;
			const steered = await this.call("turn/steer", {
				threadId,
				input: this.input(m),
				expectedTurnId: this.turn,
			}).then(
				() => true,
				() => false,
			);
			if (steered) {
				this.queue.shift();
				this.taken = m.you;
			}
			return;
		}
		const m = this.queue.shift();
		if (!m) return;
		this.turn = "starting";
		this.started = Date.now();
		this.starting = (async () => {
			try {
				let r: Reply;
				try {
					const model = await this.turnModel();
					const effort = this.turnEffort();
					r = await this.call("turn/start", {
						threadId,
						input: this.input(m),
						cwd: this.home,
						approvalPolicy: "on-request",
						// Only his Lab folder is writable and the network is off, so anything
						// touching the rest of the computer or the internet comes back as an
						// approval request, where the server's guard decides it. Instructions
						// alone don't hold an agent to a rule, the sandbox does.
						sandboxPolicy: {
							type: "workspaceWrite",
							writableRoots: [this.home],
							networkAccess: false,
							excludeTmpdirEnvVar: false,
							excludeSlashTmp: false,
						},
						...(model ? { model } : {}),
						...(effort ? { effort } : {}),
					});
				} catch (e) {
					this.turn = null;
					throw e;
				}
				if (this.turn === "starting") {
					if (!r.turn) throw new Error("Codex started a turn without saying its id.");
					this.turn = r.turn.id;
				}
				this.taken = m.you;
			} finally {
				this.starting = null;
			}
		})();
		await this.starting;
	}

	private start(): Promise<void> {
		this.ready ??= (async () => {
			const proc = spawn(process.execPath, [codexBin(), "app-server"], {
				cwd: this.home,
				stdio: ["pipe", "pipe", "pipe"],
				env: cleanEnv({
					PATH: `${join(this.lab.where.lab, "bin")}${delimiter}${setting("PATH") ?? ""}`,
				}),
			});
			this.proc = proc;
			proc.stderr.on("data", (d) => process.stderr.write(d));
			createInterface({ input: proc.stdout }).on("line", (line) => {
				let m: Incoming;
				try {
					m = JSON.parse(line);
				} catch {
					return;
				}
				this.take(m);
			});
			proc.on("exit", (code) => {
				if (this.proc !== proc) return;
				this.proc = null;
				this.ready = null;
				for (const p of this.pending.values())
					p.fail(new Error(`codex app-server exited (${code})`));
				this.pending.clear();
				if (this.turn)
					this.finish({
						status: "failed",
						error: { message: `Codex quit partway through (exit ${code}).` },
					});
			});
			await this.call("initialize", {
				clientInfo: { name: "the_lab", title: "The Lab", version: "1.0.0" },
				capabilities: null,
			});
			this.write({ method: "initialized", params: {} });
			const acct = await this.call("account/read", { refreshToken: false });
			if (!acct.account && acct.requiresOpenaiAuth) throw new Error(SIGNED_OUT);
			const instructions = `${this.prompt} Your notes about him are in memory.md in the working directory, so read it at the start of a conversation and keep it up to date. You can only write inside the working directory and the network is off, so for anything else run the command with sandbox_permissions set to require_escalated and a justification he'll understand in one short sentence. The computer decides those, and asks him on his phone first for anything that deletes, sends, installs or changes settings. A declined request means no, so don't look for a way around it.`;
			const opts = {
				cwd: this.home,
				approvalPolicy: "on-request",
				sandbox: "workspace-write",
				developerInstructions: instructions,
				...(this.model ? { model: this.model } : {}),
			};
			const saved = this.lab.state.threadId;
			let r: Reply | null = null;
			if (saved)
				try {
					r = await this.call("thread/resume", {
						threadId: saved,
						excludeTurns: true,
						...opts,
					});
				} catch {
					// One that can't be reopened is replaced by a fresh one below.
				}
			if (saved && !r)
				this.lab.store.add({
					kind: "notice",
					text: "The last conversation could not be reopened, so this is a fresh one.",
				});
			const thread =
				r ?? (await this.call("thread/start", { ...opts, serviceName: "the_lab" }));
			if (!thread.thread)
				throw new Error("Codex opened a conversation without its id.");
			this.lab.state.threadId = thread.thread.id;
			this.lab.modelInUse = thread.model ?? null;
			this.lab.save();
			process.stdout.write(`codex thread ${thread.thread.id} model=${thread.model}\n`);
		})().catch((e) => {
			this.ready = null;
			this.proc?.kill();
			throw e;
		});
		return this.ready;
	}

	private write(m: Outgoing) {
		this.proc?.stdin.write(`${JSON.stringify(m)}\n`);
	}

	// Every call here gets its answer within seconds. One that doesn't means
	// app-server stopped responding, so it's restarted rather than left to
	// hold the turn, and Stop, forever.
	private call(method: string, params: unknown): Promise<Reply> {
		const id = this.next++;
		return new Promise((ok, fail) => {
			const timer = setTimeout(() => {
				if (!this.pending.delete(id)) return;
				fail(new Error(`Codex didn't answer ${method} within a minute.`));
				this.proc?.kill();
			}, CALL_MS);
			timer.unref();
			const done = () => clearTimeout(timer);
			this.pending.set(id, {
				ok: (r) => {
					done();
					ok(r);
				},
				fail: (e) => {
					done();
					fail(e);
				},
			});
			this.write({ id, method, params });
		});
	}

	// Something failed before a turn could even start, like a sign-in.
	private broke(e: Error) {
		// Every message waiting on a failed start rejects with the same error.
		if (e === this.lastError) return;
		this.lastError = e;
		console.error("codex:", e.message);
		this.lab.store.add({
			kind: "notice",
			text: Object.values(NOTICE).includes(e.message)
				? e.message
				: `Codex couldn't start (${clip(e.message, 160)}). Send your message again in a minute.`,
		});
		this.queue = [];
		this.lab.store.add({
			kind: "done",
			ok: false,
			stopped: false,
			ms: 0,
		});
		this.lab.state.open = null;
		this.lab.save();
		this.lab.setStatus(false);
	}

	private take(m: Incoming) {
		if (m.id !== undefined) {
			if (!m.method) {
				const p = this.pending.get(Number(m.id));
				this.pending.delete(Number(m.id));
				if (m.error) p?.fail(new Error(m.error.message));
				else p?.ok(m.result ?? {});
				return;
			}
			const { id, method } = m;
			// A throw while deciding would otherwise take the whole server down.
			this.request(id, method, m.params ?? {}).catch((e) => {
				console.error(`codex ${method}:`, e);
				this.write({
					id,
					error: { code: -32_603, message: "The Lab couldn't decide this one." },
				});
			});
			return;
		}
		const p = m.params ?? {};
		// A notification missing the part it's about has nothing to draw.
		switch (m.method) {
			case "turn/started":
				if (this.turn === "starting" && p.turn) this.turn = p.turn.id;
				return;
			case "item/started":
				return p.item && this.begin(p.item);
			case "item/completed":
				return p.item && this.completed(p.item);
			case "turn/completed":
				return p.turn && this.finish(p.turn);
			case "error":
				if (p.willRetry) this.lab.setStatus(true, "Waiting on the API");
				return;
		}
	}

	private step(
		ref: string,
		tool: string,
		input: Record<string, unknown>,
		t: string,
		detail: string,
	) {
		this.seen.set(ref, { tool, title: t, detail });
		this.lab.step(ref, tool, input, t, detail);
	}

	private begin(item: Item) {
		switch (item.type) {
			case "commandExecution":
				return this.step(
					item.id,
					SHELL,
					{ command: unwrap(item.command) },
					commandTitle(item),
					unwrap(item.command),
				);
			case "fileChange": {
				const paths = (item.changes ?? []).map((c) => c.path);
				this.changes.set(item.id, paths);
				const t =
					paths.length === 1
						? title("Edit", { file_path: paths[0] })
						: `Editing ${paths.length} files`;
				return this.step(
					item.id,
					"Edit",
					{ file_path: paths[0] },
					t,
					clip(
						(item.changes ?? []).map((c) => `${c.path}\n${c.diff}`).join("\n\n"),
						4000,
					),
				);
			}
			case "mcpToolCall": {
				const tool = `mcp__${item.server}__${item.tool}`;
				return this.step(
					item.id,
					tool,
					item.arguments ?? {},
					title(tool, item.arguments ?? {}),
					clip(JSON.stringify(item.arguments ?? {}, null, 2), 4000),
				);
			}
			case "reasoning":
				return this.lab.setStatus(true, "Thinking");
			case "contextCompaction":
				return this.lab.setStatus(true, "Compacting the conversation");
		}
	}

	private completed(item: Item) {
		switch (item.type) {
			case "agentMessage":
				// Commentary is Codex talking to itself between steps, so it goes in
				// the toolbar rather than becoming a reply he gets notified about.
				if (item.phase === "commentary") {
					if (item.text?.trim()) this.lab.setStatus(true, clip(item.text.trim(), 80));
				} else if (item.text?.trim()) this.lab.reply(item.text);
				return;
			// The query is only filled in once the search has run.
			case "webSearch": {
				const q = item.query || item.action?.query || item.action?.url || "";
				if (q)
					this.step(
						item.id,
						"WebSearch",
						{ query: q },
						title("WebSearch", { query: q }),
						q,
					);
				return;
			}
			case "commandExecution":
				if (item.status === "failed")
					this.lab.failed(
						item.id,
						clip(
							item.aggregatedOutput?.trim() || `It exited with code ${item.exitCode}.`,
							600,
						),
					);
				return;
			case "fileChange": {
				if (item.status === "failed")
					this.lab.failed(item.id, "The change couldn't be applied.");
				// There's no hook here to tell it in the same turn, so it hears with
				// its next message.
				const list = (item.changes ?? []).find(
					(c) => basename(c.path) === "schedules.json",
				);
				const problem = list && scheduleProblem(list.path);
				if (problem) this.lab.note(problem);
				return;
			}
			case "mcpToolCall":
				if (item.status === "failed")
					this.lab.failed(
						item.id,
						clip(item.error?.message ?? "The tool call failed.", 600),
					);
				return;
		}
	}

	private finish(turn: TurnEnd) {
		const stopped = turn.status === "interrupted";
		const ok = turn.status === "completed";
		const info =
			typeof turn.error?.codexErrorInfo === "string" ? turn.error.codexErrorInfo : "";
		if (NOTICE[info]) this.lab.store.add({ kind: "notice", text: NOTICE[info] });
		this.lab.store.add({
			kind: "done",
			ok,
			stopped,
			ms: turn.durationMs ?? Date.now() - this.started,
			...(this.taken ? { upto: this.taken } : {}),
			...(ok || stopped ? {} : { error: UNFINISHED }),
		});
		if (!(ok || stopped)) console.error("codex turn failed:", turn.error?.message);
		this.turn = null;
		this.taken = 0;
		this.seen.clear();
		this.changes.clear();
		this.lab.hushed.clear();
		for (const finish of this.lab.asks.values()) finish(false, "stop");
		this.lab.state.open = null;
		this.lab.save();
		this.lab.setStatus(false);
		if (this.queue.length > 0) {
			this.lab.setStatus(true, "Reading your message");
			this.pump().catch((e) => this.broke(e));
		}
	}

	// Approval requests from Codex. The guard decides them the same way as
	// for Claude: refused outright, decided here, or put to him on the phone.
	private async request(id: number | string, method: string, p: Params) {
		switch (method) {
			case "item/commandExecution/requestApproval":
				return this.write({ id, result: await this.commandApproval(p) });
			case "item/fileChange/requestApproval":
				return this.write({ id, result: await this.fileChangeApproval(p) });
			case "item/permissions/requestApproval":
				return this.write({ id, result: await this.permissionsApproval(p) });
			case "mcpServer/elicitation/request":
				return this.write({ id, result: await this.elicitation(id, p) });
			default:
				// Multiple-choice questions and the rest have no surface on the phone,
				// so the agent falls back to asking in plain text.
				this.write({
					id,
					error: {
						code: -32_601,
						message: `${method} isn't supported by The Lab. Ask in plain text instead.`,
					},
				});
		}
	}

	private async ask(ref: string, tool: string, card: Card) {
		return (await this.lab.waitFor(ref, tool, card)).allow;
	}

	private async commandApproval(p: Params) {
		const lab = this.lab;
		const cmd = unwrap(p.command ?? "");
		const ref = String(p.approvalId ?? p.itemId);
		const cwd = String(p.cwd ?? this.home);
		const where = { ...lab.where, cwd };
		const host = p.networkApprovalContext?.host;
		const j: Judgement = cmd
			? judge(SHELL, { command: cmd }, where)
			: {
					effect: "read",
					plain: `Reach ${host ?? "the internet"}`,
					touches: [host ?? ""],
					undo: null,
					leaves: false,
				};
		if (j.source && !lab.taint) lab.taint = j.source;
		if (j.block) {
			lab.blocked(ref, SHELL, j);
			return { decision: "decline" };
		}
		// Its instructions say to use the trash command, so a plain rm is
		// turned down quietly and it tries again that way.
		if (j.rm) {
			lab.hushed.add(ref);
			return { decision: "decline" };
		}
		const risky = j.effect === "delete" || j.effect === "system" || j.effect === "run";
		if (lab.allowedBefore(cmd, cwd) || !needsOk(j, where, Boolean(lab.taint))) {
			if (risky) await lab.snap(60_000);
			return { decision: "accept" };
		}
		if (risky) await lab.snap(60_000);
		const card = lab.card(
			SHELL,
			{ command: cmd || host || "" },
			j,
			p.reason ? String(p.reason) : undefined,
			cwd,
		);
		return { decision: (await this.ask(ref, SHELL, card)) ? "accept" : "decline" };
	}

	// A change outside his Lab folder. Edits go ahead, as they do for
	// Claude, unless they reach The Lab itself or the agent's settings.
	private async fileChangeApproval(p: Params) {
		const lab = this.lab;
		const paths = p.itemId === undefined ? undefined : this.changes.get(p.itemId);
		// One whose paths aren't known can't be checked, so it doesn't go ahead.
		if (!paths?.length) return { decision: "decline" };
		const j = paths
			.map((f) => judge("Edit", { file_path: f }, lab.where))
			.find((x) => x.block);
		if (j) {
			lab.blocked(String(p.itemId), "Edit", j);
			return { decision: "decline" };
		}
		await lab.snap(60_000);
		return { decision: "accept" };
	}

	private async permissionsApproval(p: Params) {
		const lab = this.lab;
		const j: Judgement = {
			effect: "system",
			plain: "Give it more access for this task",
			touches: [],
			undo: "yes",
			leaves: Boolean(p.permissions?.network),
			unsure: true,
		};
		const allow = await this.ask(String(p.itemId), "Bash", {
			...lab.card("Bash", {}, j, p.reason ? String(p.reason) : undefined),
			detail: JSON.stringify(p.permissions, null, 2),
		});
		const { network, fileSystem } = p.permissions ?? {};
		return {
			permissions: allow
				? { ...(network ? { network } : {}), ...(fileSystem ? { fileSystem } : {}) }
				: {},
			scope: "turn",
		};
	}

	private async elicitation(id: number | string, p: Params) {
		const lab = this.lab;
		const tool = `mcp__${p.serverName}__ask`;
		const j = {
			...judge(tool, {}, lab.where),
			plain: clip(String(p.message ?? p.serverName), 100),
		};
		const allow =
			p.mode !== "url" &&
			(await this.ask(`el-${id}`, tool, {
				...lab.card(tool, {}, j),
				detail: String(p.message ?? ""),
			}));
		return {
			action: allow ? "accept" : "decline",
			content: allow ? {} : null,
			_meta: null,
		};
	}
}
