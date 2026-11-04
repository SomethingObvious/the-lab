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
//   node setup.ts pair         open a QR code on the computer that pairs the phone again
//   node setup.ts bundle       build the app as an .aab for Play Console internal testing
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	cpSync,
	createWriteStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import { config, home, labDir, setConfig, words } from "./config.ts";
import { launchers } from "./trash.ts";
import { keys, lanAddresses, specOf } from "./tunnel.ts";

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
const args = process.argv.slice(3);
const flag = (name: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};

const say = (s: string) => console.log(s);
function fail(s: string): never {
	console.error(s);
	process.exit(1);
}
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
	if (c.engine !== want)
		writeFileSync(
			join(LAB, "config.json"),
			JSON.stringify({ ...c, engine: want }, null, 2),
			{ mode: 0o600 },
		);
	return want as "claude" | "codex";
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

async function selftest() {
	const { port, token } = config();
	if (!(await health()))
		fail("The server is not running. Run `node setup.ts computer` first.");
	const cid = crypto.randomUUID();
	const res = await fetch(`http://127.0.0.1:${port}/events`, {
		headers: { authorization: `Bearer ${token}`, "last-event-id": "999999999" },
	});
	if (!res.body) fail("The server answered without a stream of events.");
	const reader = res.body.getReader();
	await fetch(`http://127.0.0.1:${port}/send`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify({
			text: "This is a setup check from The Lab. Reply with exactly: lab ok",
			cid,
		}),
	});
	const until = Date.now() + 180_000;
	let buf = "";
	let reply = "";
	const dec = new TextDecoder();
	while (Date.now() < until) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			const e = JSON.parse(line.slice(6));
			if (e.kind === "reply") reply = e.text;
			if (e.kind === "notice") fail(`The agent couldn't run: ${e.text}`);
			if (e.kind === "done") {
				await reader.cancel();
				if (!e.ok) fail(`The test message failed: ${e.error ?? "no reason given"}`);
				say(`Round trip works. The agent replied: ${reply}`);
				return;
			}
		}
	}
	fail(`No reply within 3 minutes. Check the server log at ${join(LAB, "server.log")}`);
}

// ---------- computer ----------

function workspace() {
	mkdirSync(HOME, { recursive: true });
	const template = join(HERE, "template");
	for (const name of readdirSync(template)) {
		if (name === "skill") continue;
		const dest = join(HOME, name);
		// His app folder and notes are his after the first copy, so they're never overwritten.
		if (existsSync(dest)) continue;
		cpSync(join(template, name), dest, { recursive: true });
		const files = statSync(dest).isDirectory()
			? readdirSync(dest, { recursive: true }).map((f) => join(dest, String(f)))
			: [dest];
		for (const f of files) fitToSystem(f);
	}
	// Claude finds project skills in .claude/skills and Codex in .agents/skills.
	// Copied one by one, since .claude may already be there for other reasons.
	for (const name of readdirSync(join(template, "skill"))) {
		for (const where of [".claude", ".agents"]) {
			const dest = join(HOME, where, "skills", name);
			if (existsSync(dest)) continue;
			cpSync(join(template, "skill", name), dest, { recursive: true });
			for (const f of readdirSync(dest, { recursive: true }))
				fitToSystem(join(dest, String(f)));
		}
	}
	// Codex reads AGENTS.md where Claude reads CLAUDE.md, so both see one file.
	const agents = join(HOME, "AGENTS.md");
	if (!existsSync(agents)) {
		try {
			symlinkSync("CLAUDE.md", agents);
		} catch {
			cpSync(join(HOME, "CLAUDE.md"), agents);
		}
	}
	config();
}

