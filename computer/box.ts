// Runs a command somewhere other than this computer. By default that's a
// Docker container which keeps its state between calls and only sees the Lab
// folder, and with --ssh it's another machine.
//
//   box COMMAND...
//   box --image python:3.12 COMMAND...   Only counts when the container is created
//   box --stop                           Removes the container
//   box --ssh HOST COMMAND...
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { home } from "./config.ts";

const NAME = "the-lab-box";
const IMAGE = "ubuntu:24.04";

export interface Plan {
	bin: string;
	args: string[];
}

export function parsed(argv: string[]) {
	const rest = [...argv];
	let image = IMAGE;
	let ssh = "";
	for (;;) {
		if (rest[0] === "--image") {
			rest.shift();
			image = rest.shift() ?? IMAGE;
		} else if (rest[0] === "--ssh") {
			rest.shift();
			ssh = rest.shift() ?? "";
			if (!ssh) throw new Error("Say which machine, like box --ssh me@server uptime.");
		} else break;
	}
	return { image, ssh, stop: rest[0] === "--stop", command: rest.join(" ") };
}

export const creating = (image: string, folder: string): Plan => ({
	bin: "docker",
	args: [
		"run",
		"-d",
		"--name",
		NAME,
		"-v",
		`${folder}:/lab`,
		"-w",
		"/lab",
		image,
		"sleep",
		"infinity",
	],
});

export const inside = (command: string): Plan => ({
	bin: "docker",
	args: ["exec", "-w", "/lab", NAME, "sh", "-lc", command],
});

function run({ bin, args }: Plan, quiet = false) {
	const r = spawnSync(bin, args, {
		stdio: quiet ? "pipe" : "inherit",
		encoding: "utf8",
		windowsHide: true,
	});
	if (r.error) {
		const missing = (r.error as NodeJS.ErrnoException).code === "ENOENT";
		throw new Error(
			missing ? `${bin} isn't installed on this computer.` : r.error.message,
		);
	}
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function main(argv: string[]) {
	const { image, ssh, stop, command } = parsed(argv);
	if (stop) return run({ bin: "docker", args: ["rm", "-f", NAME] }).code;
	if (!command) throw new Error("Say what to run, like box python3 --version.");
	if (ssh) return run({ bin: "ssh", args: [ssh, command] }).code;
	const state = run(
		{ bin: "docker", args: ["inspect", "-f", "{{.State.Running}}", NAME] },
		true,
	);
	if (state.code !== 0) {
		const made = run(creating(image, home()), true);
		if (made.code !== 0)
			throw new Error(`Docker couldn't start the box: ${made.out.trim()}`);
	} else if (state.out.trim() !== "true") {
		run({ bin: "docker", args: ["start", NAME] }, true);
	}
	return run(inside(command)).code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		process.exitCode = main(process.argv.slice(2));
	} catch (e) {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exitCode = 1;
	}
}
