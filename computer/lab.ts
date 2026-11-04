import { randomUUID, type UUID } from "node:crypto";
import {
	closeSync,
	copyFileSync,
	existsSync,
	fdatasyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve, sep } from "node:path";
import process, { env } from "node:process";
import {
	createSdkMcpServer,
	tool as defineTool,
	type HookJSONOutput,
	type PermissionResult,
	type PostToolUseHookInput,
	type PreToolUseHookInput,
	type Query,
	query,
	type SDKAssistantMessage,
	type SDKAssistantMessageError,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { Codex } from "./codex.ts";
import { setting, WIN, words } from "./config.ts";
import { checkApp } from "./design.ts";
import { type Judgement, judge, needsOk, type Where } from "./guard.ts";
import { awake, type Mac, snapshot } from "./mac.ts";
import { CAP, diff, type Memory, parse, render, suspect } from "./memory.ts";
import { clip, detail, title } from "./steps.ts";

export interface Ev {
	id: number;
	at: string;
	kind: string;
	[k: string]: unknown;
}
type Listener = (e: Ev | Live) => void;
// Live events go to whoever is connected and are never stored or replayed.
// The phone keeps the newest of each kind and hands it to the page as it opens.
export type Live =
	| Mac
	| {
			kind: "status" | "design" | "shortcuts" | "settings" | "reach";
			[k: string]: unknown;
	  };
export interface Attached {
	name: string;
	url: string;
	size: number;
	type: string;
}

const KEEP = 5000;
// Kinds that notify on the phone, which skip the notification while he's
// using The Lab on the computer itself.
const LOUD = new Set(["reply", "file", "ask", "notice"]);
// Events whose words the server wrote, not the agent or him.
const OURS = new Set(["ask", "blocked", "notice"]);
const localize = <T extends Record<string, unknown>>(e: T): T =>
	Object.fromEntries(
		Object.entries(e).map(([k, v]) => [
			k,
			typeof v === "string" && ["text", "title", "plain", "label"].includes(k)
				? words(v)
				: k === "facts" && Array.isArray(v)
					? v.map((f) => words(String(f)))
					: k === "points" && Array.isArray(v)
						? v.map((p) => ({ ...p, text: words(String(p.text)) }))
						: v,
		]),
	) as T;

export class Store {
	events: Ev[] = [];
	private next = 1;
	private readonly fd: number;
	private readonly listeners = new Set<Listener>();
	// Whether he's at the computer with The Lab open, set by the server.
	atMac: () => boolean = () => false;

	constructor(file: string) {
		if (existsSync(file)) {
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			for (const line of lines) {
				try {
					this.events.push(JSON.parse(line));
				} catch {
					/* a torn last line from a power cut */
				}
			}
			// The file only ever grows, so it gets cut back to the window that is
			// served on start, which keeps it under a couple of MB.
			if (lines.length > KEEP * 2) {
				this.events = this.events.slice(-KEEP);
				writeFileSync(
					`${file}.tmp`,
					`${this.events.map((e) => JSON.stringify(e)).join("\n")}\n`,
				);
				renameSync(`${file}.tmp`, file);
			}
			this.events = this.events.slice(-KEEP);
			this.next = (this.events.at(-1)?.id ?? 0) + 1;
		}
		this.fd = openSync(file, "a");
	}

	add(raw: { kind: string; [k: string]: unknown }, durable = false): Ev {
		const e = WIN && OURS.has(raw.kind) ? localize(raw) : raw;
		const ev = {
			id: this.next++,
			at: new Date().toISOString(),
			...e,
			...(LOUD.has(e.kind) && this.atMac() ? { onMac: true } : {}),
		} as Ev;
		writeSync(this.fd, `${JSON.stringify(ev)}\n`);
		if (durable) fdatasyncSync(this.fd);
		this.events.push(ev);
		if (this.events.length > KEEP * 1.2) this.events = this.events.slice(-KEEP);
		for (const l of this.listeners) l(ev);
		return ev;
	}

	live(e: Live) {
		for (const l of this.listeners) l(e);
	}

	// With no cursor the phone gets the last 300 events, which covers a fresh
	// install without shipping months of history over the first connection.
	since(after: number | null): Ev[] {
		if (after === null) return this.events.slice(-300);
		return this.events.filter((e) => e.id > after);
	}

	listen(l: Listener) {
		this.listeners.add(l);
		return () => this.listeners.delete(l);
	}
	close() {
		closeSync(this.fd);
	}
}

export interface State {
	sessionId?: string | undefined;
	threadId?: string;
	open?: { text: string; at: string } | null;
	memoryPaused?: boolean;
	login?: string;
}

class Channel implements AsyncIterable<SDKUserMessage> {
	private readonly queue: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;
	private closed = false;
	push(m: SDKUserMessage) {
		this.queue.push(m);
		this.wake?.();
	}
	close() {
		this.closed = true;
		this.wake?.();
	}
	async *[Symbol.asyncIterator]() {
		while (!this.closed) {
			const m = this.queue.shift();
			if (m) {
				yield m;
				continue;
			}
			await new Promise<void>((r) => {
				this.wake = r;
			});
			this.wake = null;
		}
	}
}

const NOTICE: Partial<Record<SDKAssistantMessageError, string>> = {
	authentication_failed:
		"The Lab on the computer is signed out of Claude. Open the Claude app on the computer and ask it to sign The Lab back in, then send your message again.",
	billing_error:
		"The Claude plan on the computer has a billing problem. Check the account, then send your message again.",
	rate_limit:
		"The Claude plan hit its usage limit for now. It will carry on once the limit resets.",
	account_on_hold: "The Claude account on the computer is on hold.",
	verification_required:
		"The Claude account on the computer needs to be verified. Open Claude on the computer to finish it.",
};

// How long an Allow card waits. Long enough to find the phone, short enough
// that an Allow still means he remembers what it was for.
export const ASK_MS = 5 * 60_000;

// Who or what answered an Allow card.
type By = "phone" | "timeout" | "stop";

export const DENIED: Record<By, string> = {
	phone:
		"He said no from his phone. Do not try another way around it, ask him what he wants instead.",
	timeout:
		"Nobody answered within 5 minutes, so it was not allowed. Carry on with anything that does not need it, and say in your reply what is still waiting on him.",
	stop: "He stopped the task.",
};

// The first thing in a new conversation. `text` is for a design that only
// knows plain notices, and for the notification.
const WELCOME = {
	kind: "notice",
	first: true,
	title: "Before You Start",
	text: "The Lab works while your computer is awake, asks before it deletes, sends or installs anything, and puts what it deletes in the Trash.",
	points: [
		{
			icon: "bolt",
			text: "It works while your computer is awake. A closed lid or a flat battery pauses it.",
		},
		{
			icon: "shield",
			text: "It asks you here before it deletes, sends or installs anything.",
		},
		{
			icon: "trash",
			text: "What it deletes goes to the Trash, so you can get it back.",
		},
		{ icon: "check", text: "It can get things wrong, so check anything that matters." },
		{ icon: "redo", text: 'If a change to this app looks worse, say "undo".' },
	],
};

// Variables that look like credentials stay out of the agent's shell, as
// Hermes does. The engine's own sign-in is kept.
export const cleanEnv = (extra: Record<string, string> = {}) => ({
	...(Object.fromEntries(
		Object.entries(env).filter(
			([k, v]) =>
				v !== undefined &&
				(/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_|OPENAI_|CODEX_)/.test(k) ||
					!/KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION/i.test(k)),
		),
	) as Record<string, string>),
	...extra,
});