// The template is written for both systems. Each copy keeps only the blocks for its
// own system, and on Windows it names the Recycle Bin.
function fitToSystem(file: string) {
	if (!/\.(md|js|html|json|css)$/.test(file)) return;
	const other = WIN ? "mac" : "windows";
	const text = readFileSync(file, "utf8")
		.replace(new RegExp(`<!-- ${other} -->[\\s\\S]*?<!-- end -->\\n?`, "g"), "")
		.replace(/<!-- (mac|windows|end) -->\n?/g, "")
		.replace(/\n{3,}/g, "\n\n");
	writeFileSync(file, words(text));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

async function computer() {
	workspace();
	// The server writes these on every start too.
	launchers(join(LAB, "bin"));
	say(`Messages go to ${engine() === "codex" ? "Codex" : "Claude"}.`);
	if (MAC) {
		const nodeDir = dirname(process.execPath);
		const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${esc(process.execPath)}</string><string>${esc(join(HERE, "server.ts"))}</string></array>
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
		const boot = run("launchctl", ["bootstrap", `gui/${uid}`, PLIST]);
		if (!(boot.ok || /already/i.test(boot.out)))
			fail(`launchctl bootstrap failed: ${boot.out}`);
		run("launchctl", ["kickstart", "-k", `gui/${uid}/${LABEL}`]);
	} else if (WIN) {
		// A Run entry starts it at sign-in with no admin rights. conhost --headless
		// keeps the console window from ever showing. cmd reads a batch file in
		// the console's code page, so chcp comes first for a profile like José.
		const start = join(LAB, "start.cmd");
		writeFileSync(
			start,
			`@chcp 65001 >nul\r\n@echo off\r\nset "LAB_HOME=${HOME}"\r\ncd /d "${HERE}"\r\n"${process.execPath}" "${join(HERE, "server.ts")}" >> "${join(LAB, "server.log")}" 2>&1\r\n`,
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
		say(
			"Putting up the relay. If a Cloudflare page opens, he signs in (or makes a free account) and clicks Allow.",
		);
		const r = spawnSync("npx", ["wrangler", "deploy"], {
			cwd: dir,
			encoding: "utf8",
			shell: WIN,
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
			stdio: ["inherit", "pipe", "pipe"],
		});
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
		console.log(out);
		url = /https:\/\/[\w.-]+\.workers\.dev/.exec(out)?.[0] ?? "";
		if (r.status !== 0 || !url)
			fail("The relay didn't go up. The wrangler output above says why.");
	}
	if (!/^https:\/\/[\w.-]+(:\d+)?\/?$/.test(url))
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
	const r = run("tar", ["-xf", archive, "-C", into]);
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
	extract(archive, dir);
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

function adbDevice(adb: string): string {
	const out = run(adb, ["devices"])
		.out.split("\n")
		.slice(1)
		.map((l) => l.trim().split(/\s+/))
		.filter((p) => p.length >= 2);
	const wanted = flag("serial");
	const ready = out.filter(
		([s, state]) => state === "device" && (!wanted || s === wanted),
	);
	if (out.some(([, state]) => state === "unauthorized"))
		fail(
			'The phone is plugged in but hasn\'t allowed this computer yet. Unlock it and tap Allow on the "Allow USB debugging?" prompt (tick Always allow), then run this again.',
		);
	if (ready.length > 1)
		fail(
			`More than one device is connected (${ready.map((r) => r[0]).join(", ")}). Pass --serial to pick one.`,
		);
	return (
		ready[0]?.[0] ??
		fail(
			"No phone found over USB. Plug it in with a data cable, unlock it, and check Developer options > USB debugging is on.",
		)
	);
}

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
	const serial = adbDevice(adb);
	const sh = (...a: string[]) => run(adb, ["-s", serial, "shell", ...a]);
	const sdkLevel = Number(sh("getprop", "ro.build.version.sdk").out);
	if (sdkLevel && sdkLevel < 33)
		fail(
			`This phone runs Android API ${sdkLevel}, and The Lab needs Android 13 (API 33) or later.`,
		);

	const store = keystore(javaHome);
	const project = join(REPO, "phone");
	writeFileSync(join(project, "local.properties"), sdkLine(sdk));
	say("Building the app");
	const gradlew = join(project, WIN ? "gradlew.bat" : "gradlew");
	if (!WIN) chmodSync(gradlew, 0o755);
	const build = spawnSync(
		gradlew,
		[
			"assembleRelease",
			"--console=plain",
			"-q",
			`-Plab.keystore=${store.file}`,
			`-Plab.keystorePassword=${store.password}`,
		],
		{
			cwd: project,
			env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk },
			stdio: "inherit",
			shell: WIN,
		},
	);
	if (build.status !== 0)
		fail("The app build failed. The Gradle output above says why.");
	const apk = join(
		project,
		"app",
		"build",
		"outputs",
		"apk",
		"release",
		"app-release.apk",
	);

	say("Installing on the phone");
	let inst = run(adb, ["-s", serial, "install", "-r", apk]);
	if (!inst.ok && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(inst.out)) {
		// Signed with a different key (a rebuilt computer, or a test build), so it has to go and come back.
		run(adb, ["-s", serial, "uninstall", PKG]);
		inst = run(adb, ["-s", serial, "install", apk]);
	}
	if (!inst.ok) fail(`adb install failed: ${inst.out}`);

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
	sh("am", "start", "-n", `${PKG}/.MainActivity`);
	say(
		relayUrl
			? "The app is installed, paired and open on the phone. It reaches this computer straight over Wi-Fi at home and through the relay everywhere else."
			: "The app is installed, paired and open on the phone. Without a relay it only reaches this computer on the same Wi-Fi, so run `node setup.ts relay` next.",
	);
}

// Keeps Tailscale's VPN on at all times on the phone, so The Lab can always reach the computer.
async function phoneVpn() {
	const javaHome = await jdk();
	const sdk = await androidSdk(javaHome);
	const adb = join(sdk, "platform-tools", WIN ? "adb.exe" : "adb");
	const serial = adbDevice(adb);
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
	};
	say(JSON.stringify(status, null, 2));
}

