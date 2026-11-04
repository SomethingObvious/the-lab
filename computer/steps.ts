// Turns a tool call into the one-line title the phone shows, plus the raw
// detail it opens to.

// Files from his phone are stored as 8 hex characters, a dash and the real name.
const base = (p: unknown) => {
	const b =
		String(p ?? "")
			.split(/[\\/]/)
			.findLast(Boolean) ?? "";
	return /[\\/]\.thelab[\\/]files[\\/]/.test(String(p))
		? b.replace(/^[0-9a-f]{8}-/, "")
		: b;
};
const host = (u: unknown) => {
	try {
		return new URL(String(u)).host;
	} catch {
		return String(u ?? "");
	}
};
export const clip = (s: string, n: number) =>
	s.length > n ? `${s.slice(0, n - 1)}…` : s;

interface Input {
	command?: unknown;
	content?: unknown;
	description?: unknown;
	file_path?: unknown;
	new_string?: unknown;
	notebook_path?: unknown;
	old_string?: unknown;
	path?: unknown;
	pattern?: unknown;
	query?: unknown;
	skill?: unknown;
	todos?: unknown;
	url?: unknown;
	[k: string]: unknown;
}
interface Todo {
	status?: unknown;
	content?: unknown;
}

export function title(tool: string, input: Input): string {
	switch (tool) {
		case "Bash":
		case "PowerShell":
			return input.description
				? String(input.description)
				: clip(String(input.command ?? ""), 80);
		case "Read":
			return `Reading ${base(input.file_path)}`;
		case "Write":
			return `Writing ${base(input.file_path)}`;
		case "Edit":
		case "MultiEdit":
			return `Editing ${base(input.file_path)}`;
		case "NotebookEdit":
			return `Editing ${base(input.notebook_path)}`;
		case "Glob":
			return `Looking for ${String(input.pattern)}`;
		case "Grep":
			return `Searching files for "${clip(String(input.pattern ?? ""), 40)}"`;
		case "WebSearch":
			return `Searching the web for "${clip(String(input.query ?? ""), 60)}"`;
		case "WebFetch":
			return `Reading ${host(input.url)}`;
		case "Agent":
		case "Task":
			return `Handing off: ${String(input.description ?? "a side task")}`;
		case "TodoWrite":
		case "TaskCreate":
		case "TaskUpdate":
		case "TaskList":
			return "Updating the plan";
		case "ToolSearch":
			return "Finding the right tool";
		case "Skill":
			return `Using the ${String(input.skill ?? input.command ?? "")} skill`.replace(
				"  ",
				" ",
			);
		case "Monitor":
			return input.description ? String(input.description) : "Watching for a change";
		case "mcp__lab__send_to_phone":
			return `Sending ${base(input.path)} to your phone`;
	}
	const chrome = tool.match(/^mcp__claude-in-chrome__(.+)$/)?.[1];
	if (chrome) {
		if (chrome === "navigate" && input.url)
			return `Opening ${host(input.url)} in Chrome`;
		return `Chrome: ${chrome.replace(/_/g, " ")}`;
	}
	const [, server, name] = tool.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/) ?? [];
	// Claude's own connectors arrive as claude_ai_Google_Calendar and so on.
	if (server && name)
		return `${server.replace(/^claude_ai_/, "").replace(/_/g, " ")}: ${name.replace(/_/g, " ")}`;
	return tool;
}

export function detail(tool: string, input: Input): string {
	if (tool === "Bash" || tool === "PowerShell") return String(input.command ?? "");
	if (tool === "TodoWrite" && Array.isArray(input.todos)) {
		return input.todos
			.map(
				(t: Todo) => `${t.status === "completed" ? "[x]" : "[ ]"} ${String(t.content)}`,
			)
			.join("\n");
	}
	if (tool === "Write")
		return `${String(input.file_path)}\n\n${clip(String(input.content ?? ""), 2000)}`;
	if (tool === "Edit")
		return `${String(input.file_path)}\n\n- ${clip(String(input.old_string ?? ""), 900)}\n+ ${clip(String(input.new_string ?? ""), 900)}`;
	if (typeof input.file_path === "string" && Object.keys(input).length === 1)
		return input.file_path;
	if (typeof input.url === "string" && tool === "WebFetch") return input.url;
	return clip(JSON.stringify(input, null, 2), 4000);
}
