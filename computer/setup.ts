// Setup steps for the agent on the owner's computer. SETUP.md says when to run
// each one. Every step can be run again safely.
//
//   node setup.ts check        what is done and what is left, as JSON
//   node setup.ts auth         sign the agent in with the owner's plan, if it isn't
//                              (--engine claude|codex picks which one runs his messages)
//   node setup.ts computer     workspace, server, start at login
//   node setup.ts workspace    copy the template into the workspace, without touching login items
//   node setup.ts selftest     send a real message through the server and wait for the reply
//   node setup.ts relay        put up the relay on Cloudflare, or --url to use one that's already up
//   node setup.ts tailscale    HTTPS address for the phone through tailscale serve, if he has Tailscale
//   node setup.ts phone        build the app, install it over USB and pair it
//   node setup.ts apk          build the app for phones set up from here to update themselves (the server runs it)
//   node setup.ts iphone       on a Mac with Xcode, build the iPhone app and install it (--team TEAMID)
//   node setup.ts pair         open a QR code on the computer that pairs the phone again
//                              (--reset unpairs every phone first, for a lost phone or a code someone else saw)
//   node setup.ts stop         stop the server, before an update replaces the source
//   node setup.ts remove       stop the server and take it out of the sign-in items
//   node setup.ts bundle      build the app as an .aab for Play Console internal testing
//   node setup.ts desktop      build The Lab's window for this computer and add it to the Start menu or Applications
//   node setup.ts lint         run the lint rules, type check and tests after a change to The Lab's code
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	cpSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import {
	agentBin,
	codexSignedIn,
	run,
	claudeSignedIn as signedIn,
	tailscaleState,
} from "./checks.ts";
import { codexBin } from "./codex.ts";
import { agentAppName, config, home, labDir, setConfig, setting } from "./config.ts";
import { verify } from "./report.ts";
import { launchers } from "./trash.ts";
import { keys, lanAddresses, relayProblem, specOf } from "./tunnel.ts";
import {
	batch,
	fitTemplate,
	fitted,
	linkAgents,
	TAR,
	treeHash,
	windowHash,
} from "./update.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);
const HOME = home();
const LAB = labDir();
const TOOLS = join(LAB, "tools");
const PKG = "com.somethingobvious.thelab";
const LABEL = "com.somethingobvious.thelab";
const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WATCHDOG = "The Lab Watchdog";
const args = process.argv.slice(3);
const flag = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};

const say = (s: string) => console.log(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Opens a web page or a settings screen on this computer for him.
function show(link: string) {
	if (MAC) run("open", [link]);
	else if (WIN) run("explorer.exe", [link]);
	else say(`Open this on the computer: ${link}`);
}
function fail(s: string): never {
	console.error(s);
	process.exit(1);
}
if (Number(process.versions.node.split(".")[0]) < 24)
	fail(
		`The Lab needs Node 24 or later, and this is ${process.version}. Step 1 of SETUP.md installs it.`,
	);
// npm and npx sit next to this node, and the shell running setup may not
// have them on its PATH yet (winget doesn't update a shell that's already open).
process.env["PATH"] =
	`${dirname(process.execPath)}${delimiter}${process.env["PATH"] ?? ""}`;
// The running server only reads its config and code when it starts.
async function restart() {
	const { port, token } = config();
	if (!(await health())) return;
	await fetch(`http://127.0.0.1:${port}/restart`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}` },
	}).catch(() => {
		// It can exit before the answer gets back, and health() below is the real check.
	});
	await new Promise((r) => setTimeout(r, 1500));
	if (!(await health(30_000)))
		fail(
			`The server didn't come back within 30 seconds. Its log is ${join(LAB, "server.log")}.`,
		);
}

async function health(timeoutMs = 0): Promise<boolean> {
	const { port } = config();
	const until = Date.now() + timeoutMs;
	do {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return true;
		} catch {
			/* not up yet */
		}
		if (timeoutMs) await new Promise((r) => setTimeout(r, 1000));
	} while (Date.now() < until);
	return false;
}

// ---------- auth ----------

// Which agent runs his messages. The agent doing setup passes its own name,
// and the choice is kept in the server's config from then on.
function engine(): "claude" | "codex" {
	const want = flag("engine");
	const c = config();
	if (!want) return c.engine ?? "claude";
	if (want !== "claude" && want !== "codex")
		fail(`--engine has to be claude or codex, not ${want}.`);
	if (c.engine !== want) setConfig({ engine: want });
	return want;
}

function auth() {
	if (engine() === "codex") {
		if (!codexSignedIn()) {
			say(
				"Opening the ChatGPT sign-in page in the browser. Sign in with the account that has the paid plan, then come back here.",
			);
			spawnSync(process.execPath, [codexBin(), "login"], { stdio: "inherit" });
		}
		if (!codexSignedIn())
			fail("Still not signed in. Run `node setup.ts auth --engine codex` again.");
		say(
			run(process.execPath, [codexBin(), "login", "status"]).out.split("\n").pop() ??
				"Signed in.",
		);
		return;
	}
	let s = signedIn();
	if (!s.loggedIn) {
		say(
			"Opening the sign-in page in the browser. Sign in with the account that has the paid plan, then come back here.",
		);
		spawnSync(agentBin(), ["auth", "login"], { stdio: "inherit" });
		s = signedIn();
	}
	if (!s.loggedIn) fail("Still not signed in. Run `node setup.ts auth` again.");
	if (s.authMethod !== "claude.ai")
		say(
			`Signed in with ${s.authMethod}, not a plan sign-in, so usage is billed to that account's API credit.`,
		);
	say(`Signed in as ${s.email ?? "unknown"}.`);
}

// The data lines of a server-sent event stream, parsed as they arrive.
async function* sse(body: ReadableStream<Uint8Array>) {
	const dec = new TextDecoder();
	let buf = "";
	for await (const chunk of body) {
		buf += dec.decode(chunk, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines)
			if (line.startsWith("data: ")) yield JSON.parse(line.slice(6));
	}
}

async function selftest() {
	const { port, token } = config();
	if (!(await health()))
		fail("The server is not running. Run `node setup.ts computer` first.");
	const cid = crypto.randomUUID();
	const res = await fetch(`http://127.0.0.1:${port}/events`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (!res.body) fail("The server answered without a stream of events.");
	await fetch(`http://127.0.0.1:${port}/send`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({
			text: "This is a setup check from The Lab. Reply with exactly: lab ok",
			cid,
		}),
	});
	const until = Date.now() + 180_000;
	let reply = "";
	// The stream starts with the whole history, so only what follows the test
	// message counts.
	let mine = false;
	for await (const e of sse(res.body)) {
		if (Date.now() > until) break;
		if (e.kind === "you" && e.cid === cid) mine = true;
		if (!mine) continue;
		if (e.kind === "reply") reply = e.text;
		if (e.kind === "notice") fail(`The agent couldn't run: ${e.text}`);
		if (e.kind === "done") {
			if (!e.ok) fail(`The test message failed: ${e.error ?? "no reason given"}`);
			say(`Round trip works. The agent replied: ${reply}`);
			return;
		}
	}
	fail(`No reply within 3 minutes. Check the server log at ${join(LAB, "server.log")}`);
}

// ---------- computer ----------

