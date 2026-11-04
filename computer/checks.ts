// What setup and the phone's Check Setup button both need to know: whether
// the agent is signed in and whether Tailscale is up.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import process, { env } from "node:process";
import { codexBin } from "./codex.ts";

const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";

export const run = (
	cmd: string,
	a: string[],
	opts: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) => {
	const r = spawnSync(cmd, a, {
		encoding: "utf8",
		input: opts.input,
		env: opts.env ?? env,
		cwd: opts.cwd,
		shell: WIN && /\.(bat|cmd)$/i.test(cmd),
		timeout: 60_000,
	});
	return {
		ok: r.status === 0,
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim(),
		code: r.status,
	};
};

// The SDK runs its own copy of the agent, which keeps its own sign-in.
export function agentBin(): string {
	const req = createRequire(import.meta.url);
	const dir = dirname(
		req.resolve(
			`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
		),
	);
	return join(dir, WIN ? "claude.exe" : "claude");
}

export function claudeSignedIn(): {
	loggedIn: boolean;
	email?: string;
	authMethod?: string;
} {
	const r = run(agentBin(), ["auth", "status", "--json"]);
	try {
		return JSON.parse(r.out.slice(r.out.indexOf("{")));
	} catch {
		return { loggedIn: false };
	}
}

export const codexSignedIn = () =>
	run(process.execPath, [codexBin(), "login", "status"]).ok;

export function tailscaleBin(): string | null {
	const candidates = MAC
		? [
				"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
				"/opt/homebrew/bin/tailscale",
				"/usr/local/bin/tailscale",
			]
		: WIN
			? ["C:\\Program Files\\Tailscale\\tailscale.exe"]
			: ["/usr/bin/tailscale"];
	return (
		candidates.find((c) => existsSync(c)) ??
		(run("tailscale", ["version"]).ok ? "tailscale" : null)
	);
}

export function tailscaleState() {
	const bin = tailscaleBin();
	if (!bin) return { installed: false } as const;
	const r = run(bin, ["status", "--json"]);
	if (!r.ok) return { installed: true, running: false, detail: r.out } as const;
	const s = JSON.parse(r.out.slice(r.out.indexOf("{")));
	const dns = String(s.Self?.DNSName ?? "").replace(/\.$/, "");
	return {
		installed: true,
		running: s.BackendState === "Running",
		state: s.BackendState as string,
		dns,
		bin,
	} as const;
}