export interface LabOptions {
	home: string;
	dir: string;
	model?: string | undefined;
	engine?: "claude" | "codex";
	snapshots?: boolean;
}
export interface Card {
	title: string;
	detail: string;
	plain?: string;
	facts?: string[];
	why?: string;
	from?: string;
	always?: { command: string; cwd: string };
}
interface Rule {
	tool: string;
	command: string;
	cwd: string;
	plain: string;
	at: string;
}
// One replacement from an Edit or MultiEdit call.
interface Replace {
	old_string: string;
	new_string: string;
	replace_all?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null;
const isReplace = (e: unknown): e is Replace =>
	isRecord(e) &&
	typeof e["old_string"] === "string" &&
	typeof e["new_string"] === "string";
// The SDK takes a message id only in UUID form, which is what the phone and
// the scheduler send.
const isUuid = (s: string): s is UUID =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

const decide = (d: "allow" | "deny", reason?: string): HookJSONOutput => ({
	hookSpecificOutput: {
		hookEventName: "PreToolUse",
		permissionDecision: d,
		...(reason ? { permissionDecisionReason: reason } : {}),
	},
});

const toolError = (text: string) => ({
	content: [{ type: "text" as const, text }],
	isError: true,
});

export class Lab {
	store: Store;
	private q: Query | null = null;
	private input: Channel | null = null;
	state: State;
	private readonly opts: LabOptions;
	private codex: Codex | null = null;
	private readonly stateFile: string;
	private readonly filesDir: string;
	private readonly rulesFile: string;
	asks = new Map<string, (allow: boolean, by: By) => void>();
	private readonly cards = new Map<string, Card>();
	private readonly youIds = new Map<string, number>();
	private unanswered: SDKUserMessage[] = [];
	private readonly seen = new Set<string>();
	private stopping = false;
	private initSeen = false;
	// Steps whose refusal is already shown some other way, so the failed
	// result isn't drawn again.
	readonly hushed = new Set<string>();
	private readonly titles = new Map<string, string>();
	private release: (() => void) | undefined;
	// Where outside content got into this task, which labels any send after it.
	taint: string | null = null;
	private denials = 0;
	private lastSnap: { name: string; t: number } | null = null;
	private snapping: Promise<void> | null = null;
	private snapFailed = false;
	private memoryText = "";
	// Said to the agent at the top of its next message.
	private notes: string[] = [];
	// What the engine said it's running, which can differ from the one picked.
	modelInUse: string | null = null;
	rules: Rule[] = [];
	readonly where: Where;
	readonly trashCmd: string;
	readonly memoryFile: string;
	status: { working: boolean; label: string; since: string; mode?: string } = {
		working: false,
		label: "",
		since: new Date().toISOString(),
	};