function workspace() {
	mkdirSync(HOME, { recursive: true });
	const template = join(HERE, "template");
	const fresh = join(LAB, "update", "fitted");
	fitTemplate(template, fresh);
	// His app folder and notes are his after the first copy, so they're never
	// overwritten here. Updates merge into them instead.
	for (const name of readdirSync(template)) {
		const dest = join(HOME, name);
		if (name === "skill" || existsSync(dest)) continue;
		if (existsSync(join(fresh, name)))
			cpSync(join(fresh, name), dest, { recursive: true });
		else writeFileSync(dest, fitted(name, readFileSync(join(template, name))));
	}
	// Claude finds project skills in .claude/skills and Codex in .agents/skills.
	// Copied one by one, since .claude may already be there for other reasons.
	for (const where of [".claude", ".agents"])
		for (const name of readdirSync(join(fresh, where, "skills"))) {
			const dest = join(HOME, where, "skills", name);
			if (!existsSync(dest))
				cpSync(join(fresh, where, "skills", name), dest, { recursive: true });
		}
	// What his folder was copied from, for updates to merge over.
	const base = join(LAB, "home-base");
	if (existsSync(base)) rmSync(fresh, { recursive: true, force: true });
	else renameSync(fresh, base);
	linkAgents(HOME);
	config();
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

// macOS names a bare binary "node" in its prompts, in Login Items and in Full
// Disk Access. So the server runs from a small app called The Lab, holding the
// official Node build, which needs no other files. Its local signature gives
// macOS a stable name for the permissions he grants.
async function macApp(): Promise<string> {
	const node = join(TOOLS, "node", "bin", "node");
	if (!existsSync(node)) {
		say("Downloading Node for The Lab (about 50 MB)");
		const base = "https://nodejs.org/dist/latest-v24.x/";
		const want = `darwin-${process.arch === "arm64" ? "arm64" : "x64"}.tar.gz`;
		const sums = await (await fetch(`${base}SHASUMS256.txt`)).text();
		const file =
			/\S+$/.exec(sums.split("\n").find((l) => l.endsWith(want)) ?? "")?.[0] ??
			fail(`Node's download list has no ${want}.`);
		await download(base + file, join(TOOLS, file));
		extract(join(TOOLS, file), TOOLS);
		rmSync(join(TOOLS, "node"), { force: true });
		symlinkSync(join(TOOLS, file.replace(/\.tar\.gz$/, "")), join(TOOLS, "node"));
	}
	const app = agentApp();
	const exe = join(app, "Contents", "MacOS", "TheLab");
	// Kept outside the bundle, since a file the signature doesn't cover would break it.
	const from = join(LAB, "app-node");
	const source = realpathSync(node);
	const icon = join(app, "Contents", "Resources", "TheLab.icns");
	if (
		existsSync(exe) &&
		existsSync(from) &&
		readFileSync(from, "utf8") === source &&
		existsSync(icon) &&
		readFileSync(icon).equals(readFileSync(join(HERE, "TheLab.icns")))
	)
		return exe;
	// macOS ties his permissions to the signed app, so rebuilding it asks for them again.
	rmSync(app, { recursive: true, force: true });
	mkdirSync(dirname(icon), { recursive: true });
	cpSync(join(HERE, "TheLab.icns"), icon);
	mkdirSync(dirname(exe), { recursive: true });
	cpSync(source, exe);
	writeFileSync(
		join(app, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>TheLab</string>
  <key>CFBundleIconFile</key><string>TheLab</string>
  <key>CFBundleIdentifier</key><string>${LABEL}</string>
  <key>CFBundleName</key><string>${agentAppName()}</string>
  <key>CFBundleDisplayName</key><string>${agentAppName()}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`,
	);
	// Without the hardened runtime Node's JIT needs no entitlements.
	const sign = run("codesign", ["--force", "--sign", "-", app]);
	if (!sign.ok) fail(`codesign couldn't sign The Lab: ${sign.out}`);
	writeFileSync(from, source);
	return exe;
}

const agentApp = () => join(LAB, `${agentAppName()}.app`);

async function computer() {
	workspace();
	// The server writes these on every start too.
	launchers(join(LAB, "bin"));
	say(`Messages go to ${engine() === "codex" ? "Codex" : "Claude"}.`);
	if (MAC) {
		const exe = await macApp();
		const nodeDir = join(TOOLS, "node", "bin");
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(exe)}</string><string>${esc(join(HERE, "server.ts"))}</string></array>
  <key>WorkingDirectory</key><string>${esc(HERE)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${esc(nodeDir)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LAB_HOME</key><string>${esc(HOME)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${esc(join(LAB, "server.log"))}</string>
  <key>StandardErrorPath</key><string>${esc(join(LAB, "server.log"))}</string>
</dict>
</plist>
`;
		mkdirSync(dirname(PLIST), { recursive: true });
		writeFileSync(PLIST, plist);
		const uid = process.getuid?.() ?? fail("Couldn't tell which user is signed in.");
		run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
		// bootout returns before launchd has let go of the old job, and bootstrap
		// fails with error 5 until it has.
		let boot = run("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
		for (let i = 0; i < 10 && !(boot.ok || /already/i.test(boot.out)); i++) {
			run("sleep", ["1"]);
			boot = run("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
		}
		if (!(boot.ok || /already/i.test(boot.out)))
			fail(`launchctl bootstrap failed: ${boot.out}`);
		run("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);
	} else if (WIN) {
		// A Run entry starts it at sign-in with no admin rights. conhost --headless
		// keeps the console window from ever showing. cmd reads a batch file in
		// the console's code page, so chcp comes first for a profile like José.
		// The redirect holds the log open for as long as the server runs, so the
		// server can't trim it and it's moved aside here once it passes 5 MB.
		const start = join(LAB, "start.cmd");
		const log = join(LAB, "server.log");
		writeFileSync(
			start,
			`@chcp 65001 >nul\r\n@echo off\r\nset "LAB_HOME=${HOME}"\r\nif exist "${log}" for %%A in ("${log}") do if %%~zA GTR 5000000 move /y "${log}" "${log}.old" >nul\r\ncd /d "${HERE}"\r\n"${process.execPath}" "${join(HERE, "server.ts")}" >> "${log}" 2>&1\r\n`,
		);
		const line = `conhost.exe --headless cmd.exe /c "${start}"`;
		const reg = run("reg", [
			"add",
			RUN_KEY,
			"/v",
			"TheLab",
			"/t",
			"REG_SZ",
			"/d",
			line,
			"/f",
		]);
		if (!reg.ok) fail(`Couldn't add The Lab to the sign-in items: ${reg.out}`);
		// Nothing else brings the server back on Windows if its supervisor is
		// killed, as the Run entry only fires at sign-in. A copy started while
		// one is running sees that and stops by itself. It isn't worth failing
		// setup over, since the server runs fine without it.
		const watchdog = join(LAB, "watchdog.cmd");
		writeFileSync(
			watchdog,
			`@echo off\r\ncurl.exe -s -m 5 http://127.0.0.1:${config().port}/health >nul\r\nif errorlevel 1 "${start}"\r\n`,
		);
		const task = run("schtasks", [
			"/Create",
			"/F",
			"/TN",
			WATCHDOG,
			"/SC",
			"MINUTE",
			"/MO",
			"5",
			"/TR",
			`conhost.exe --headless cmd.exe /c "${watchdog}"`,
		]);
		if (!task.ok)
			say(
				`The Lab won't restart itself if it's killed outright, only at the next sign-in, as Windows wouldn't add the check for it: ${task.out}`,
			);
		// Spawned straight from node, conhost --headless exits before running
		// start.cmd, so it goes through Start-Process the way the Run entry does.
		if (!(await health()))
			run("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				`Start-Process conhost.exe -ArgumentList '--headless','cmd.exe','/c','"${start.replace(/'/g, "''")}"' -WindowStyle Hidden`,
			]);
		else await restart();
	} else {
		say(
			`Start at login is only set up on a Mac or Windows. Run the server by hand with: node ${join(HERE, "server.ts")}`,
		);
	}
	if (!(await health(30_000)))
		fail(
			`The server didn't come up within 30 seconds. Its log is ${join(LAB, "server.log")}.`,
		);
	say(`The server is running and starts at login. Workspace: ${HOME}`);
	if (MAC) await folderAccess();
}

// The server reads Desktop, Documents and Downloads as it starts, which is
// when macOS asks about each one. A read waits for his answer, so this waits
// on the server, and a refusal takes him to the switch that undoes it.
async function folderAccess() {
	const { port, token } = config();
	let f: Record<string, string> = {};
	const ask = async (method = "GET") => {
		f = await fetch(`http://127.0.0.1:${port}/folders`, {
			method,
			headers: { authorization: `Bearer ${token}` },
		})
			.then((r) => r.json() as Promise<Record<string, string>>)
			.catch(() => f);
	};
	const waiting = () => Object.values(f).includes("asking");
	// The Trash only opens with Full Disk Access, which is a different switch.
	const refused = (trash: boolean) =>
		Object.entries(f)
			.filter(([k, v]) => v === "refused" && (k === ".Trash") === trash)
			.map(([k]) => k);
	const fix = async (trash: boolean, pane: string, tell: string, giveUp: string) => {
		show(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
		say(tell);
		let restarted = false;
		for (
			let until = Date.now() + 300_000;
			refused(trash).length && Date.now() < until;
		) {
			await sleep(3000);
			await ask("POST");
			// macOS can hold on to a refusal for as long as the process runs.
			if (refused(trash).length && !restarted && Date.now() > until - 240_000) {
				restarted = true;
				await restart();
				await ask("POST");
			}
		}
		if (refused(trash).length) fail(giveUp);
	};
	await ask();
	if (waiting()) {
		say(
			`macOS is asking whether ${agentAppName()} may see the Desktop, Documents and Downloads folders. He clicks Allow on each. This waits for him.`,
		);
		for (let until = Date.now() + 180_000; waiting() && Date.now() < until; ) {
			await sleep(1000);
			await ask();
		}
		if (waiting())
			say(
				"The folder prompts haven't been answered. They may be behind another window, and the agent can't see those folders until they are.",
			);
	}
	const folders = refused(false).join(", ");
	if (folders)
		await fix(
			false,
			"Privacy_FilesAndFolders",
			`${agentAppName()} was turned down for ${folders}, so the agent can't see what's in there. System Settings is open at Files and Folders. He finds ${agentAppName()} in the list and switches on ${folders}. This waits for him.`,
			`The agent still can't see ${folders}. Switch on ${folders} under ${agentAppName()} in System Settings, Privacy & Security, Files and Folders, then run node setup.ts computer again.`,
		);
	if (refused(true).length) {
		// The Lab isn't in the Full Disk Access list until he adds it, so Finder shows him the app to drag in.
		run("open", ["-R", agentApp()]);
		await fix(
			true,
			"Privacy_AllFiles",
			`The agent can't open the Trash, so it can't put back what it deleted. System Settings is open at Full Disk Access, and a Finder window shows ${agentAppName()}. He drags ${agentAppName()} from Finder into the Full Disk Access list, confirms with his password or Touch ID, and checks its switch is on. This waits for him.`,
			`The agent still can't open the Trash. Add ${agentAppName()} under System Settings, Privacy & Security, Full Disk Access, then run node setup.ts computer again.`,
		);
	}
	say("The Lab can see the Desktop, Documents and Downloads folders and the Trash.");
}

// ---------- relay ----------

// The relay is a Cloudflare Worker, so it costs nothing at this size and
// needs a free Cloudflare account. One relay can serve any number of
// computers, so a second install can be pointed at the first one's.
async function relay() {
	let url = flag("url") ?? "";
	if (!url) {
		const dir = join(REPO, "relay");
		say("Installing the relay tools");
		const ci = spawnSync("npm", ["ci", "--no-fund", "--no-audit"], {
			cwd: dir,
			stdio: "inherit",
			shell: WIN,
		});
		if (ci.status !== 0) fail("npm ci failed in relay/. The output above says why.");
		const wrangler = (a: string[], inherit = false) =>
			spawnSync("npx", ["wrangler", ...a], {
				cwd: dir,
				encoding: "utf8",
				shell: WIN,
				env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
				stdio: inherit ? "inherit" : ["inherit", "pipe", "pipe"],
			});
		// deploy won't open the sign-in page when its output is piped, so
		// signing in is its own step with the browser.
		const who = wrangler(["whoami"]);
		if (/not authenticated/i.test(`${who.stdout ?? ""}${who.stderr ?? ""}`)) {
			say(
				"A Cloudflare page opens in the browser. He signs in (or makes a free account) and clicks Allow.",
			);
			if (wrangler(["login"], true).status !== 0)
				fail("Cloudflare sign-in didn't finish. Run this step again to retry.");
		}
		say("Putting up the relay");
		let r = wrangler(["deploy"]);
		let out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		// A brand new Cloudflare account has no workers.dev address until he
		// picks a name for it, and only the dashboard can do that.
		if (r.status !== 0 && /workers\.dev subdomain/i.test(out)) {
			show(
				/https:\/\/dash\.cloudflare\.com\/[^\s"')]+/.exec(out)?.[0] ??
					"https://dash.cloudflare.com/?to=/:account/workers/onboarding",
			);
			say(
				"Cloudflare needs a name for this account's workers.dev address first, and its page is open in the browser. He types any name (it becomes part of the relay's address) and clicks Set Up. This waits for him.",
			);
			for (let until = Date.now() + 600_000; r.status !== 0 && Date.now() < until; ) {
				await sleep(15_000);
				r = wrangler(["deploy"]);
				out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
			}
		}
		console.log(out);
		url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] ?? "";
		if (r.status !== 0 || !url)
			fail("The relay didn't go up. The wrangler output above says why.");
	}
	if (relayProblem(url) || !/^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(url))
		fail(
			`The relay address should look like https://the-lab-relay.name.workers.dev, not ${url}.`,
		);
	url = url.replace(/\/+$/, "");
	const res = await fetch(url)
		.then((x) => x.text())
		.catch((e) => `unreachable: ${e.message}`);
	if (!res.startsWith("The Lab relay"))
		fail(`${url} doesn't answer like a relay (${res.slice(0, 80)}).`);
	setConfig({ relay: url });
	await restart();
	say(
		`The relay is ${url}. Pair the phone again (node setup.ts phone, or node setup.ts pair) so it knows the relay.`,
	);
}

// ---------- tailscale ----------

function tailscale() {
	const ts = tailscaleState();
	if (!ts.installed)
		fail(
			MAC || WIN
				? `Tailscale is not installed. Install it from https://tailscale.com/download/${MAC ? "mac" : "windows"}, open it, and sign in.`
				: "Tailscale is not installed.",
		);
	if (!(ts.running && "dns" in ts && ts.dns))
		fail(
			`Tailscale is installed but not signed in (state: ${"state" in ts ? ts.state : "unknown"}). Open Tailscale and sign in, then run this again.`,
		);
	const { port } = config();
	const r = run(ts.bin, ["serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
	const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(r.out)?.[0];
	if (link)
		fail(
			`Tailscale needs HTTPS turned on for this network first. Open this link, approve it, then run this again:\n${link}`,
		);
	if (!r.ok) fail(`tailscale serve failed: ${r.out}`);
	const url = `https://${ts.dns}`;
	writeFileSync(join(LAB, "url"), url);
	say(url);
}

// ---------- phone ----------

async function download(url: string, to: string) {
	const res = await fetch(url, { redirect: "follow" });
	if (!(res.ok && res.body)) fail(`Download failed (${res.status}): ${url}`);
	mkdirSync(dirname(to), { recursive: true });
	await pipeline(Readable.fromWeb(res.body as WebStream), createWriteStream(to));
}

// local.properties is a Java properties file, where a bare colon would end
// the key, so the one after a Windows drive letter is escaped.
const sdkLine = (sdk: string) =>
	`sdk.dir=${sdk.replace(/\\/g, "/").replace(/:/g, "\\:")}\n`;

function extract(archive: string, into: string) {
	mkdirSync(into, { recursive: true });
	const r = run(TAR, ["-xf", archive, "-C", into], { timeout: 0 });
	if (!r.ok) fail(`Couldn't unpack ${archive}: ${r.out}`);
	rmSync(archive, { force: true });
}

async function jdk(): Promise<string> {
	const given = process.env["JAVA_HOME"];
	if (given && existsSync(join(given, "bin", WIN ? "javac.exe" : "javac")))
		return given;
	const dir = join(TOOLS, "jdk");
	const find = () => {
		if (!existsSync(dir)) return null;
		for (const d of readdirSync(dir)) {
			const homeDir = MAC ? join(dir, d, "Contents", "Home") : join(dir, d);
			if (existsSync(join(homeDir, "bin", WIN ? "javac.exe" : "javac"))) return homeDir;
		}
		return null;
	};
	const found = find();
	if (found) return found;
	const os = MAC ? "mac" : WIN ? "windows" : "linux";
	const arch = process.arch === "arm64" ? "aarch64" : "x64";
	say("Downloading a Java 21 build kit (about 200 MB)");
	const archive = join(TOOLS, WIN ? "jdk.zip" : "jdk.tar.gz");
	await download(
		`https://api.adoptium.net/v3/binary/latest/21/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`,
		archive,
	);
	// Unpacked beside it and moved into place, so an unpack that was cut off
	// can't pass for a finished one next time.
	const tmp = `${dir}-tmp`;
	rmSync(tmp, { recursive: true, force: true });
	extract(archive, tmp);
	rmSync(dir, { recursive: true, force: true });
	renameSync(tmp, dir);
	return find() ?? fail("The Java download unpacked into an unexpected layout.");
}

async function androidSdk(javaHome: string): Promise<string> {
	const given = process.env["ANDROID_HOME"];
	const sdk = given && existsSync(given) ? given : join(TOOLS, "android");
	const bin = (name: string) =>
		join(sdk, "cmdline-tools", "latest", "bin", WIN ? `${name}.bat` : name);
	if (!existsSync(bin("sdkmanager"))) {
		say("Downloading the Android command line tools (about 150 MB)");
		const xml = await (
			await fetch("https://dl.google.com/android/repository/repository2-3.xml")
		).text();
		const os = MAC ? "mac" : WIN ? "win" : "linux";
		const names = [
			...xml.matchAll(new RegExp(`commandlinetools-${os}-(\\d+)_latest\\.zip`, "g")),
		];
		const best =
			names.toSorted((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] ??
			fail("Could not find the Android command line tools in Google's list.");
		const archive = join(TOOLS, "cmdline-tools.zip");
		await download(`https://dl.google.com/android/repository/${best}`, archive);
		const tmp = join(TOOLS, "cmdline-tmp");
		rmSync(tmp, { recursive: true, force: true });
		extract(archive, tmp);
		mkdirSync(join(sdk, "cmdline-tools"), { recursive: true });
		rmSync(join(sdk, "cmdline-tools", "latest"), { recursive: true, force: true });
		renameSync(join(tmp, "cmdline-tools"), join(sdk, "cmdline-tools", "latest"));
		rmSync(tmp, { recursive: true, force: true });
		if (!WIN)
			for (const f of readdirSync(join(sdk, "cmdline-tools", "latest", "bin")))
				chmodSync(join(sdk, "cmdline-tools", "latest", "bin", f), 0o755);
	}
	const env = { ...process.env, JAVA_HOME: javaHome };
	mkdirSync(TOOLS, { recursive: true });
	// The package names have semicolons, which cmd.exe would split, so they go in a file.
	const list = join(TOOLS, "packages.txt");
	writeFileSync(
		list,
		["platform-tools", "platforms;android-37.2", "build-tools;36.0.0"].join("\n"),
	);
	run(bin("sdkmanager"), [`--sdk_root=${sdk}`, "--licenses"], {
		input: "y\n".repeat(30),
		env,
	});
	say("Installing Android SDK parts (about 400 MB the first time)");
	const r = run(bin("sdkmanager"), [`--sdk_root=${sdk}`, `--package_file=${list}`], {
		input: "y\n".repeat(30),
		env,
		timeout: 0,
	});
	if (!r.ok) fail(`sdkmanager failed: ${r.out.slice(-2000)}`);
	return sdk;
}

function keystore(javaHome: string) {
	const file = join(LAB, "phone.jks");
	const pwFile = join(LAB, "phone.jks.password");
	if (!existsSync(file)) {
		const pw = randomBytes(18).toString("base64url");
		const r = run(join(javaHome, "bin", WIN ? "keytool.exe" : "keytool"), [
			"-genkeypair",
			"-keystore",
			file,
			"-alias",
			"lab",
			"-keyalg",
			"RSA",
			"-keysize",
			"3072",
			"-validity",
			"36500",
			"-storepass",
			pw,
			"-keypass",
			pw,
			"-dname",
			"CN=The Lab",
		]);
		if (!r.ok) fail(`keytool failed: ${r.out}`);
		writeFileSync(pwFile, pw, { mode: 0o600 });
	}
	return { file, password: readFileSync(pwFile, "utf8").trim() };
}

// The phone to use from what `adb devices` printed, or what to tell him while
// he gets it ready, or why setup has to stop. Another ready device (an
// emulator, a second phone) is never used in place of a phone that isn't
// allowed yet.
export function pickDevice(
	list: string,
	wanted?: string,
): { serial: string } | { wait: string } | { stop: string } {
	// Each device is a serial and a state with a tab between, and adb's own
	// lines have none.
	const all = list
		.split("\n")
		.map((l) => /^(\S+)\t(\S+)/.exec(l.trim()))
		.filter((m) => m !== null)
		.map((m) => ({ serial: m[1] ?? "", state: m[2] ?? "" }));
	const seen = wanted ? all.filter((d) => d.serial === wanted) : all;
	const ready = seen.filter((d) => d.state === "device");
	if (seen.length > 1 && ready.length > 0)
		return {
			stop: `More than one device is connected: ${seen.map((d) => `${d.serial} (${d.state === "device" ? "ready" : d.state})`).join(", ")}. Unplug or close the ones that aren't his phone, or pass --serial with his phone's name to pick it.`,
		};
	const serial = ready[0]?.serial;
	if (serial) return { serial };
	return {
		wait: seen.some((d) => d.state === "unauthorized")
			? 'The phone is plugged in but hasn\'t allowed this computer yet. He unlocks it and taps Allow on "Allow USB debugging?", with Always allow ticked.'
			: "No phone yet. He plugs it in with a data cable, unlocks it, and checks Developer options > USB debugging is on. If nothing changes once it's in, the cable may only charge, so try another.",
	};
}

// He may still be turning on USB debugging when this gets here, so it waits
// for the phone and says what it's waiting on rather than failing.
async function adbDevice(adb: string): Promise<string> {
	let told = "";
	for (const until = Date.now() + 600_000; ; ) {
		const pick = pickDevice(run(adb, ["devices"]).out, flag("serial"));
		if ("serial" in pick) return pick.serial;
		if ("stop" in pick) fail(pick.stop);
		const now = pick.wait;
		if (now !== told) {
			told = now;
			say(now);
		}
		if (Date.now() > until)
			fail(`Still no phone after 10 minutes. ${now.replace(/^No phone yet\. /, "")}`);
		await sleep(2000);
	}
}

// The phone's clock in the form logcat -T takes. adb hands the phone's shell
// one line, so the format is quoted for that shell, and an answer that isn't
// a time counts as none.
const CLOCK = "date '+%m-%d %H:%M:%S.000'";
export const phoneTime = (out: string) => {
	const t = out.trim();
	return /^\d\d-\d\d \d\d:\d\d:\d\d\.000$/.test(t) ? t : undefined;
};

async function phone() {
	const url =
		flag("url") ??
		(existsSync(join(LAB, "url"))
			? readFileSync(join(LAB, "url"), "utf8").trim()
			: undefined);
	const { relay: relayUrl, port } = config();
	const javaHome = await jdk();
	const sdk = await androidSdk(javaHome);
	const adb = join(sdk, "platform-tools", WIN ? "adb.exe" : "adb");

	const store = keystore(javaHome);
	say("Building the app");
	const apk = buildApp(javaHome, sdk, store, false);
	publishApp(apk, javaHome, store);

	// After the downloads and the build, so he has had all that time to get
	// developer mode on.
	const serial = await adbDevice(adb);
	const sh = (...a: string[]) => run(adb, ["-s", serial, "shell", ...a]);
	const sdkLevel = Number(sh("getprop", "ro.build.version.sdk").out);
	if (sdkLevel && sdkLevel < 33)
		fail(
			`This phone runs Android API ${sdkLevel}, and The Lab needs Android 13 (API 33) or later.`,
		);

	say("Installing on the phone");
	const inst = run(adb, ["-s", serial, "install", "-r", apk]);
	if (!inst.ok && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(inst.out)) {
		// Each computer signs the app with its own key, so this one came from
		// another computer (or this one before a rebuild). Uninstalling it would
		// wipe every other computer's pairing and history on the phone, so it
		// stays and gets paired with this computer as well.
		const had = /versionName=(\S+)/.exec(sh("dumpsys", "package", PKG).out)?.[1];
		say(
			`The phone already has The Lab${had ? ` ${had}` : ""}, installed from another computer, so it keeps that copy and adds this computer to it. That copy updates from the computer that installed it. If no other computer uses it, uninstall The Lab on the phone and run this step again.`,
		);
	} else if (!inst.ok) fail(`adb install failed: ${inst.out}`);

	// A sideloaded app gets no profile from Play, so compile it ahead of time
	// here, or every cold start runs in the interpreter for the first few days.
	sh("cmd", "package", "compile", "-m", "speed", "-f", PKG);
	sh("pm", "grant", PKG, "android.permission.POST_NOTIFICATIONS");
	// Keeps the link to the computer alive through Doze.
	sh("dumpsys", "deviceidle", "whitelist", `+${PKG}`);
	const { token } = config();
	// Every value here is base64url, an address or a comma list, so none of
	// them needs quoting through adb's shell.
	const s = specOf(keys(LAB), relayUrl, lanAddresses(port + 1));
	const extras = [
		"--es",
		"room",
		s.room,
		"--es",
		"key",
		s.key,
		"--es",
		"pass",
		s.pass,
		...(s.relay ? ["--es", "relay", s.relay] : []),
		...(s.lan.length ? ["--es", "lan", s.lan.join(",")] : []),
	];
	const paired = sh(
		"am",
		"broadcast",
		"-n",
		`${PKG}/.PairReceiver`,
		...extras,
		...(url ? ["--es", "url", url] : []),
		"--es",
		"token",
		token,
	);
	if (!/result=0/.test(paired.out)) fail(`Pairing didn't take: ${paired.out}`);
	const opened = phoneTime(sh(CLOCK).out);
	sh("am", "start", "-n", `${PKG}/.MainActivity`);
	// A phone already paired with another computer only switches once he says so.
	if (paired.out.includes("confirm on the phone"))
		say(
			"The phone is already paired with another computer, so it's asking first. Tap Add on the phone, and the other computer stays paired as it was.",
		);
	await firewall(adb, serial, opened, port + 1);
	say(
		relayUrl
			? "The app is installed, paired and open on the phone. It reaches this computer straight over Wi-Fi at home and through the relay everywhere else."
			: "The app is installed, paired and open on the phone. Without a relay it only reaches this computer on the same Wi-Fi, so run `node setup.ts relay` next.",
	);
}

type Store = { file: string; password: string };

function buildApp(javaHome: string, sdk: string, store: Store, quiet: boolean): string {
	const project = join(REPO, "phone");
	writeFileSync(join(project, "local.properties"), sdkLine(sdk));
	const gradlew = join(project, WIN ? "gradlew.bat" : "gradlew");
	if (!WIN) chmodSync(gradlew, 0o755);
	const g = batch(gradlew, [
		"assembleRelease",
		"--console=plain",
		"-q",
		// Nobody is waiting on a build the server starts, so it doesn't leave a
		// daemon holding a gigabyte or so afterwards.
		...(quiet ? ["--no-daemon"] : []),
		`-Plab.keystore=${store.file}`,
		`-Plab.keystorePassword=${store.password}`,
	]);
	const build = spawnSync(g.file, g.args, {
		cwd: project,
		env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk },
		stdio: quiet ? "pipe" : "inherit",
		encoding: "utf8",
		windowsVerbatimArguments: g.windowsVerbatimArguments,
	});
	if (build.status !== 0)
		fail(
			quiet
				? `The app build failed: ${`${build.stdout ?? ""}${build.stderr ?? ""}`.trim().slice(-1500)}`
				: "The app build failed. The Gradle output above says why.",
		);
	return join(project, "app", "build", "outputs", "apk", "release", "app-release.apk");
}

// Where the server hands the app to phones that update themselves. A phone
// only takes it when the certificate matches the one its own copy was signed
// with, so a phone set up from another computer is never offered this one.
function publishApp(apk: string, javaHome: string, store: Store) {
	const pem = run(join(javaHome, "bin", WIN ? "keytool.exe" : "keytool"), [
		"-exportcert",
		"-rfc",
		"-alias",
		"lab",
		"-keystore",
		store.file,
		"-storepass",
		store.password,
	]);
	const body = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(
		pem.out,
	)?.[1];
	if (!(pem.ok && body))
		fail(`keytool couldn't read the signing certificate: ${pem.out}`);
	const data = readFileSync(apk);
	const dir = join(LAB, "phone-app");
	mkdirSync(dir, { recursive: true });
	// Swapped in whole, since the server may be sending the old one right now.
	writeFileSync(join(dir, "app.apk.part"), data);
	renameSync(join(dir, "app.apk.part"), join(dir, "app.apk"));
	const { version } = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
		version: string;
	};
	writeFileSync(
		join(dir, "app.json"),
		JSON.stringify({
			version,
			size: data.length,
			sha256: createHash("sha256").update(data).digest("hex"),
			cert: createHash("sha256")
				.update(Buffer.from(body.replace(/\s/g, ""), "base64"))
				.digest("hex"),
		}),
	);
}

// The server runs this after an update, so a phone set up from this computer
// can update itself. Only this computer holds the key its copy was signed with.
async function buildForPhones() {
	if (!existsSync(join(LAB, "phone.jks")))
		return say(
			"No phone was set up from this computer, so there's no app to build here.",
		);
	const javaHome = await jdk();
	const sdk = await androidSdk(javaHome);
	const store = keystore(javaHome);
	publishApp(buildApp(javaHome, sdk, store, true), javaHome, store);
	say("The app is built, and phones set up from this computer can update to it.");
}

const ipNumber = (ip: string) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);

// The app logs which way it reached this computer. On the same Wi-Fi it
// should come straight in, so anything else there means a firewall on this
// computer turned the tunnel's port down, usually a Cancel on the prompt in
// step 3. Windows can be put right with one Yes, a Mac only from Settings.
async function firewall(
	adb: string,
	serial: string,
	since: string | undefined,
	lanPort: number,
) {
	const route = async (from: string | undefined) => {
		for (let i = 0; i < 20; i++) {
			await sleep(1000);
			const log = run(adb, [
				"-s",
				serial,
				"logcat",
				"-d",
				...(from ? ["-T", from] : []),
				"-s",
				"Lab:I",
			]).out;
			const last = [...log.matchAll(/tunnel: (direct|relay)\s*$/gm)].at(-1)?.[1];
			if (last) return last;
		}
		return "none";
	};
	const wifi = /inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(
		run(adb, ["-s", serial, "shell", "ip", "-4", "-o", "addr", "show", "wlan0"]).out,
	);
	if (!wifi) return;
	const [, phoneIp = "", bits = "24"] = wifi;
	const block = 2 ** (32 - Number(bits));
	const sameWifi = lanAddresses(lanPort).some(
		(a) =>
			Math.floor(ipNumber(a.split(":")[0] ?? "") / block) ===
			Math.floor(ipNumber(phoneIp) / block),
	);
	if (!sameWifi || (await route(since)) === "direct") return;
	if (!WIN) {
		say(
			`The phone is on the same Wi-Fi but can't come straight in, so it goes through the relay, which is slower. The Mac's firewall is probably blocking ${agentAppName()}. In System Settings, Network, Firewall, Options, set ${agentAppName()} to allow incoming connections.`,
		);
		return;
	}
	say(
		"The phone is on the same Wi-Fi but Windows blocked it from coming straight in, so it went through the relay. A Windows prompt asks whether to let The Lab make changes. He clicks Yes.",
	);
	const node = process.execPath.replace(/'/g, "''");
	const script = [
		// Block rules win over allow rules, and a Cancel on the first prompt leaves one for node.
		`Get-NetFirewallApplicationFilter -Program '${node}' | Get-NetFirewallRule | Where-Object Action -eq Block | Remove-NetFirewallRule`,
		...["TCP", "UDP"].map(
			(p) =>
				`New-NetFirewallRule -DisplayName 'The Lab (${p})' -Direction Inbound -Program '${node}' -Protocol ${p} -LocalPort ${lanPort} -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null`,
		),
	].join("; ");
	const elevated = run("powershell.exe", [
		"-NoProfile",
		"-Command",
		`Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${Buffer.from(script, "utf16le").toString("base64")}'`,
	]);
	if (!elevated.ok) {
		say(
			"The firewall wasn't changed, so at home the phone keeps going through the relay. It still works, just a bit slower. Run node setup.ts phone again to retry.",
		);
		return;
	}
	run(adb, ["-s", serial, "shell", "am", "force-stop", PKG]);
	const again = phoneTime(run(adb, ["-s", serial, "shell", CLOCK]).out);
	run(adb, ["-s", serial, "shell", "am", "start", "-n", `${PKG}/.MainActivity`]);
	say(
		(await route(again)) === "direct"
			? "Fixed. The phone now comes straight in over the Wi-Fi."
			: "The firewall is changed, but the phone still can't come straight in. It works through the relay, and a router that keeps devices apart (guest Wi-Fi often does) would explain it.",
	);
}

// Keeps Tailscale's VPN on at all times on the phone, so The Lab can always reach the computer.
async function phoneVpn() {
	const javaHome = await jdk();
	const sdk = await androidSdk(javaHome);
	const adb = join(sdk, "platform-tools", WIN ? "adb.exe" : "adb");
	const serial = await adbDevice(adb);
	const r = run(adb, [
		"-s",
		serial,
		"shell",
		"settings",
		"put",
		"secure",
		"always_on_vpn_app",
		"com.tailscale.ipn",
	]);
	if (!r.ok) fail(`Couldn't set always-on VPN: ${r.out}`);
	say("Tailscale is now the always-on VPN on the phone.");
}

// ---------- check ----------

async function check() {
	const ts = tailscaleState();
	const status = {
		node: process.version,
		workspace: existsSync(join(HOME, "app", "index.html")),
		startsAtLogin: MAC
			? existsSync(PLIST)
			: WIN
				? run("reg", ["query", RUN_KEY, "/v", "TheLab"]).ok
				: null,
		serverRunning: await health(),
		engine: engine(),
		agentSignedIn: engine() === "codex" ? codexSignedIn() : signedIn().loggedIn,
		relay: config().relay ?? null,
		tailscale: ts.installed
			? "running" in ts && ts.running
				? "signed in"
				: "not signed in"
			: "not installed",
		phoneUrl: existsSync(join(LAB, "url"))
			? readFileSync(join(LAB, "url"), "utf8").trim()
			: null,
		phoneKeystore: existsSync(join(LAB, "phone.jks")),
		desktopWindow: existsSync(join(LAB, "desktop", "built")),
	};
	say(JSON.stringify(status, null, 2));
}

// Opens a page on the computer with a QR code. Scanned with the phone's camera,
// it pairs The Lab again without the cable.
async function pair() {
	if (process.argv.includes("--reset")) await resetPairing();
	const { port, token } = config();
	if (!(await health()))
		fail("The server is not running. Run `node setup.ts computer` first.");
	// The link lands in the browser's history, so it carries a signature that
	// works once for 2 minutes rather than the token itself.
	const { createHmac } = await import("node:crypto");
	const at = Date.now();
	const sig = createHmac("sha256", token).update(`the-lab pair ${at}`).digest("hex");
	const link = `http://127.0.0.1:${port}/pair?k=${at}.${sig}&next=/pair-phone`;
	show(link);
	say(
		`The pairing code is open in the browser. On the phone, point the camera at the code and tap the link it finds. It works once and lasts 10 minutes.${config().relay ? "" : " With no relay set up, the phone has to be on the same Wi-Fi as this computer, now and later."}`,
	);
}

// Every phone shares the one token and tunnel key, so a lost phone, or a code
// someone else saw, is only shut out by making new ones. Every phone then has
// to pair again.
async function resetPairing() {
	stopServer();
	setConfig({ token: randomBytes(32).toString("base64url") });
	// The old token and key would otherwise live on in these copies.
	for (const f of [
		"config.json.good",
		"config.json.bad",
		"tunnel.json",
		"tunnel.json.bad",
		"push-tokens.json",
	])
		rmSync(join(LAB, f), { force: true });
	await computer();
	say(
		"Every phone is unpaired now and has to scan the new code. Close The Lab's window and open it again, as it still holds the old key.",
	);
}

// Signing needs his Apple account in Xcode, and push needs a paid one, so it
// only asks for that when he has given a key for it.
async function iphone() {
	say(
		"The iPhone app isn't recommended. It has never run on a real iPhone, and an install on a free Apple account stops opening after 7 days. SETUP.md has the rest.",
	);
	if (!MAC) fail("The iPhone app can only be built on a Mac with Xcode.");
	if (!run("xcodebuild", ["-version"]).ok)
		fail(
			"This needs Xcode. Install it from the App Store, open it once, then run this again.",
		);
	const team = flag("team");
	if (!team)
		fail(
			"Run this with --team and his Apple team ID. It's on the Membership page at developer.apple.com, or under Signing in Xcode for a free account.",
		);
	const push = existsSync(join(LAB, "apple-push.json"));
	const project = join(REPO, "iphone");
	const out = join(LAB, "iphone-build");
	say("Building the iPhone app");
	const build = spawnSync(
		"xcodebuild",
		[
			"-project",
			"TheLab.xcodeproj",
			"-target",
			"TheLab",
			"-sdk",
			"iphoneos",
			"-configuration",
			"Release",
			"-allowProvisioningUpdates",
			`DEVELOPMENT_TEAM=${team}`,
			`SYMROOT=${out}`,
			...(flag("bundle") ? [`PRODUCT_BUNDLE_IDENTIFIER=${flag("bundle")}`] : []),
			...(push ? ["CODE_SIGN_ENTITLEMENTS=TheLab/Push.entitlements"] : []),
		],
		{ cwd: project, stdio: "inherit" },
	);
	if (build.status !== 0)
		fail(
			"The build failed. If the output above mentions signing, open Xcode, add his Apple account under Settings, Accounts, then run this again.",
		);
	const listed = run("xcrun", ["devicectl", "list", "devices"]);
	const device = /[0-9A-F]{8}-[0-9A-F-]{20,}/i.exec(
		listed.out
			.split("\n")
			.find((l) => /iphone/i.test(l) && /connected|available/i.test(l)) ?? "",
	)?.[0];
	if (!device)
		fail(
			"Plug the iPhone in with a cable, unlock it, tap Trust on it, then run this again.",
		);
	const app = join(out, "Release-iphoneos", "TheLab.app");
	const inst = run("xcrun", [
		"devicectl",
		"device",
		"install",
		"app",
		"--device",
		device,
		app,
	]);
	if (!inst.ok) fail(`Installing on the iPhone failed: ${inst.out}`);
	say(
		`Installed. On a free Apple account the app stops opening after 7 days until this is run again.${push ? "" : " With no apple-push.json, notifications only arrive while The Lab is open."}`,
	);
	await pair();
}

// ---------- stop and remove ----------

function stopServer() {
	if (MAC) {
		const uid = process.getuid?.() ?? fail("Couldn't tell which user is signed in.");
		run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
	} else if (WIN) {
		// Both the supervisor and the server it runs have server.ts on their command line.
		const script = join(HERE, "server.ts").replace(/'/g, "''");
		run("powershell.exe", [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${script}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
		]);
	}
}

// Before an update swaps the source folder, since Windows won't delete files
// a running server holds open. `computer` starts it again.
async function stop() {
	stopServer();
	say(
		(await health())
			? "The server is still answering. Its log is in ~/.thelab/server.log."
			: "The server is stopped. node setup.ts computer starts it again.",
	);
}

// Undoes `computer`: the server stops and no longer starts at sign-in. His
// files and conversation stay, so running `computer` again brings it all back.
function remove() {
	stopServer();
	if (MAC) rmSync(PLIST, { force: true });
	else if (WIN) {
		run("reg", ["delete", RUN_KEY, "/v", "TheLab", "/f"]);
		run("schtasks", ["/Delete", "/F", "/TN", WATCHDOG]);
	}
	say(
		`The Lab no longer runs on this computer. Still here, for him to keep or delete: his workspace (${HOME}), his conversation and the downloaded tools (${LAB}, about 1 GB with the phone tools) and the app on the phone.`,
	);
}

// An .aab for Play Console internal testing. Play re-signs it with its own
// key, so it can't install over the cable copy.
async function bundle() {
	const javaHome = await jdk();
	const sdk = await androidSdk(javaHome);
	const store = keystore(javaHome);
	const project = join(REPO, "phone");
	writeFileSync(join(project, "local.properties"), sdkLine(sdk));
	const gradlew = join(project, WIN ? "gradlew.bat" : "gradlew");
	if (!WIN) chmodSync(gradlew, 0o755);
	const g = batch(gradlew, [
		"bundleRelease",
		"--console=plain",
		"-q",
		`-Plab.keystore=${store.file}`,
		`-Plab.keystorePassword=${store.password}`,
		`-Plab.versionCode=${Math.floor(Date.now() / 60_000)}`,
	]);
	const build = spawnSync(g.file, g.args, {
		cwd: project,
		env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk },
		stdio: "inherit",
		windowsVerbatimArguments: g.windowsVerbatimArguments,
	});
	if (build.status !== 0)
		fail("The bundle build failed. The Gradle output above says why.");
	say(join(project, "app", "build", "outputs", "bundle", "release", "app-release.aab"));
}

// Code in the source folder can be fixed in place, and a fix has to pass the
// same checks as every change to The Lab before any other step runs.
const STAMP = join(LAB, "source-ok");
function gate(name: string) {
	if (["lint", "check", "stop", "remove", "report"].includes(name)) return;
	const now = treeHash(REPO);
	if (!existsSync(STAMP)) {
		mkdirSync(LAB, { recursive: true });
		writeFileSync(STAMP, now);
	} else if (readFileSync(STAMP, "utf8") !== now)
		fail(
			"The Lab's code changed since it last passed its checks. Run node setup.ts lint, fix everything it lists the way the code around it is written, then run this step again.",
		);
}
function lint() {
	say("Checking The Lab's code (lint rules, types and tests, about a minute)");
	const problem = verify(REPO);
	if (problem) fail(`The code doesn't pass yet, because ${problem}`);
	writeFileSync(STAMP, treeHash(REPO));
	say("The code passes the lint rules, the type check and the tests.");
}

// The Lab's own window on this computer, built here from desktop/ so it's
// never a download that SmartScreen or Gatekeeper has to vouch for.
const WEBVIEW2 = {
	version: "1.0.4258.31",
	sha256: "56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9",
};
async function webview2(): Promise<string> {
	const dir = join(TOOLS, `webview2-${WEBVIEW2.version}`);
	if (existsSync(join(dir, "lib"))) return dir;
	const pkg = join(TOOLS, "webview2.nupkg");
	await download(
		`https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${WEBVIEW2.version}/microsoft.web.webview2.${WEBVIEW2.version}.nupkg`,
		pkg,
	);
	if (
		createHash("sha256").update(readFileSync(pkg)).digest("hex") !== WEBVIEW2.sha256
	) {
		rmSync(pkg, { force: true });
		fail(
			"The WebView2 download from nuget.org wasn't the file it should be. Run this again.",
		);
	}
	extract(pkg, dir);
	return dir;
}
// The window holds these files open while it runs, so they're only copied
// when they changed.
function copyChanged(from: string, to: string) {
	if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) return;
	try {
		cpSync(from, to);
	} catch (e) {
		if (
			!(e instanceof Error && "code" in e && (e.code === "EBUSY" || e.code === "EPERM"))
		)
			throw e;
		fail("The Lab's window is open on this computer. Close it, then run this again.");
	}
}
// A path inside single quotes in PowerShell.
const q = (s: string) => s.replace(/'/g, "''");
async function windowsShell(out: string): Promise<string> {
	const sdk = await webview2();
	const arch = process.arch === "arm64" ? "win-arm64" : "win-x64";
	const lib = join(sdk, "lib", "net462");
	const refs = [
		"Microsoft.Web.WebView2.Core.dll",
		"Microsoft.Web.WebView2.WinForms.dll",
	];
	for (const f of refs) copyChanged(join(lib, f), join(out, f));
	copyChanged(
		join(sdk, "runtimes", arch, "native", "WebView2Loader.dll"),
		join(out, "WebView2Loader.dll"),
	);
	const csc = join(
		setting("WINDIR") ?? "C:\\Windows",
		"Microsoft.NET",
		"Framework64",
		"v4.0.30319",
		"csc.exe",
	);
	const next = join(out, "TheLab.new.exe");
	const built = run(csc, [
		"-nologo",
		"-target:winexe",
		"-optimize+",
		`-win32icon:${join(REPO, "desktop", "lab.ico")}`,
		`-out:${next}`,
		...refs.map((f) => `-r:${join(out, f)}`),
		"-r:System.Windows.Forms.dll",
		"-r:System.Drawing.dll",
		"-r:System.Net.Http.dll",
		"-r:System.Web.Extensions.dll",
		// Inside the exe, where the agent can't change what the Allow card runs.
		`-resource:${join(REPO, "shared", "ask.js")},ask.js`,
		join(REPO, "desktop", "windows", "TheLab.cs"),
	]);
	if (!built.ok) fail(`The window didn't build: ${built.out.slice(-2000)}`);
	// The agent can still do everything else without this, so a failure only warns.
	mkdirSync(join(LAB, "bin"), { recursive: true });
	const helper = run(
		"xcrun",
		[
			"swiftc",
			"-O",
			"-o",
			join(LAB, "bin", "lab-ax"),
			join(REPO, "desktop", "mac", "computer.swift"),
		],
		{ timeout: 300_000 },
	);
	if (!helper.ok)
		console.log(`The computer tool didn't build: ${helper.out.slice(-1000)}`);
	const exe = join(out, "TheLab.exe");
	try {
		renameSync(next, exe);
	} catch (e) {
		if (
			!(e instanceof Error && "code" in e && (e.code === "EBUSY" || e.code === "EPERM"))
		)
			throw e;
		fail("The Lab's window is open on this computer. Close it, then run this again.");
	}
	return exe;
}
function macShell(out: string): string {
	if (!run("xcrun", ["--find", "swiftc"]).ok) {
		run("xcode-select", ["--install"]);
		fail(
			"Building The Lab's window needs Apple's command line tools, and a window on the Mac is asking to install them. Ask him to click Install and wait for it to finish (5 to 10 minutes), then run node setup.ts desktop again.",
		);
	}
	const next = join(out, "The Lab.app");
	rmSync(next, { recursive: true, force: true });
	mkdirSync(join(next, "Contents", "MacOS"), { recursive: true });
	mkdirSync(join(next, "Contents", "Resources"), { recursive: true });
	// The Allow card's script goes inside the binary, where the agent can't
	// change it. A second source file would stop top-level code compiling, so
	// it goes at the top of the one file.
	const source = join(out, "TheLab.swift");
	const ask = readFileSync(join(REPO, "shared", "ask.js")).toString("base64");
	writeFileSync(
		source,
		`let askScript = "${ask}"\n${readFileSync(join(REPO, "desktop", "mac", "TheLab.swift"), "utf8")}`,
	);
	const built = run(
		"xcrun",
		["swiftc", "-O", "-o", join(next, "Contents", "MacOS", "TheLab"), source],
		{ timeout: 300_000 },
	);
	rmSync(source, { force: true });
	if (!built.ok) fail(`The window didn't build: ${built.out.slice(-2000)}`);
	cpSync(join(HERE, "TheLab.icns"), join(next, "Contents", "Resources", "TheLab.icns"));
	const pkg = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8")) as {
		version: string;
	};
	writeFileSync(
		join(next, "Contents", "Info.plist"),
		`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>TheLab</string>
  <key>CFBundleIdentifier</key><string>${PKG}.desktop</string>
  <key>CFBundleName</key><string>The Lab</string>
  <key>CFBundleDisplayName</key><string>The Lab</string>
  <key>CFBundleIconFile</key><string>TheLab</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>LabDir</key><string>${esc(LAB)}</string>
</dict>
</plist>
`,
	);
	run("codesign", ["--force", "--sign", "-", next]);
	const app = join(homedir(), "Applications", "The Lab.app");
	mkdirSync(dirname(app), { recursive: true });
	rmSync(app, { recursive: true, force: true });
	renameSync(next, app);
	return join(app, "Contents", "MacOS", "TheLab");
}
// Start menu and desktop shortcuts to the window.
function shortcuts(exe: string) {
	const link = run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		`$w = New-Object -ComObject WScript.Shell; foreach ($d in [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop')) { $s = $w.CreateShortcut((Join-Path $d 'The Lab.lnk')); $s.TargetPath = '${q(exe)}'; $s.WorkingDirectory = '${q(dirname(exe))}'; $s.Description = 'Text the agent on this computer'; $s.Save() }`,
	]);
	if (!link.ok) fail(`Couldn't add The Lab to the Start menu: ${link.out}`);
}
async function desktop() {
	if (!(WIN || MAC)) fail("The Lab's window is for Windows and macOS.");
	if (!(await health(30_000)))
		fail(
			"The server isn't running, so the window has nothing to show. Run node setup.ts computer first.",
		);
	const out = join(LAB, "desktop");
	mkdirSync(out, { recursive: true });
	const bin = WIN ? await windowsShell(out) : macShell(out);
	// The window opens off screen, signs in and says what it found.
	const shot = join(out, "check.png");
	rmSync(`${shot}.txt`, { force: true });
	run(bin, ["--check", shot], { timeout: 90_000 });
	const found = existsSync(`${shot}.txt`) ? readFileSync(`${shot}.txt`, "utf8") : "";
	if (!found.includes('platform "desktop"'))
		fail(
			`The window built but didn't open the app. ${found ? `It found: ${found.trim()}` : "It didn't answer within 90 seconds."} A picture of what it showed is at ${shot}.`,
		);
	writeFileSync(join(out, "built"), windowHash(REPO));
	if (args.includes("--quiet")) return;
	if (WIN) shortcuts(bin);
	if (WIN) run("explorer.exe", [bin]);
	else run("open", [dirname(dirname(dirname(bin)))]);
	say(
		WIN
			? "The Lab's window is open, and it's in the Start menu and on the desktop as The Lab."
			: "The Lab's window is open, and it's in Applications as The Lab. It can go in the Dock from there.",
	);
	say(`A picture of the check is at ${shot}.`);
}

const steps: Record<string, () => Promise<void>> = {
	check,
	desktop,
	lint: async () => lint(),
	auth: async () => auth(),
	computer,
	workspace: async () => workspace(),
	selftest,
	relay,
	tailscale: async () => tailscale(),
	phone,
	apk: buildForPhones,
	iphone,
	pair,
	stop,
	remove: async () => remove(),
	bundle,
	"phone-vpn": phoneVpn,
};
// Run as a step, and not when the tests load it.
if (
	process.argv[1] &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const step = steps[process.argv[2] ?? ""];
	if (!step) fail(`Usage: node setup.ts ${Object.keys(steps).join("|")}`);
	gate(process.argv[2] ?? "");
	await step();
}
