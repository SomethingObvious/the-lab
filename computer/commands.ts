import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// The app's command menu lists these, then the skills, so it says the same as /help.
export const COMMANDS = [
	{ name: "new", about: "Starts a new conversation. Memory stays." },
	{
		name: "rename",
		arg: "NAME",
		about: "Names this conversation. On its own, it names itself again.",
	},
	{ name: "retry", about: "Sends your last message again." },
	{ name: "undo", about: "Tells it to ignore your last message and its answer." },
	{ name: "stop", about: "Stops what it's doing." },
	{ name: "compress", about: "Shrinks the conversation so far." },
	{ name: "status", about: "Shows the model, mode and what it's doing." },
	{ name: "usage", about: "Shows today's work." },
	{ name: "insights", arg: "DAYS", about: "Shows the work over the last few days." },
	{ name: "model", arg: "NAME", about: "Switches model." },
	{
		name: "personality",
		arg: "TEXT",
		about: "Sets how it talks, and on its own shows how it talks now.",
	},
	{ name: "skills", about: "Lists what it has written down. /NAME follows one." },
	{ name: "bots", about: "Lists your named bots. @NAME talks to one." },
	{ name: "help", about: "Lists these commands." },
];

export const HELP = COMMANDS.filter((c) => c.name !== "help")
	.map((c) => `- /${c.name}${c.arg ? ` ${c.arg}` : ""}: ${c.about}`)
	.join("\n");

const DAY = 86_400_000;

interface Logged {
	kind: string;
	at?: string;
	ok?: unknown;
	stopped?: unknown;
	ms?: unknown;
	tool?: unknown;
	auto?: unknown;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function insights(events: Logged[], days: number, now = Date.now()): string {
	const since = now - days * DAY;
	const recent = events.filter((e) => e.at && Date.parse(e.at) >= since);
	const asked = recent.filter((e) => e.kind === "you");
	const done = recent.filter((e) => e.kind === "done");
	const failed = done.filter((e) => e.ok === false && e.stopped !== true).length;
	const stopped = done.filter((e) => e.stopped === true).length;
	const seconds =
		done.reduce((sum, e) => sum + (typeof e.ms === "number" ? e.ms : 0), 0) / 1000;
	const tools = new Map<string, number>();
	for (const e of recent)
		if (e.kind === "step" && typeof e.tool === "string")
			tools.set(e.tool, (tools.get(e.tool) ?? 0) + 1);
	const top = [...tools]
		.toSorted((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([name, n]) => `${name} ${n}`);
	const steps = [...tools.values()].reduce((sum, n) => sum + n, 0);
	return [
		`${days === 1 ? "Today" : `The last ${days} days`}: ${plural(asked.length, "message")}, ${plural(steps, "step")}, ${Math.round(seconds / 60)} minutes of work.`,
		`${plural(failed, "task")} failed and ${stopped} stopped.`,
		...(top.length > 0 ? [`Most used: ${top.join(", ")}.`] : []),
	].join("\n\n");
}

const NAME = /^[\w-]{1,40}$/;

export function namesIn(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".md") && !f.endsWith(".notes.md"))
		.map((f) => f.slice(0, -3))
		.filter((n) => NAME.test(n));
}

export function botsIn(text: string, home: string): string[] {
	const named = [...text.matchAll(/(?:^|\s)@([\w-]{1,40})/g)].map((m) => m[1] ?? "");
	return [...new Set(named)].filter((n) => existsSync(join(home, "bots", `${n}.md`)));
}

export const botNote = (bots: string[]) =>
	`He's talking to ${bots.join(" and ")}. Read bots/NAME.md for each one and answer as that bot, starting its part with its name in bold. Each bot keeps its own notes in bots/NAME.notes.md. If a bot's file names a model and you can start a subagent on that model, give the bot's part to one. When a bot's answer @mentions another bot, that bot answers next, up to five turns in all.`;