	constructor(opts: LabOptions) {
		this.opts = opts;
		mkdirSync(opts.dir, { recursive: true });
		this.filesDir = join(opts.dir, "files");
		mkdirSync(this.filesDir, { recursive: true });
		this.stateFile = join(opts.dir, "state.json");
		this.rulesFile = join(opts.dir, "allowed.json");
		this.where = {
			user: homedir().replace(/\\/g, "/"),
			home: opts.home.replace(/\\/g, "/"),
			lab: opts.dir.replace(/\\/g, "/"),
		};
		// PowerShell would open a file with no extension instead of running it.
		this.trashCmd = join(opts.dir, "bin", WIN ? "trash.cmd" : "trash");
		this.memoryFile = join(opts.home, "memory.md");
		this.state = existsSync(this.stateFile)
			? JSON.parse(readFileSync(this.stateFile, "utf8"))
			: {};
		try {
			this.rules = JSON.parse(readFileSync(this.rulesFile, "utf8"));
		} catch {
			/* none yet */
		}
		const fresh = !existsSync(join(opts.dir, "events.jsonl"));
		this.store = new Store(join(opts.dir, "events.jsonl"));
		for (const e of this.store.events)
			if (e.kind === "you") this.seen.add(String(e["cid"]));
		if (fresh) this.store.add(WELCOME);

		if (this.state.open) {
			// Without a done the cut-off turn's approvals would stay live.
			this.store.add({ kind: "done", ok: false, stopped: false, ms: 0 });
			this.store.add({
				kind: "notice",
				text: `The server on the computer restarted partway through "${clip(this.state.open.text, 120)}". Nothing was redone.`,
				action: {
					label: "Carry On",
					send: "Carry on with what you were doing before the restart. Check what already got done first.",
				},
			});
			this.state.open = null;
			this.save();
		}
		this.watchMemory();
	}

