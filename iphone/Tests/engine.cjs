// A stand-in for the agent engine, for check.mjs. It answers every message with
// "All done.", and asks permission first if the message says "needs ok".
const rl = require("node:readline").createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const finish = (text) => {
	out({
		method: "item/completed",
		params: { item: { type: "agentMessage", id: "a1", text } },
	});
	out({
		method: "turn/completed",
		params: { turn: { id: "t1", status: "completed", durationMs: 1234, error: null } },
	});
};
rl.on("line", (line) => {
	const m = JSON.parse(line);
	if (m.method === "initialize") return out({ id: m.id, result: {} });
	if (m.method === "model/list")
		return out({
			id: m.id,
			result: {
				data: [{ model: "fake", isDefault: true, supportedReasoningEfforts: [] }],
			},
		});
	if (m.method === "account/read")
		return out({
			id: m.id,
			result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true },
		});
	if (m.method === "thread/start" || m.method === "thread/resume")
		return out({ id: m.id, result: { thread: { id: "thread-1" }, model: "fake" } });
	if (m.method === "turn/start") {
		out({ id: m.id, result: { turn: { id: "t1", status: "inProgress" } } });
		if (!JSON.stringify(m.params).includes("needs ok")) return finish("All done.");
		return out({
			id: 900,
			method: "item/commandExecution/requestApproval",
			params: {
				itemId: "c2",
				command: "/bin/zsh -lc 'brew uninstall ffmpeg'",
				reason: "Clearing out the old notes",
			},
		});
	}
	if (m.id === 900) finish(`Decision was ${m.result.decision}`);
});
