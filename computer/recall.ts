// Searches every past conversation, which the agent otherwise can't see once
// its session has moved on.
//
//   recall WORD [WORD...]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { labDir } from "./config.ts";

const SHOWN = 20;
const CLIP = 400;

export function recalled(lines: string[], words: string[]): string[] {
	const wanted = words.map((w) => w.toLowerCase());
	const hits = lines.flatMap((line) => {
		try {
			const e = JSON.parse(line) as { kind?: string; text?: unknown; at?: string };
			if ((e.kind !== "you" && e.kind !== "reply") || typeof e.text !== "string")
				return [];
			const lower = e.text.toLowerCase();
			if (!wanted.every((w) => lower.includes(w))) return [];
			const who = e.kind === "you" ? "He said" : "You said";
			return [`${(e.at ?? "").slice(0, 16)} ${who}: ${e.text.slice(0, CLIP)}`];
		} catch {
			return [];
		}
	});
	return hits.slice(-SHOWN);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const words = process.argv.slice(2);
	if (words.length === 0) {
		process.stderr.write("Say what to look for, like recall tax return.\n");
		process.exitCode = 1;
	} else {
		const lines = readFileSync(join(labDir(), "events.jsonl"), "utf8").split("\n");
		const hits = recalled(lines, words);
		process.stdout.write(
			`${hits.join("\n\n") || "Nothing in past conversations matches that."}\n`,
		);
	}
}