// Opens a page on the computer with a QR code. Scanned with the phone's camera
// while Tailscale is on, it pairs The Lab again without the cable.
async function pair() {
	const { port, token } = config();
	if (!(await health()))
		fail("The server is not running. Run `node setup.ts computer` first.");
	if (!(config().relay || existsSync(join(LAB, "url"))))
		fail("Run `node setup.ts relay` first, so the code can point at this computer.");
	const link = `http://127.0.0.1:${port}/pair?t=${encodeURIComponent(token)}&next=/pair-phone`;
	if (MAC) run("open", [link]);
	else if (WIN) run("explorer.exe", [link]);
	else say(`Open this on the computer: ${link}`);
	say(
		config().relay
			? "The pairing code is open in the browser. On the phone, point the camera at the code, and tap the link it finds. It works once and lasts 10 minutes."
			: "The pairing code is open in the browser. On the phone, turn Tailscale on, then point the camera at the code and tap the link. It works once and lasts 10 minutes.",
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
	const build = spawnSync(
		gradlew,
		[
			"bundleRelease",
			"--console=plain",
			"-q",
			`-Plab.keystore=${store.file}`,
			`-Plab.keystorePassword=${store.password}`,
			`-Plab.versionCode=${Math.floor(Date.now() / 60_000)}`,
		],
		{
			cwd: project,
			env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk },
			stdio: "inherit",
			shell: WIN,
		},
	);
	if (build.status !== 0)
		fail("The bundle build failed. The Gradle output above says why.");
	say(join(project, "app", "build", "outputs", "bundle", "release", "app-release.aab"));
}

const steps: Record<string, () => Promise<void>> = {
	check,
	auth: async () => auth(),
	computer,
	workspace: async () => workspace(),
	selftest,
	relay,
	tailscale: async () => tailscale(),
	phone,
	pair,
	bundle,
	"phone-vpn": phoneVpn,
};
const step = steps[process.argv[2] ?? ""];
if (!step) fail(`Usage: node setup.ts ${Object.keys(steps).join("|")}`);
await step();