	save() {
		writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.state));
		renameSync(`${this.stateFile}.tmp`, this.stateFile);
	}

	setStatus(working: boolean, label = "") {
		if (working === this.status.working && label === this.status.label) return;
		const since =
			working === this.status.working ? this.status.since : new Date().toISOString();
		this.status = { ...this.status, working, label, since };
		// A laptop on battery would otherwise doze off partway through a task.
		if (working && !this.release) this.release = awake();
		if (!working) {
			this.release?.();
			this.release = undefined;
		}
		this.store.live({ kind: "status", ...this.status });
	}

	// `scheduled` is the schedules.json entry that sent it.
	send(
		text: string,
		cid: string,
		files: Attached[] = [],
		scheduled?: { label: string; quiet?: boolean },
	): boolean {
		if (this.seen.has(cid)) return false;
		this.seen.add(cid);
		if (!this.status.working) {
			this.taint = null;
			this.denials = 0;
		}
		const you = this.store.add(
			{
				kind: "you",
				text,
				cid,
				...(files.length > 0 ? { files } : {}),
				...(scheduled ? { scheduled: scheduled.label } : {}),
			},
			true,
		);
		this.youIds.set(cid, you.id);
		this.state.open = {
			text: text || files.map((f) => f.name).join(", "),
			at: new Date().toISOString(),
		};
		this.save();
		this.snap();
		const list = files
			.map(
				(f) =>
					`- ${join(this.filesDir, basename(decodeURIComponent(f.url)))} (${f.name}, ${f.type})`,
			)
			.join("\n");
		let content =
			files.length > 0
				? `${text}\n\nHe attached ${files.length === 1 ? "a file" : `${files.length} files`} from his phone:\n${list}`.trim()
				: text;
		if (scheduled)
			content = `This is "${scheduled.label}", a scheduled message from schedules.json, not something he just typed. He may not be looking at the phone, so finish it and reply with the result.${scheduled.quiet ? " If there is nothing worth telling him, reply with exactly [SILENT] and he won't be notified." : ""}\n\n${content}`;
		const notes = [...this.notes, this.memoryNote()].filter(Boolean).join(" ");
		if (notes) content = `(${notes})\n\n${content}`;
		this.notes = [];
		this.setStatus(true, "Reading your message");
		if (this.opts.engine === "codex") {
			this.codex ??= new Codex(
				this,
				this.opts.home,
				PROMPT(this.trashCmd),
				this.opts.model,
			);
			this.codex.send(
				content,
				files
					.filter((f) => f.type.startsWith("image/"))
					.map((f) => join(this.filesDir, basename(decodeURIComponent(f.url)))),
				you.id,
			);
			return true;
		}
		const m: SDKUserMessage = {
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
			...(isUuid(cid) ? { uuid: cid } : {}),
			session_id: this.state.sessionId ?? "",
		};
		this.unanswered.push(m);
		this.ensureRunning().input.push(m);
		return true;
	}

	async stop() {
		if (this.codex) {
			if (!this.status.working) return;
			for (const finish of this.asks.values()) finish(false, "stop");
			return this.codex.stop();
		}
		if (!(this.q && this.status.working)) return;
		this.stopping = true;
		for (const finish of this.asks.values()) finish(false, "stop");
		await this.q.interrupt().catch(() => {
			// An interrupt that fails means the turn already ended.
		});
	}

	close() {
		this.release?.();
		this.codex?.close();
		this.q?.close();
		this.store.close();
	}

	// `always` keeps an exact command allowed in that folder from now on,
	// which only the app offers, never the notification.
	answer(ref: string, allow: boolean, always = false): boolean {
		const finish = this.asks.get(ref);
		if (!finish) return false;
		const card = this.cards.get(ref);
		const rule = card?.always;
		if (allow && always && card && rule) {
			this.rules = [
				...this.rules.filter(
					(r) => !(r.command === rule.command && r.cwd === rule.cwd),
				),
				{
					tool: WIN ? "PowerShell" : "Bash",
					...rule,
					plain: card.plain || card.title,
					at: new Date().toISOString(),
				},
			];
			this.saveRules();
		}
		finish(allow, "phone");
		return true;
	}

	saveRules() {
		writeFileSync(`${this.rulesFile}.tmp`, JSON.stringify(this.rules, null, 2));
		renameSync(`${this.rulesFile}.tmp`, this.rulesFile);
	}

	allowedBefore(command: string, cwd: string) {
		return this.rules.some((r) => r.command === command && r.cwd === cwd);
	}

	// ---------- the guard rails ----------

	// A Time Machine snapshot, at most every `fresh` ms, so there's always a
	// point to roll back to from shortly before anything risky.
	async snap(fresh = 15 * 60_000) {
		if (process.platform !== "darwin" || this.opts.snapshots === false) return;
		if (this.lastSnap && Date.now() - this.lastSnap.t < fresh) return;
		this.snapping ??= (async () => {
			try {
				let name: string;
				try {
					name = await snapshot();
				} catch (e) {
					const why = e instanceof Error ? e.message : String(e);
					console.error("snapshot:", why);
					if (this.snapFailed) return;
					this.snapFailed = true;
					this.store.add({
						kind: "notice",
						text: `The computer couldn't take a Time Machine snapshot (${clip(why, 120)}), so the only undo for now is the Trash. Turning on Time Machine in System Settings usually fixes it.`,
					});
					return;
				}
				this.lastSnap = { name, t: Date.now() };
				this.store.add({ kind: "snapshot", name });
			} finally {
				this.snapping = null;
			}
		})();
		await this.snapping;
	}

	get snapshotAt() {
		return this.lastSnap ? new Date(this.lastSnap.t).toISOString() : null;
	}

	// Builds the card the phone shows, from the call itself. What the agent
	// says about it goes in `why`, labelled as the agent's.
	card(
		tool: string,
		input: Record<string, unknown>,
		j: Judgement,
		why?: string,
		cwd?: string,
	): Card {
		const facts: string[] = [];
		if (j.undo === "trash") facts.push("You can get it back from the Trash.");
		else if (j.undo === "yes") facts.push("This can be undone.");
		else if (j.undo === "no") facts.push("This can't be undone.");
		if (j.leaves)
			facts.push(
				`This sends something off the computer${j.touches[0] ? `, to ${j.touches[0]}` : ""}.`,
			);
		else if (j.effect !== "send") facts.push("Nothing leaves the computer.");
		if (j.secret) facts.push("It reads a saved password or key.");
		if (j.unsure) facts.push("Exactly which files isn't known until it runs.");
		const plain = j.plain || title(tool, input);
		const command =
			tool === "Bash" || tool === "PowerShell" ? String(input["command"] ?? "") : "";
		const offer = Boolean(command) && !j.secret && !j.leaves && j.effect !== "send";
		return {
			title: `Allow: ${plain}?`,
			detail: detail(tool, input),
			plain,
			facts,
			...(why && why !== plain ? { why: clip(why, 200) } : {}),
			...(this.taint ? { from: `This came up after reading ${this.taint}.` } : {}),
			...(offer ? { always: { command, cwd: cwd ?? this.opts.home } } : {}),
		};
	}

	// Records a call the guard refused, and stops the task after three
	// refusals in a row rather than letting it keep trying.
	blocked(ref: string, tool: string, j: Judgement) {
		this.hushed.add(ref);
		this.store.add({
			kind: "blocked",
			ref,
			tool,
			title: j.plain || tool,
			text: j.block,
		});
		this.refused(j.plain || tool);
	}

	private refused(what: string) {
		if (++this.denials < 3) return;
		this.denials = 0;
		this.store.add({
			kind: "notice",
			text: `It stopped because it was turned down three times in a row. The last thing it wanted to do was: ${clip(what, 120)}. Tell it what you'd like instead.`,
		});
		setTimeout(() => this.stop(), 0);
	}

	// The one gate every Claude tool call passes through, whatever mode the
	// agent runs in, so the never-allow list and the Trash rule hold even
	// where its own permission checks would let a call straight through.
	private async gate(
		input: PreToolUseHookInput,
		signal: AbortSignal,
	): Promise<HookJSONOutput> {
		const tool = String(input.tool_name);
		const args = isRecord(input.tool_input) ? input.tool_input : {};
		const ref = String(input.tool_use_id ?? randomUUID());
		const w = { ...this.where, cwd: input.cwd };
		const j = judge(tool, args, w);
		if (j.source && !this.taint) this.taint = j.source;
		if (j.block) {
			this.blocked(ref, tool, j);
			return decide(
				"deny",
				`Not allowed: ${j.block} Don't look for another way to do it. Tell him what you were trying to do.`,
			);
		}
		if (j.rm) {
			this.hushed.add(ref);
			return decide(
				"deny",
				words(
					`On this computer files are deleted by moving them to the Trash, so he can get them back. Run ${this.trashCmd} with every path in one command instead. List what you'll delete first if it's more than a handful.`,
				),
			);
		}
		const mem = this.memoryGate(tool, args);
		if (mem) {
			this.hushed.add(ref);
			return decide("deny", mem);
		}
		if (
			(tool === "Bash" || tool === "PowerShell") &&
			this.allowedBefore(String(args["command"] ?? ""), String(input.cwd ?? ""))
		)
			return decide("allow");
		if (needsOk(j, w, Boolean(this.taint))) {
			if (j.effect === "delete" || j.effect === "system") await this.snap(60_000);
			const why = args["description"];
			const { allow, by } = await this.waitFor(
				ref,
				tool,
				this.card(tool, args, j, typeof why === "string" ? why : undefined, input.cwd),
				signal,
			);
			if (!allow) this.hushed.add(ref);
			return allow ? decide("allow") : decide("deny", DENIED[by]);
		}
		if (j.effect === "read" && !j.secret) return decide("allow");
		return {};
	}

	// An email's sender, once the agent has read it, so a card can say which
	// email a request came up in.
	// Adds to what the agent hears at the top of its next message.
	note(text: string) {
		if (!this.notes.includes(text)) this.notes.push(text);
	}

	// Takes back a note that stopped being true before he sent anything.
	unnote(start: string) {
		this.notes = this.notes.filter((n) => !n.startsWith(start));
	}

	private after(input: PostToolUseHookInput): HookJSONOutput {
		// A mistake in app/ is held back from the phone, and said straight away
		// so it gets fixed in the same turn.
		const file = String(
			(isRecord(input.tool_input) ? input.tool_input["file_path"] : undefined) ?? "",
		);
		const app = join(this.opts.home, "app");
		if (
			["Write", "Edit", "MultiEdit"].includes(input.tool_name) &&
			file &&
			resolve(file).startsWith(resolve(app) + sep)
		) {
			const problem = checkApp(app, resolve(file));
			if (problem)
				return {
					hookSpecificOutput: {
						hookEventName: "PostToolUse",
						additionalContext: `${problem} The phone stays on the last version that worked until this is fixed, so fix it now.`,
					},
				};
		}
		if (this.taint === "your email") {
			const text = JSON.stringify(input.tool_response ?? "").slice(0, 20_000);
			const from =
				/"?from"?\s*[:=]\s*\\?"?([^"\\,<]*<?[\w.+-]+@[\w-]+\.[\w.]+>?)/i.exec(text);
			const sender = from?.[1];
			if (sender !== undefined) this.taint = `an email from ${clip(sender.trim(), 80)}`;
		}
		return {};
	}

	// ---------- models ----------

	// What the engine's provider offers right now, whichever provider that is.
	async models(): Promise<{
		engine: string;
		chosen: string | null;
		inUse: string | null;
		choices: { id: string; name: string; description: string }[];
	}> {
		let choices: { id: string; name: string; description: string }[];
		if (this.opts.engine === "codex") {
			this.codex ??= new Codex(
				this,
				this.opts.home,
				PROMPT(this.trashCmd),
				this.opts.model,
			);
			choices = await this.codex.models();
		} else {
			const { q } = this.ensureRunning();
			const got = await Promise.race([
				q.supportedModels(),
				new Promise<never>((_, no) =>
					setTimeout(
						() => no(new Error("Claude didn't list its models within 20 seconds.")),
						20_000,
					),
				),
			]);
			choices = got.map((m) => ({
				id: m.value,
				name: m.displayName,
				description: m.description,
			}));
		}
		return {
			engine: this.opts.engine ?? "claude",
			chosen: this.opts.model ?? null,
			inUse: this.modelInUse,
			choices,
		};
	}

	// Takes effect from the next message. Undefined goes back to the default.
	setModel(model: string | undefined) {
		if (model === this.opts.model) return;
		this.opts.model = model;
		this.q?.setModel(model).catch((e) => console.error("setModel:", e));
		this.codex?.setModel(model);
	}

	// ---------- memory ----------

	private memoryGate(tool: string, args: Record<string, unknown>): string | null {
		if (
			!["Write", "Edit", "MultiEdit"].includes(tool) ||
			resolve(String(args["file_path"] ?? "")) !== resolve(this.memoryFile)
		)
			return null;
		if (this.state.memoryPaused)
			return "He has paused memory from his phone, so leave memory.md as it is.";
		let next = this.memoryText;
		if (tool === "Write") next = String(args["content"] ?? "");
		const list = args["edits"] ?? [];
		const edits: unknown[] =
			tool === "MultiEdit"
				? Array.isArray(list)
					? list
					: []
				: tool === "Edit"
					? [args]
					: [];
		for (const e of edits.filter(isReplace)) {
			next = e.replace_all
				? next.split(e.old_string).join(e.new_string)
				: next.replace(e.old_string, e.new_string);
		}
		if (next.length > CAP)
			return `memory.md would be ${next.length} characters and the cap is ${CAP}. Merge or drop older lines first, then try again. It holds:\n\n${this.memoryText}`;
		return null;
	}

	memoryNote(): string {
		const n = this.memoryText.length;
		return n > CAP * 0.8
			? `memory.md is at ${n} of ${CAP} characters, so merge or drop lines before adding more.`
			: "";
	}

	memory() {
		return {
			...parse(this.memoryText),
			chars: this.memoryText.length,
			cap: CAP,
			paused: Boolean(this.state.memoryPaused),
		};
	}

	// A change made on the phone, which is his and so isn't checked.
	saveMemory(m: Partial<Memory> & { paused?: boolean }) {
		if (m.paused !== undefined) {
			this.state.memoryPaused = m.paused;
			this.save();
		}
		if (m.about || m.notes) {
			const cur = parse(this.memoryText);
			this.writeMemory(
				render({ about: m.about ?? cur.about, notes: m.notes ?? cur.notes }),
			);
		}
		return this.memory();
	}

	private writeMemory(text: string) {
		this.memoryText = text;
		writeFileSync(`${this.memoryFile}.tmp`, text);
		renameSync(`${this.memoryFile}.tmp`, this.memoryFile);
	}

	// Every change the agent makes to memory.md shows on the phone as a line in
	// the conversation. One made while memory is paused, one over the cap, or
	// a line that reads like something planted while it was reading outside
	// content, is put back.
	private memoryChanged() {
		let text: string;
		try {
			text = readFileSync(this.memoryFile, "utf8");
		} catch {
			return;
		}
		if (text === this.memoryText) return;
		const before = parse(this.memoryText);
		const after = parse(text);
		const { added, removed } = diff(before, after);
		const planted = added
			.map((l) => ({ l, why: suspect(l) }))
			.filter((x) => x.why && (this.taint || /hidden|password/.test(x.why)));
		const undo = (note: string, phone: string) => {
			this.writeMemory(this.memoryText);
			this.note(note);
			this.store.add({ kind: "notice", text: phone });
		};
		if (this.state.memoryPaused)
			return undo(
				"Your last change to memory.md was undone because he has paused memory.",
				"Memory is paused, so a change the agent made to it was undone.",
			);
		if (text.length > CAP)
			return undo(
				`Your last change to memory.md was undone because it went over the ${CAP} character cap. Merge or drop older lines first.`,
				`A change to memory was undone because it went over the ${CAP} character cap.`,
			);
		const [first] = planted;
		if (first) {
			const keep = render({
				about: after.about.filter((l) => !planted.some((p) => p.l === l)),
				notes: after.notes.filter((l) => !planted.some((p) => p.l === l)),
			});
			this.writeMemory(keep);
			this.note(
				"A line you added to memory.md was taken out because it read like an instruction from something you read rather than from him.",
			);
			this.store.add({
				kind: "notice",
				text: `Something tried to add this to memory, and it was taken out because ${first.why}: "${clip(first.l, 160)}"`,
				action: {
					label: "Keep It Anyway",
					send: `Add this to memory.md, it's from me: ${first.l}`,
				},
			});
			return;
		}
		this.memoryText = text;
		if (added.length > 0 || removed.length > 0)
			this.store.add({
				kind: "memory",
				added: added.map((l) => clip(l, 200)),
				removed: removed.map((l) => clip(l, 200)),
			});
	}

	private watchMemory() {
		try {
			this.memoryText = readFileSync(this.memoryFile, "utf8");
		} catch {
			// Not made yet.
		}
		let settle: NodeJS.Timeout | undefined;
		try {
			watch(this.opts.home, { persistent: false }, (_, name) => {
				if (name !== "memory.md") return;
				clearTimeout(settle);
				settle = setTimeout(() => this.memoryChanged(), 300);
			});
		} catch {
			/* no folder yet, as in tests */
		}
	}

	// ---------- Claude ----------

	private ensureRunning(): { q: Query; input: Channel } {
		if (this.q) {
			if (!this.input)
				throw new Error("The agent is running with nothing to read from.");
			return { q: this.q, input: this.input };
		}
		const channel = new Channel();
		this.input = channel;
		this.initSeen = false;
		const lab = createSdkMcpServer({
			name: "lab",
			version: "1.0.0",
			tools: [
				defineTool(
					"send_to_phone",
					"Send a file from this computer to the owner's phone, where it shows in the conversation. Images show inline, other files open in the phone's viewer. Max 100 MB.",
					{
						path: z.string().describe("Absolute path of the file"),
						caption: z.string().optional().describe("One line shown under the file"),
					},
					async ({ path, caption }) => this.sendFile(path, caption),
				),
			],
		});
		const q = query({
			prompt: channel,
			options: {
				// Only his Lab folder is the agent's own. Changes anywhere else go
				// through its permission checks, and deletes, sends and installs
				// through the gate below.
				cwd: this.opts.home,
				permissionMode: "auto",
				...(this.state.sessionId === undefined ? {} : { resume: this.state.sessionId }),
				...(this.opts.model === undefined ? {} : { model: this.opts.model }),
				mcpServers: { lab },
				env: cleanEnv({
					PATH: `${join(this.opts.dir, "bin")}${delimiter}${setting("PATH") ?? ""}`,
				}),
				// The phone has no surface for multiple-choice prompts or plan
				// approval, so the agent asks in plain text instead.
				disallowedTools: ["AskUserQuestion", "EnterPlanMode", "ExitPlanMode"],
				settingSources: ["user", "project", "local"],
				systemPrompt: {
					type: "preset",
					preset: "claude_code",
					append: PROMPT(this.trashCmd),
				},
				canUseTool: (name, input, o) => this.ask(name, input, o),
				// Waiting on his Allow happens inside the hook, so it gets the same
				// time as the card.
				hooks: {
					PreToolUse: [
						{
							hooks: [
								async (hook, _id, o) =>
									hook.hook_event_name === "PreToolUse"
										? this.gate(hook, o.signal)
										: {},
							],
							timeout: ASK_MS / 1000 + 60,
						},
					],
					PostToolUse: [
						{
							hooks: [
								async (hook) =>
									hook.hook_event_name === "PostToolUse" ? this.after(hook) : {},
							],
						},
					],
				},
				stderr: (d) => process.stderr.write(d),
			},
		});
		this.q = q;
		this.pump(q);
		return { q, input: channel };
	}

	private async pump(q: Query) {
		let failure = "";
		try {
			for await (const m of q) this.handle(m);
		} catch (e) {
			failure = e instanceof Error ? e.message : String(e);
			console.error("agent stopped:", failure);
		}
		if (this.q !== q) return;
		this.q = null;
		this.input?.close();
		this.input = null;
		for (const finish of this.asks.values()) finish(false, "stop");

		// A resume that never got as far as init means the saved conversation
		// is gone (deleted, or from another machine), so start a fresh one with
		// whatever was waiting. With nothing sent (only the model list was asked
		// for) init never comes anyway, so that says nothing about the session.
		if (!this.initSeen && this.state.sessionId && this.unanswered.length > 0) {
			this.state.sessionId = undefined;
			this.save();
			this.store.add({
				kind: "notice",
				text: "The last conversation could not be reopened, so this is a fresh one.",
			});
			const waiting = this.unanswered;
			this.unanswered = [];
			if (waiting.length > 0) {
				const { input } = this.ensureRunning();
				for (const m of waiting) {
					this.unanswered.push(m);
					input.push(m);
				}
				return;
			}
		}
		if (this.status.working) {
			this.store.add({
				kind: "notice",
				text: `The agent stopped partway through${failure ? ` (${clip(failure, 160)})` : ""}. Send your message again, or ask it to carry on.`,
			});
			this.state.open = null;
			this.save();
		}
		this.setStatus(false);
	}

	// A reply of just [SILENT] to a scheduled check means there was nothing to
	// report, so it's kept quiet on the phone.
	reply(text: string) {
		if (text.trim() === "[SILENT]")
			this.store.add({ kind: "reply", text: "Nothing to report.", silent: true });
		else this.store.add({ kind: "reply", text });
	}

	step(
		ref: string,
		tool: string,
		input: Record<string, unknown>,
		t: string,
		more: string,
		sub = false,
	) {
		const j = judge(tool, input, this.where);
		if (j.source && !this.taint) this.taint = j.source;
		this.store.add({
			kind: "step",
			ref,
			tool,
			title: t,
			detail: more,
			effect: j.effect,
			...(sub ? { sub: true } : {}),
		});
		this.titles.set(ref, t);
		this.setStatus(true, t);
	}

	failed(ref: string, text: string) {
		if (this.hushed.delete(ref)) return;
		// Auto mode's own check turns some calls down without asking the phone,
		// and its message is written for the agent, not for him.
		const what = this.titles.get(ref) ?? "that step";
		if (/denied by the Claude Code auto mode classifier/.test(text)) {
			this.store.add({
				kind: "blocked",
				ref,
				tool: "",
				title: what,
				text: "The computer's own safety check stopped this. If you meant it, say so and it will try again.",
			});
			return this.refused(what);
		}
		if (text.startsWith("Auto mode could not evaluate this action")) {
			return void this.store.add({
				kind: "blocked",
				ref,
				tool: "",
				title: what,
				label: "Held back",
				text: "The computer's safety check couldn't run just then. It usually works again in a minute.",
			});
		}
		this.store.add({ kind: "failed", ref, text });
	}

	private handle(m: SDKMessage) {
		switch (m.type) {
			case "system":
				if (m.subtype === "init") {
					this.initSeen = true;
					this.state.sessionId = m.session_id;
					this.save();
					this.status.mode = m.permissionMode;
					this.modelInUse = m.model;
					process.stdout.write(
						`session ${m.session_id} model=${m.model} mode=${m.permissionMode}\n`,
					);
				} else if (m.subtype === "api_retry") {
					this.setStatus(
						true,
						`Waiting on the API (try ${m.attempt} of ${m.max_retries})`,
					);
				} else if (m.subtype === "status" && m.status === "compacting") {
					this.setStatus(true, "Compacting the conversation");
				}
				return;
			case "assistant":
				return this.assistant(m);
			case "user":
				return this.toolResults(m);
			case "auth_status":
				if (m.error)
					this.store.add({ kind: "notice", text: NOTICE.authentication_failed });
				return;
			case "result":
				return this.result(m);
		}
	}

	private assistant(m: SDKAssistantMessage) {
		const sub = m.parent_tool_use_id !== null;
		const notice = m.error && NOTICE[m.error];
		if (notice) {
			this.store.add({ kind: "notice", text: notice });
			return;
		}
		for (const b of m.message.content) {
			if (b.type === "text" && !sub && b.text.trim()) {
				this.reply(b.text);
			} else if (b.type === "tool_use") {
				const input = isRecord(b.input) ? b.input : {};
				this.step(
					b.id,
					b.name,
					input,
					title(b.name, input),
					detail(b.name, input),
					sub,
				);
			} else if (b.type === "thinking" && !sub) {
				this.setStatus(true, "Thinking");
			}
		}
	}

	private toolResults(m: SDKUserMessage) {
		const content = m.message.content;
		// A stop rejects the running step, which isn't a failure worth showing.
		if (!Array.isArray(content) || this.stopping) return;
		for (const b of content) {
			if (b.type === "tool_result" && b.is_error) {
				const text =
					typeof b.content === "string"
						? b.content
						: (b.content ?? []).map((c) => ("text" in c ? c.text : "")).join("\n");
				this.failed(b.tool_use_id, clip(text.replace(/<\/?tool_use_error>/g, ""), 600));
			}
		}
	}

	private result(m: SDKResultMessage) {
		const stopped = this.stopping;
		this.stopping = false;
		this.unanswered = [];
		const ok = m.subtype === "success" && !m.is_error;
		// The messages this result answered, so a message still waiting
		// behind it doesn't get this done too.
		const ids = (m.user_message_uuids ?? []).map((c) => this.youIds.get(c) ?? 0);
		const upto = ids.length > 0 ? Math.max(...ids) : 0;
		for (const c of m.user_message_uuids ?? []) this.youIds.delete(c);
		this.store.add({
			kind: "done",
			ok,
			stopped,
			ms: m.duration_ms,
			...(upto ? { upto } : {}),
			...(ok || stopped
				? {}
				: {
						error: clip(("errors" in m ? m.errors : []).join("; ") || m.subtype, 300),
					}),
		});
		this.state.open = null;
		this.save();
		this.hushed.clear();
		this.titles.clear();
		this.setStatus(false);
	}

	// What the agent's own permission checks hand over. The gate has already
	// turned down anything on the never-allow list.
	private async ask(
		name: string,
		input: Record<string, unknown>,
		o: { signal: AbortSignal; toolUseID: string; title?: string; description?: string },
	): Promise<PermissionResult> {
		if (name === "mcp__lab__send_to_phone")
			return { behavior: "allow", updatedInput: input };
		const j = judge(name, input, this.where);
		if (j.block) {
			this.blocked(o.toolUseID, name, j);
			return { behavior: "deny", message: `Not allowed: ${j.block}` };
		}
		const { allow, by } = await this.waitFor(
			o.toolUseID,
			name,
			this.card(name, input, j, o.description ?? o.title),
			o.signal,
		);
		if (!allow) this.hushed.add(o.toolUseID);
		return allow
			? { behavior: "allow", updatedInput: input }
			: { behavior: "deny", message: DENIED[by] };
	}

	// Puts an Allow and Deny on the phone and resolves with his answer, or a
	// no after five minutes or a stop.
	waitFor(
		ref: string,
		tool: string,
		card: Card,
		signal?: AbortSignal,
	): Promise<{ allow: boolean; by: By }> {
		this.cards.set(ref, card);
		const { always, ...shown } = card;
		this.store.add(
			{
				kind: "ask",
				ref,
				tool,
				...shown,
				...(always ? { always: true } : {}),
				...(this.snapshotAt ? { snapshot: this.snapshotAt } : {}),
			},
			true,
		);
		const was = this.status.label;
		this.setStatus(true, "Waiting for you");
		return new Promise((done) => {
			const timer = setTimeout(() => finish(false, "timeout"), ASK_MS);
			const finish = (allow: boolean, by: By) => {
				if (!this.asks.delete(ref)) return;
				clearTimeout(timer);
				this.cards.delete(ref);
				this.store.add({ kind: "answered", ref, allow, by });
				if (allow) this.denials = 0;
				else if (by !== "stop") this.refused(card.plain || card.title);
				if (this.status.working)
					this.setStatus(true, allow ? was : "Carrying on without it");
				done({ allow, by });
			};
			this.asks.set(ref, finish);
			signal?.addEventListener("abort", () => finish(false, "stop"), { once: true });
		});
	}

	sendFile(path: string, caption?: string) {
		const src = resolve(path);
		if (!(existsSync(src) && statSync(src).isFile()))
			return toolError(`There is no file at ${src}.`);
		const size = statSync(src).size;
		if (size > 100 * 1024 * 1024)
			return toolError(
				`${src} is ${Math.round(size / 1_048_576)} MB and the limit is 100 MB.`,
			);
		const name = `${randomUUID().slice(0, 8)}-${basename(src).replace(/[^\w.\- ]+/g, "_")}`;
		copyFileSync(src, join(this.filesDir, name));
		this.store.add({
			kind: "file",
			name: basename(src),
			url: `/files/${encodeURIComponent(name)}`,
			size,
			...(caption ? { caption } : {}),
		});
		return {
			content: [{ type: "text" as const, text: `Sent ${basename(src)} to his phone.` }],
		};
	}

	// A file from his phone, saved next to the ones the agent sends him so the
	// phone can show both the same way.
	async upload(
		name: string,
		type: string,
		body: AsyncIterable<Buffer>,
	): Promise<Attached> {
		const clean =
			basename(name)
				.replace(/[^\w.\- ]+/g, "_")
				.slice(-120) || "file";
		const stored = `${randomUUID().slice(0, 8)}-${clean}`;
		const out = join(this.filesDir, stored);
		let size = 0;
		const fd = openSync(`${out}.part`, "w");
		try {
			for await (const chunk of body) {
				size += chunk.length;
				if (size > 100 * 1024 * 1024)
					throw new Error(`${clean} is over the 100 MB limit.`);
				writeSync(fd, chunk);
			}
		} catch (e) {
			closeSync(fd);
			rmSync(`${out}.part`, { force: true });
			throw e;
		}
		closeSync(fd);
		renameSync(`${out}.part`, out);
		return { name: clean, url: `/files/${encodeURIComponent(stored)}`, size, type };
	}

	// Checks attachments named in a /send against what was actually uploaded.
	attached(files: unknown): Attached[] {
		if (!Array.isArray(files) || files.length > 20)
			throw new Error("A message can carry up to 20 files.");
		return files.map((f: unknown) => {
			const file = isRecord(f) ? f : {};
			const url = file["url"];
			const p =
				typeof url === "string" && url.startsWith("/files/")
					? this.fileFor(decodeURIComponent(url.slice(7)))
					: null;
			if (!p)
				throw new Error(
					`${JSON.stringify(url)} isn't a file uploaded to this computer.`,
				);
			return {
				name: clip(String(file["name"] ?? basename(p)), 120),
				url: String(url),
				size: statSync(p).size,
				type: clip(String(file["type"] ?? "application/octet-stream"), 100),
			};
		});
	}

	fileFor(name: string): string | null {
		const p = join(this.filesDir, basename(name));
		return existsSync(p) ? p : null;
	}
}

const PROMPT = (trash: string) =>
	words(
		`You are talking to the owner of this computer through The Lab, an app on his phone. He reads your replies on the phone, often away from the computer, so lead with the answer and keep formatting light. Your steps show up on his phone live, so you don't need to narrate them. Send him a file when he asks for one, or for a screenshot or anything easier to look at than describe, the way CLAUDE.md in the working directory says. Read CLAUDE.md before changing the app. Delete files with ${trash} PATH..., which moves them to the Trash, never with rm. Write web addresses out in full rather than hiding them behind link text.`,
	);
