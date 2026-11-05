import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
	appendFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	truncateSync,
	watch,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import process, { env } from "node:process";
import { pipeline } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { tailscaleState } from "./checks.ts";
import {
	config,
	home,
	labDir,
	saveFile,
	setConfig,
	setting,
	WIN,
	words,
} from "./config.ts";
import { ASK_MODES } from "./guard.ts";
import { EFFORTS, type Live } from "./lab.ts";
import { awake, type Mac } from "./mac.ts";
import {
	cleanSchedules,
	due,
	firstSeen,
	GRACE,
	missed,
	next,
	type Schedule,
} from "./schedule.ts";
import { cleanSettings, DEFAULTS, type Settings } from "./settings.ts";
import { launchers } from "./trash.ts";
import { startTunnel } from "./tunnel.ts";
import {
	apply,
	bad,
	confirm,
	desktopStale,
	halfway,
	latest,
	onTrial,
	prepare,
	rollback,
	syncHome,
	trialExit,
	work,
} from "./update.ts";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".pdf": "application/pdf",
	".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8",
	".csv": "text/csv; charset=utf-8",
	".mp4": "video/mp4",
	".mov": "video/quicktime",
	".webm": "video/webm",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".zip": "application/zip",
	".heic": "image/heic",
};
const typeOf = (p: string) =>
	TYPES[extname(p).toLowerCase()] ?? "application/octet-stream";
// What a browser can show from /files/ without running anything in it. The
// rest downloads, since a page or SVG there would run on the server's origin
// with his cookie.
const SHOWN = new Set(
	[".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".heic"]
		.concat([".mp4", ".mov", ".webm", ".mp3", ".m4a", ".wav", ".pdf", ".txt"])
		.map((x) => TYPES[x]),
);
// Windows and macOS don't tell paths apart by case.
const fold = (x: string) =>
	WIN || process.platform === "darwin" ? x.toLowerCase() : x;
// The real path of p when it lies inside root, so a link or junction in
// there can't hand out a file from somewhere else.
const within = (root: string, p: string) => {
	let real: string;
	let top: string;
	try {
		real = realpathSync(p);
		top = realpathSync(root);
	} catch {
		return null;
	}
	return fold(real).startsWith(fold(top.endsWith(sep) ? top : `${top}${sep}`))
		? real
		: null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pkg = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

interface Shortcut {
	id: string;
	label: string;
	text: string;
}
// The agent edits shortcuts.json by hand too, so bad entries are dropped
// rather than failing the whole list.
const cleanShortcuts = (a: unknown): Shortcut[] | null =>
	!Array.isArray(a)
		? null
		: a
				.filter(
					(s) =>
						typeof s?.label === "string" &&
						typeof s?.text === "string" &&
						s.label.trim() &&
						s.text.trim(),
				)
				.slice(0, 50)
				.map((s) => ({
					id: typeof s.id === "string" && s.id ? s.id.slice(0, 64) : randomUUID(),
					label: s.label.trim().slice(0, 40),
					text: s.text.trim().slice(0, 2000),
				}));

const writeJson = (file: string, value: unknown) =>
	saveFile(file, `${JSON.stringify(value, null, 2)}\n`);

// Behind tailscale serve every request carries the Tailscale login it came
// from.
const login = (req: IncomingMessage) =>
	String(req.headers["tailscale-user-login"] ?? "");

const hasError = (b: unknown): b is { error: string } =>
	typeof b === "object" && b !== null && "error" in b && typeof b.error === "string";
// The Trash never prompts. Only Full Disk Access opens it.
const MAC_FOLDERS = ["Desktop", "Documents", "Downloads", ".Trash"];

const json = (res: ServerResponse, status: number, body: unknown) => {
	res.writeHead(status, {
		"content-type": "application/json",
		"cache-control": "no-store",
	});
	res.end(
		JSON.stringify(hasError(body) ? { ...body, error: words(body.error) } : body),
	);
};
const html = (res: ServerResponse, status: number, title: string, body: string) => {
	res.writeHead(status, {
		"content-type": TYPES[".html"],
		"cache-control": "no-store",
		"content-security-policy":
			"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
		"x-frame-options": "DENY",
	});
	res.end(
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${words(title)}</title><style>:root{color-scheme:light dark;--bg:light-dark(#f5f1ff,#100c1e);--ink:light-dark(#1a1530,#f0ebff);--primary:light-dark(#5a2ee6,#6b45f0);--link:light-dark(#4a20d6,#c4b2ff);--focus:light-dark(#5a2ee6,#c4b2ff)}body{font:18px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1.25rem;color:var(--ink);background:var(--bg)}h1{font-size:1.6rem;line-height:1.2;text-wrap:balance}a{color:var(--link);text-underline-offset:3px}a.btn{display:inline-block;min-height:48px;box-sizing:border-box;background:var(--primary);color:#fff;padding:.75rem 1.6rem;border-radius:2rem;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}::selection{background:var(--primary);color:#fff}img{width:100%;max-width:22rem;display:block;margin:1.5rem 0;border-radius:12px;image-rendering:pixelated}</style></head><body><main>${words(body)}</main></body></html>`,
	);
};

// Requests from a page in a browser, which has to say its body is JSON so a
// form or a no-cors fetch from another site can't pass for one.
const fromPage = new WeakSet<IncomingMessage>();

// The fields of a JSON request body. It can be any JSON value, and a field
// read from one that isn't an object is undefined or throws into the 400.
const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
	new Promise((ok, fail) => {
		if (
			fromPage.has(req) &&
			!/^application\/json\s*(;|$)/i.test(String(req.headers["content-type"] ?? ""))
		) {
			fail(new Error("Send the request body as application/json."));
			return;
		}
		let size = 0;
		const parts: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 256 * 1024) {
				fail(new Error("Request body is over 256 KB."));
				req.destroy();
				return;
			}
			parts.push(c);
		});
		req.on("end", () => {
			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
			} catch {
				fail(new Error("Request body is not JSON."));
				return;
			}
			ok(parsed);
		});
		req.on("error", fail);
	});

const sendFile = (
	res: ServerResponse,
	path: string,
	extra: Record<string, string> = {},
) => {
	const size = statSync(path).size;
	res.writeHead(200, {
		"content-type": typeOf(path),
		"content-length": size,
		...extra,
	});
	// A file deleted or locked after the stat errors the stream, and an error
	// nothing listens for would take the server down.
	pipeline(createReadStream(path), res, (e) => {
		if (e && e.code !== "ERR_STREAM_PREMATURE_CLOSE")
			console.error("sending a file:", e);
	});
};

// Memory lines from the phone, trimmed and capped.
const memoryLines = (a: unknown) =>
	Array.isArray(a)
		? a
				.filter((s) => typeof s === "string" && s.trim())
				.map((s: string) => s.trim().slice(0, 500))
				.slice(0, 100)
		: undefined;

type Route = (
	req: IncomingMessage,
	res: ServerResponse,
	url: URL,
	path: string,
) => unknown;

interface Check {
	ok: boolean;
	title: string;
	detail?: string;
	fix?: string;
}

interface Run {
	at: string;
	result: "ok" | "silent" | "failed" | "stopped";
	fails: number;
}
// How a scheduled run ended, from its done event.
const resultOf = (done: Record<string, unknown>, silent: boolean): Run["result"] => {
	if (done["stopped"]) return "stopped";
	if (!done["ok"]) return "failed";
	return silent ? "silent" : "ok";
};

// Free space and load move a little every minute, so only a change he'd
// notice goes out.
const glance = (m: Mac | null) =>
	m &&
	JSON.stringify([
		m.name,
		m.battery,
		Math.round(m.disk.free / 1e8),
		Math.round(m.memory.free / 1e8),
		Math.round(m.cpu / 5),
	]);

const SOURCE = dirname(dirname(fileURLToPath(import.meta.url)));
// What the child exits with when an update is ready and the agent is idle.
const INSTALL = 75;
// What it exits with when another program already has its port.
const PORT_TAKEN = 98;
// How long a pairing link from setup works.
const PAIR_LINK = 120_000;

if (setting("LAB_CHILD")) serve();
else supervise();

// Keeps one server child alive and holds off system sleep while on power
// for as long as this process lives.
function supervise() {
	const log = join(labDir(), "server.log");
	// On Windows cmd.exe holds the log open for its redirect, so cutting it
	// can fail. The next start that isn't redirected trims it instead.
	try {
		if (existsSync(log) && statSync(log).size > 5 * 1024 * 1024) truncateSync(log, 0);
	} catch (e) {
		console.error(
			`${new Date().toISOString()} couldn't trim the log: ${(e as Error).message}`,
		);
	}
	awake(true);

	let child: ReturnType<typeof spawn> | null = null;
	let quickExits = 0;
	let trialExits = 0;
	const later = (started: number, why: string) => {
		quickExits = Date.now() - started < 10_000 ? quickExits + 1 : 0;
		const wait = Math.min(2000 * 2 ** quickExits, 60_000);
		console.error(`${new Date().toISOString()} ${why}, restarting in ${wait / 1000}s`);
		setTimeout(run, wait);
	};
	const run = () => {
		const started = Date.now();
		// A half-applied update would only crash, so it goes back before the server starts.
		if (halfway(labDir()))
			try {
				rollback(SOURCE, labDir());
				console.error(
					`${new Date().toISOString()} an update didn't finish going in, so the version before it is back`,
				);
			} catch (e) {
				later(
					started,
					`couldn't put back the version from before an update (${(e as Error).message})`,
				);
				return;
			}
		const c = spawn(process.execPath, process.argv.slice(1), {
			env: { ...env, LAB_CHILD: "1" },
			stdio: "inherit",
		});
		child = c;
		// A child that never started has no exit to wait for.
		c.on("error", (e) => {
			if (c.pid !== undefined) return;
			child = null;
			later(started, `the server couldn't start (${e.message})`);
		});
		c.on("exit", (code, signal) => {
			child = null;
			const at = new Date().toISOString();
			if (code === INSTALL) {
				try {
					console.error(`${at} installed v${apply(SOURCE, labDir())}`);
					trialExits = 0;
				} catch (e) {
					console.error(
						`${at} the update didn't go in${halfway(labDir()) ? "" : ", so nothing changed"}: ${(e as Error).message}`,
					);
				}
				setTimeout(run, 500);
				return;
			}
			// This process still runs the code from before the update, so it can
			// put that back when the new server won't stay up.
			try {
				const t = trialExit(SOURCE, labDir(), code, trialExits);
				trialExits = t.fails;
				if (t.back)
					console.error(
						`${at} the update kept stopping, so the version before it is back`,
					);
			} catch (e) {
				console.error(
					`${at} couldn't put back the version from before the update: ${(e as Error).message}`,
				);
			}
			later(started, `server exited (${signal ?? code})`);
		});
	};
	run();
	for (const sig of ["SIGINT", "SIGTERM"] as const) {
		process.on(sig, () => {
			child?.kill(sig);
			process.exit(0);
		});
	}
}

async function serve() {
	// Loaded here so the supervisor never pays for the SDK.
	const { Lab } = await import("./lab.ts");
	const { Design, checkApp, published } = await import("./design.ts");
	const { mac, idle } = await import("./mac.ts");
	const { SignIn } = await import("./signin.ts");
	const { token, port, engine, relay } = config();
	const Home = home();
	const Dir = labDir();
	const appDir = join(Home, "app");
	const settingsFile = join(Home, "settings.json");
	const readSettings = () => {
		try {
			return cleanSettings(JSON.parse(readFileSync(settingsFile, "utf8")));
		} catch {
			return null;
		}
	};
	let settings: Settings = readSettings() ?? { ...DEFAULTS };
	// A model picked under Claude means nothing to Codex, so it only counts for
	// the engine it was picked on.
	const picked = () => {
		const { model, modelEngine } = settings;
		return (
			(typeof model === "string" &&
				model &&
				(!modelEngine || modelEngine === engine) &&
				model) ||
			setting("LAB_MODEL") ||
			undefined
		);
	};
	const lab = new Lab({
		home: Home,
		dir: Dir,
		model: picked(),
		...(engine === undefined ? {} : { engine }),
	});
	const prefs = () => {
		const { effort, replies } = settings;
		lab.setEffort(EFFORTS.find((e) => e === effort));
		lab.replies = typeof replies === "string" ? replies : "normal";
	};
	prefs();

	// The agent deletes with this, which moves files to the Trash.
	launchers(join(Dir, "bin"));

	// Codex has no send_to_phone tool, so it copies files in here instead.
	const toPhone = join(Home, "to-phone");
	// One that couldn't be sent or moved away stays put, and isn't tried
	// again every minute. A new file under the same name is tried again.
	const stuck = new Map<string, string>();
	const drop = async (name: string) => {
		const p = join(toPhone, name);
		if (name.startsWith(".") || !existsSync(p)) return;
		const st = statSync(p);
		const which = `${st.size} ${st.mtimeMs}`;
		if (!st.isFile() || stuck.get(name) === which) return;
		stuck.delete(name);
		if (!(await lab.sendDropped(p))) stuck.set(name, which);
	};
	const sending = new Set<string>();
	let watcher: ReturnType<typeof watch> | null = null;
	// Deleting the folder used to take the server down, so it's put back, and
	// watched again, whenever it goes missing.
	const sweep = () => {
		try {
			if (!existsSync(toPhone)) {
				watcher?.close();
				watcher = null;
			}
			mkdirSync(toPhone, { recursive: true });
			watcher ??= watch(toPhone, { persistent: false }, sweep).on("error", () => {
				watcher?.close();
				watcher = null;
			});
			const names = readdirSync(toPhone);
			for (const name of stuck.keys()) if (!names.includes(name)) stuck.delete(name);
			for (const name of names) {
				if (sending.has(name)) continue;
				sending.add(name);
				drop(name)
					.catch((e) => console.error("to-phone:", e))
					.finally(() => sending.delete(name));
			}
		} catch (e) {
			console.error("to-phone:", e);
		}
	};
	sweep();
	setInterval(sweep, 60_000).unref();
	try {
		const { held } = syncHome(
			Home,
			join(SOURCE, "computer", "template"),
			join(Dir, "home-base"),
			(dir) => checkApp(dir, undefined, published(join(Dir, "design-history"))),
		);
		if (held.length > 0)
			lab.note(
				`An update to The Lab changed ${held.join(", ")}, and those clash with changes made here, so they were left as they are. The update's versions are in .lab-update/ in the Lab folder. Bring their changes in, keeping his look, the next time he asks for something in the app.`,
			);
	} catch (e) {
		console.error("template update:", e);
	}
	// An update that changed the window's code builds it again. If the window
	// is open the build waits for the next start.
	if (desktopStale(SOURCE, Dir)) {
		const build = spawn(
			process.execPath,
			[join(SOURCE, "computer", "setup.ts"), "desktop", "--quiet"],
			{
				cwd: join(SOURCE, "computer"),
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let said = "";
		build.stdout.on("data", (d) => {
			said += d;
		});
		build.stderr.on("data", (d) => {
			said += d;
		});
		build.on("close", (status) => {
			if (status !== 0) console.error(`desktop window build: ${said.trim()}`);
		});
	}

	// A change to app/ that can't run stays on the computer. The agent hears why,
	// and he hears about it once the turn is over.
	let told = "";
	const Held = "Your last change to app/ was held back";
	const design = new Design(
		appDir,
		join(Dir, "design-history"),
		(version) => {
			lab.unnote(Held);
			lab.store.live({ kind: "design", version });
		},
		(problem) => lab.note(`${Held} from the phone because ${problem} Fix that first.`),
	);
	// A problem in app/ gets a repair turn of its own once the agent is free,
	// so the app heals without him asking. One try per problem and four a day,
	// so a fix that doesn't take can't go round and round.
	// ponytail: the count resets on a restart, keep it in state.json if a crash loop ever meets a broken app.
	const repairs: number[] = [];
	const tried = new Set<string>();
	const toRepair: string[] = [];
	const repair = (problem: string) => {
		const now = Date.now();
		while (now - (repairs[0] ?? now) > 86_400_000) repairs.shift();
		if (tried.has(problem) || repairs.length >= 4) return false;
		tried.add(problem);
		repairs.push(now);
		toRepair.push(problem);
		setImmediate(startRepair);
		return true;
	};
	const startRepair = () => {
		const problem = toRepair.shift();
		if (problem === undefined || lab.status.working) {
			if (problem !== undefined) toRepair.unshift(problem);
			return;
		}
		lab.send(
			`The app reported a problem: ${problem}\n\nFix it now without waiting for him. Read the change-the-app skill first, find the cause in app/ and make the smallest change that fixes it, written the way the code around it is written. Run check-app before you finish and fix everything it lists, since the phone only takes a version that passes. If the cause isn't in app/, change nothing. Then say in one sentence what was wrong and what you changed.`,
			randomUUID(),
			[],
			{
				label: "Self-Repair",
				quiet: true,
				about: "a repair the server started by itself",
				auto: true,
				shown: `Fixing a problem the app ran into: ${problem}`,
			},
		);
	};
	lab.store.listen((e) => {
		if (e.kind === "done") setImmediate(startRepair);
		if (e.kind !== "done" || !design.broken || told === design.broken) return;
		told = design.broken;
		if (repair(`a change to app/ was held back because ${design.broken}`)) return;
		// After this done has reached every listener, so it keeps the lower id.
		setImmediate(() =>
			lab.store.add({
				kind: "notice",
				text: "The last change to this app had a mistake in it, so your phone kept the version before. Ask for it again, or tap Fix It.",
				action: {
					label: "Fix It",
					send: "Your last change to the app had a mistake in it, so my phone kept the version before. Fix it and tell me what was wrong.",
				},
			}),
		);
	});

	// What the page on the phone reports going wrong, for the agent to fix.
	const errorsFile = join(Dir, "app-errors.log");
	let undoneTo: string | null = null;
	// Errors already passed on for the version the phone runs, at most 20 of
	// them, so a page throwing in a loop can't flood the agent.
	const reported = new Set<string>();
	let reportedFor = "";
	const bridge = readFileSync(new URL("./web-bridge.js", import.meta.url));
	const want = Buffer.from(token);
	// The agent can't read the token, so it checks a design change through
	// this link instead. It only reads, and never reaches the pairing QR, so it
	// can't answer its own Allow cards or pair a phone.
	const previewFile = join(Dir, "preview-link");
	const preview = Buffer.from(randomBytes(24).toString("base64url"));
	writeFileSync(
		previewFile,
		`http://127.0.0.1:${port}/pair?p=${preview}
`,
		{ mode: 0o600 },
	);

	let macNow = await mac().catch(() => null);
	setInterval(async () => {
		const was = glance(macNow);
		macNow = await mac().catch(() => macNow);
		if (macNow && glance(macNow) !== was) lab.store.live(macNow);
	}, 60_000).unref();

	// macOS asks before an app reads these, so the prompts come up while he's
	// at the computer setting up rather than partway through a task. A read
	// waits for his answer, so setup can wait on it too, and a refusal shows
	// in Check Setup rather than only when the agent gets there.
	const folders: Record<string, "asking" | "ok" | "refused"> = {};
	const askFolders = () =>
		Promise.all(
			MAC_FOLDERS.map(async (d) => {
				folders[d] ??= "asking";
				folders[d] = await readdir(join(homedir(), d)).then(
					() => "ok" as const,
					(e: NodeJS.ErrnoException) =>
						e.code === "EPERM" || e.code === "EACCES" ? "refused" : "ok",
				);
			}),
		);
	if (process.platform === "darwin") void askFolders();

	// While The Lab is open and in front on the computer and he's using it, the
	// phone doesn't buzz for what he can already see.
	let atMacUntil = 0;
	lab.store.atMac = () => Date.now() < atMacUntil;

	const shortcutsFile = join(Home, "shortcuts.json");
	const readShortcuts = () => {
		try {
			return cleanShortcuts(JSON.parse(readFileSync(shortcutsFile, "utf8")));
		} catch {
			return null;
		}
	};
	let shortcuts = readShortcuts() ?? [];
	let sent = JSON.stringify(shortcuts);
	const pushShortcuts = () => {
		if (JSON.stringify(shortcuts) === sent) return;
		sent = JSON.stringify(shortcuts);
		lab.store.live({ kind: "shortcuts", items: shortcuts });
	};
	let sentSettings = JSON.stringify(settings);
	const pushSettings = () => {
		lab.setModel(picked());
		prefs();
		if (JSON.stringify(settings) === sentSettings) return;
		sentSettings = JSON.stringify(settings);
		lab.store.live({ kind: "settings", values: settings });
	};
	const settle: Record<string, NodeJS.Timeout> = {};
	watch(Home, { persistent: false }, (_, name) => {
		if (name !== "shortcuts.json" && name !== "settings.json") return;
		clearTimeout(settle[name]);
		// A half-written or broken file keeps the last good one.
		settle[name] = setTimeout(() => {
			if (name === "shortcuts.json") {
				shortcuts = readShortcuts() ?? shortcuts;
				pushShortcuts();
			} else {
				settings = readSettings() ?? settings;
				pushSettings();
			}
		}, 300);
	}).on("error", (e) => console.error("Lab folder watch:", e));

	// ---------- schedules ----------

	const schedulesFile = join(Home, "schedules.json");
	const ranFile = join(Dir, "schedules-ran.json");
	let ran: {
		keys: string[];
		first: Record<string, string>;
		checked?: string;
		last: Record<string, Run>;
	} = { keys: [], first: {}, last: {} };
	try {
		const { known, ...saved } = JSON.parse(readFileSync(ranFile, "utf8"));
		ran = { ...ran, ...saved };
		// An older file lists only the ids, and those count as seen long ago.
		if (Array.isArray(known) && !saved.first)
			ran.first = Object.fromEntries(
				known.map((id) => [String(id), new Date(0).toISOString()]),
			);
	} catch {
		/* nothing has run yet */
	}
	const saveRan = () => writeJson(ranFile, ran);
	let schedules: Schedule[] = [];
	const readSchedules = () => {
		if (!existsSync(schedulesFile)) {
			schedules = [];
			return;
		}
		try {
			schedules =
				cleanSchedules(JSON.parse(readFileSync(schedulesFile, "utf8"))) ?? schedules;
		} catch {
			/* a broken file keeps the last good list */
		}
	};
	// The you event of each scheduled run still going, so its done can be
	// put down as that entry's last result.
	const running = new Map<number, string>();
	let silentSeen = false;
	lab.store.listen((e) => {
		if (!("id" in e)) return;
		if (e.kind === "reply" && e["silent"]) silentSeen = true;
		if (e.kind !== "done") return;
		for (const [you, id] of running) {
			if (e["upto"] && you > Number(e["upto"])) continue;
			running.delete(you);
			const prev = ran.last[id];
			const result = resultOf(e, silentSeen);
			const fails = result === "failed" ? (prev?.fails ?? 0) + 1 : 0;
			ran.last[id] = { at: e.at, result, fails };
			const item = schedules.find((s) => s.id === id);
			// Once, at the third, rather than every time after.
			if (fails === 3 && item)
				lab.store.add({
					kind: "notice",
					text: `"${item.label}" has failed three times in a row. Ask the agent to look into it, or pause it under Schedules.`,
				});
		}
		silentSeen = false;
		saveRan();
	});

	const tick = () => {
		readSchedules();
		const now = new Date();
		const first = firstSeen(schedules, ran.first, now);
		const changed = JSON.stringify(first) !== JSON.stringify(ran.first);
		ran = { ...ran, first };
		// The page hangs every event on the newest turn, so a run mid-request
		// would take over the one he's in. It isn't marked as run, so it goes
		// on the first idle tick inside the grace window.
		if (lab.status.working) {
			if (changed) saveRan();
			return;
		}
		const keys = new Set(ran.keys);
		// Runs too late to send now. Nothing is replayed, he just hears about it.
		for (const m of ran.checked
			? missed(schedules, new Date(Date.parse(ran.checked) - GRACE), now, keys, first)
			: []) {
			keys.add(m.key);
			const when = m.at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
			const after = next(m.item, now);
			lab.store.add({
				kind: "notice",
				text: `"${m.item.label}" didn't run at ${when}, because the computer was asleep, off or busy. ${after ? `It runs next ${after.toDateString() === now.toDateString() ? "today" : `on ${after.toLocaleDateString([], { weekday: "long" })}`} at ${after.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "It won't run again."}`,
				action: { label: "Run It Now", send: m.item.text },
			});
		}
		for (const { item, key } of due(schedules, now, keys, first)) {
			keys.add(key);
			lab.send(item.text, randomUUID(), [], {
				label: item.label,
				...(item.quiet === undefined ? {} : { quiet: item.quiet }),
			});
			const you = lab.store.events.findLast((e) => e.kind === "you");
			if (you) running.set(you.id, item.id);
			// The page shows one run at a time, so the rest wait for the next tick.
			break;
		}
		ran = { ...ran, keys: [...keys].slice(-500), checked: now.toISOString() };
		saveRan();
	};
	setInterval(() => {
		try {
			tick();
		} catch (e) {
			console.error("schedules:", e);
		}
	}, 20_000).unref();

	const scheduleView = () => {
		readSchedules();
		const now = new Date();
		return schedules.map((s) => withRuns(s, now));
	};
	// A copy, as the list itself is what runs.
	const withRuns = (s: Schedule, now: Date) => ({
		...s,
		next: next(s, now)?.toISOString() ?? null,
		last: ran.last[s.id] ?? null,
	});

	// ---------- pairing ----------

	// One-time codes. A scanned QR code turns into a second, shorter-lived
	// code the app trades for the token, so the token itself never sits in
	// the phone browser's history.
	const codes = new Map<string, { until: number; kind: "scan" | "claim" }>();
	const code = (kind: "scan" | "claim", ms: number) => {
		const c = randomBytes(12).toString("base64url");
		codes.set(c, { until: Date.now() + ms, kind });
		return c;
	};
	const spend = (c: string, kind: "scan" | "claim") => {
		const got = codes.get(c);
		codes.delete(c);
		return got !== undefined && got.kind === kind && got.until > Date.now();
	};
	const urlFile = join(Dir, "url");
	// Pairing links setup has opened, by the time each was made. One works
	// once, within 2 minutes of when it was made.
	const usedLinks = new Set<number>();

	const tunnel = startTunnel({
		dir: Dir,
		port,
		relay,
		lanPort: port + 1,
		lanHost: setting("LAB_LAN_HOST"),
	});
	const reach = () => ({
		kind: "reach" as const,
		lan: tunnel.spec().lan,
		relay: relay ?? null,
	});
	// Whether a phone has The Lab connected right now, for the desktop's Phone
	// panel. The phone's own client is OkHttp, and setup's checks use the same
	// token from Node, so the user agent is what tells them apart.
	let phones = 0;
	const phoneNow = () => ({
		kind: "phone" as const,
		online: phones > 0,
		seen: lab.state.phoneSeen ?? null,
		relay: tunnel.state.relay,
	});
	// Everything the phone needs to find and trust this computer. The Pixel
	// camera opens a thelab:// link straight into the app (it won't follow an
	// intent:// one), so none of it passes through a web page.
	const pairLink = (claim: string) => {
		const s = tunnel.spec();
		return `thelab://pair?${new URLSearchParams({ r: s.relay ?? "", o: s.room, k: s.key, p: s.pass, l: s.lan.join(","), c: claim })}`;
	};

	// The phone's Tailscale login is kept at the first visit, and a request
	// from any other login is turned away even with the right token.
	const sameLogin = (req: IncomingMessage) => {
		const who = login(req);
		if (!who) return true;
		if (!lab.state.login) {
			lab.state.login = who;
			lab.save();
		}
		return lab.state.login === who;
	};

	// The phone and the window's shells send the token as a Bearer header. A
	// browser has the cookie from a pairing link instead.
	const authed = (req: IncomingMessage): "bearer" | "cookie" | null => {
		const h = req.headers.authorization ?? "";
		const bearer = h.startsWith("Bearer ");
		const cookie = /(?:^|;\s*)lab=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "";
		const got = Buffer.from(bearer ? h.slice(7) : decodeURIComponent(cookie));
		if (!(got.length === want.length && timingSafeEqual(got, want) && sameLogin(req)))
			return null;
		return bearer ? "bearer" : "cookie";
	};
	// A browser sends the cookie to any page that names this address, so it
	// only counts from The Lab's own page, reached by its own name.
	const own = [`127.0.0.1:${port}`, `localhost:${port}`];
	const ownPage = (req: IncomingMessage) => {
		if (!own.includes(req.headers.host ?? ""))
			return `Open The Lab at http://127.0.0.1:${port} instead.`;
		if (
			req.method !== "GET" &&
			req.method !== "HEAD" &&
			!own.some((h) => req.headers.origin === `http://${h}`)
		)
			return "Only The Lab's own page can change things here.";
		fromPage.add(req);
		return null;
	};
	// Only the shells hold the token itself. A page has the cookie at most, and
	// the agent can rewrite the page, so answering a question needs the token.
	const bearer = (req: IncomingMessage) =>
		(req.headers.authorization ?? "").startsWith("Bearer ") && authed(req);
	const previewing = (req: IncomingMessage, path: string) => {
		const got = Buffer.from(
			decodeURIComponent(
				/(?:^|;\s*)labp=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "",
			),
		);
		return (
			req.method === "GET" &&
			path !== "/pair-phone" &&
			got.length === preview.length &&
			timingSafeEqual(got, preview)
		);
	};

	const events = (req: IncomingMessage, res: ServerResponse, url: URL) => {
		const raw = req.headers["last-event-id"] ?? url.searchParams.get("after");
		const after = raw === undefined || raw === null || raw === "" ? null : Number(raw);
		res.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-store",
			connection: "keep-alive",
			"x-accel-buffering": "no",
		});
		res.write(
			`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ server: pkg.version, design: design.version, status: lab.status, last: lab.store.last, mac: macNow, shortcuts, live: [{ kind: "settings", values: settings }, reach(), phoneNow()] })}\n\n`,
		);
		const phone = /okhttp/i.test(req.headers["user-agent"] ?? "");
		if (phone && ++phones === 1) lab.store.live(phoneNow());
		// Replay and subscribe in the same tick, so nothing can land in between.
		for (const e of lab.store.since(Number.isFinite(after) ? after : null))
			res.write(`id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`);
		res.write("event: loaded\ndata: {}\n\n");
		// A phone that went quiet without closing would otherwise have every
		// event pile up here. Ending it costs nothing, since it picks up from
		// its last id when it's back.
		const send = (s: string) =>
			res.writableLength > 8 * 1024 * 1024 ? res.destroy() : res.write(s);
		const off = lab.store.listen((e) =>
			send(
				"id" in e
					? `id: ${e.id}\ndata: ${JSON.stringify(e)}\n\n`
					: `data: ${JSON.stringify(e)}\n\n`,
			),
		);
		const ping = setInterval(() => send(": ping\n\n"), 25_000);
		req.on("close", () => {
			off();
			clearInterval(ping);
			if (!phone) return;
			lab.state.phoneSeen = new Date().toISOString();
			lab.save();
			if (--phones === 0) lab.store.live(phoneNow());
		});
	};

	const signIn = new SignIn(lab, engine ?? "claude", Home);
	// A task running is proof enough, and fails by itself if it isn't.
	const watchSignIn = () => {
		if (!lab.status.working)
			signIn.check().catch((e) => console.error("sign-in check:", e));
	};
	setTimeout(watchSignIn, 60_000).unref();
	setInterval(watchSignIn, 3_600_000).unref();

	// What the Check Setup button reports, in his words.
	const check = async () => {
		const checks = await import("./checks.ts");
		const out: Check[] = [
			{ ok: true, title: `The Lab ${pkg.version} is running on the computer` },
		];
		const now = await signIn.check();
		// Offline it can't really tell, so this goes by what's saved.
		const signed =
			now === "unknown"
				? engine === "codex"
					? checks.codexSignedIn()
					: checks.claudeSignedIn().loggedIn
				: now === "in";
		out.push(
			signed
				? {
						ok: true,
						title: `Signed in to ${engine === "codex" ? "ChatGPT" : "Claude"}`,
					}
				: {
						ok: false,
						title: `Signed out of ${engine === "codex" ? "ChatGPT" : "Claude"}`,
						detail: "Tap Fix to sign back in from here.",
						fix: "signin",
					},
		);
		out.push(...reachChecks(checks.tailscaleState), ...(await computerChecks()));
		return out;
	};
	// How the phone can reach the computer.
	const reachChecks = (state: typeof tailscaleState) => {
		const out: Check[] = [];
		const t = tunnel.state;
		if (t.relay === "connected")
			out.push({
				ok: true,
				title:
					"Connected to the relay, so the phone can reach the computer from anywhere",
			});
		else if (t.relay === "off")
			out.push({
				ok: false,
				title: "No relay is set up",
				detail: existsSync(urlFile)
					? "The phone reaches the computer on the same Wi-Fi or through Tailscale. Ask the agent on the computer to set up the relay so it works everywhere."
					: "The phone only reaches the computer on the same Wi-Fi. Ask the agent on the computer to set up the relay so it works everywhere.",
			});
		else
			out.push({
				ok: false,
				title: "Can't reach the relay",
				detail: `The phone can still reach the computer on the same Wi-Fi. The relay link is ${t.relay}.`,
			});
		out.push(
			t.lan === "on"
				? { ok: true, title: "Listening on the local network" }
				: {
						ok: false,
						title: "Not listening on the local network",
						detail: `The phone can't reach the computer directly on the same Wi-Fi (${t.lan}).`,
					},
		);
		if (existsSync(urlFile)) {
			const ts = state();
			out.push(
				ts.installed && "running" in ts && ts.running
					? { ok: true, title: "Tailscale is running on the computer" }
					: {
							ok: false,
							title: "Tailscale is off on the computer",
							detail:
								"The relay and the local network still work. Open Tailscale and sign in to use it too.",
						},
			);
		}
		return out;
	};
	// Whether the computer itself will keep The Lab going.
	const computerChecks = async () => {
		const out: Check[] = [];
		const m = await mac().catch(() => null);
		if (m?.battery && !m.battery.charging)
			out.push({
				ok: false,
				title: `The computer is on battery (${m.battery.percent}%)`,
				detail: "It will go to sleep when idle. Plug it in to keep The Lab going.",
			});
		if (m && m.disk.free < 5e9)
			out.push({
				ok: false,
				title: "The computer is nearly out of space",
				detail: "Ask the agent what is taking up room.",
			});
		if (process.platform === "darwin")
			out.push(
				lab.snapshotAt
					? { ok: true, title: "Time Machine snapshots are working" }
					: {
							ok: false,
							title: "No Time Machine snapshot yet",
							detail:
								"One is taken before each task. If this stays, turn on Time Machine in System Settings.",
						},
			);
		const refused = MAC_FOLDERS.filter(
			(d) => d !== ".Trash" && folders[d] === "refused",
		);
		if (refused.length > 0)
			out.push({
				ok: false,
				title: `The agent can't see your ${refused.join(" or ")} folder${refused.length > 1 ? "s" : ""}`,
				detail: `On the Mac, open System Settings, Privacy & Security, Files and Folders, and switch ${refused.length > 1 ? "them" : "it"} on under The Lab.`,
			});
		if (folders[".Trash"] === "refused")
			out.push({
				ok: false,
				title: "The agent can't put things back from the Trash",
				detail:
					"On the Mac, open System Settings, Privacy & Security, Full Disk Access, and switch on The Lab.",
			});
		const mem = lab.memory();
		if (mem.chars > mem.cap * 0.8)
			out.push({
				ok: false,
				title: "Memory is nearly full",
				detail: "Open Memory and remove what is no longer true.",
			});
		return out;
	};

	// Scanned from the QR code on the phone, inside Tailscale.
	const pairScan = (req: IncomingMessage, res: ServerResponse, c: string) => {
		if (!spend(c, "scan"))
			return html(
				res,
				410,
				"Pairing Link Used",
				"<h1>That Code Has Expired</h1><p>Each code works once, for 10 minutes. Ask the agent on the computer for a new one.</p>",
			);
		const base = existsSync(urlFile)
			? readFileSync(urlFile, "utf8").trim()
			: `https://${req.headers.host}`;
		const claim = code("claim", 120_000);
		const intent = `intent://pair?u=${encodeURIComponent(base)}&c=${claim}#Intent;scheme=thelab;package=com.somethingobvious.thelab;end`;
		return html(
			res,
			200,
			"Pair The Lab",
			`<h1>Pair This Phone With Your Computer</h1><p>Tap the button to open The Lab and finish pairing.</p><p><a class="btn" href="${intent}">Open The Lab</a></p>`,
		);
	};
	const pair: Route = (req, res, url) => {
		const c = url.searchParams.get("c");
		if (c !== null) return pairScan(req, res, c);
		const pv = Buffer.from(url.searchParams.get("p") ?? "");
		if (pv.length > 0) {
			if (pv.length !== preview.length || !timingSafeEqual(pv, preview))
				return json(res, 401, {
					error: "That preview link is from before a restart. Read preview-link again.",
				});
			res.writeHead(303, {
				"set-cookie": `labp=${preview}; HttpOnly; SameSite=Strict; Path=/`,
				location: "/",
			});
			return res.end();
		}
		const [at = "", sig = ""] = (url.searchParams.get("k") ?? "").split(".");
		const made = /^\d{1,15}$/.test(at) ? Number(at) : Number.NaN;
		const good = Buffer.from(
			createHmac("sha256", token).update(`the-lab pair ${at}`).digest("hex"),
		);
		for (const u of usedLinks)
			if (Math.abs(Date.now() - u) > PAIR_LINK) usedLinks.delete(u);
		if (
			!(Math.abs(Date.now() - made) <= PAIR_LINK) ||
			usedLinks.has(made) ||
			Buffer.from(sig).length !== good.length ||
			!timingSafeEqual(Buffer.from(sig), good)
		)
			return json(res, 401, {
				error:
					"That pairing link has expired or was already used. Run node setup.ts pair for a new one.",
			});
		usedLinks.add(made);
		const nextPath =
			url.searchParams.get("next") === "/pair-phone" ? "/pair-phone" : "/";
		res.writeHead(303, {
			"set-cookie": `lab=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
			location: nextPath,
		});
		return res.end();
	};

	// Routes that answer before the token is checked, keyed by method and
	// path, with * for any method.
	const open = new Map<string, Route>([
		["* /health", (_req, res) => json(res, 200, { ok: true, server: pkg.version })],
		["GET /pair", pair],
		[
			"POST /pair/claim",
			async (req, res) => {
				const { code: c } = await readBody(req);
				if (typeof c !== "string" || !spend(c, "claim"))
					return json(res, 410, {
						error: "That pairing code has expired. Scan a new one on the computer.",
					});
				if (login(req)) {
					lab.state.login = login(req);
					lab.save();
				}
				return json(res, 200, { token });
			},
		],
	]);

	const pairPhone: Route = async (req, res) => {
		// Only a page opened in a window gets a code, never a script's fetch
		// or a frame, as whoever holds the code can pair and get the token.
		if (
			req.headers["sec-fetch-mode"] !== "navigate" ||
			req.headers["sec-fetch-dest"] !== "document"
		)
			return json(res, 403, { error: "Open the pairing page in a window." });
		// Without a relay or Tailscale the code still pairs over the Wi-Fi.
		const tailscale = !relay && existsSync(urlFile);
		if (!(relay || tailscale || tunnel.spec().lan.length > 0))
			return html(
				res,
				409,
				"Pair a Phone",
				"<h1>The Computer Isn't on a Network</h1><p>Connect the computer to Wi-Fi and reload this page, or pair the phone over its USB cable instead.</p>",
			);
		const { qrSvg } = await import("./qr.ts");
		const link = tailscale
			? `${readFileSync(urlFile, "utf8").trim()}/pair?c=${code("scan", 10 * 60_000)}`
			: pairLink(code("claim", 10 * 60_000));
		const img = `data:image/svg+xml;base64,${Buffer.from(qrSvg(link)).toString("base64")}`;
		const how = relay
			? "Tap the link the camera finds and The Lab opens."
			: tailscale
				? "Turn on Tailscale on the phone first."
				: "The phone has to be on the same Wi-Fi as the computer. Tap the link the camera finds and The Lab opens.";
		return html(
			res,
			200,
			"Pair a Phone",
			`<h1>Point the Phone's Camera at This</h1><p>${how} The code works once and lasts 10 minutes.</p><img src="${img}" alt="Pairing code for The Lab, for the phone's camera"><p><a class="btn" href="/pair-phone">New Code</a></p>`,
		);
	};

	const send: Route = async (req, res) => {
		const { text, cid, files } = await readBody(req);
		const attached = files === undefined ? [] : lab.attached(files);
		if (
			typeof text !== "string" ||
			text.length > 50_000 ||
			!(text.trim() || attached.length > 0)
		)
			return json(res, 400, {
				error: "A message needs text (up to 50,000 characters) or a file.",
			});
		if (typeof cid !== "string" || !UUID.test(cid))
			return json(res, 400, {
				error: `cid must be a UUID, got ${JSON.stringify(cid)}.`,
			});
		return json(res, 202, {
			accepted: lab.send(text.trim(), cid.toLowerCase(), attached),
		});
	};

	const memory: Route = async (req, res) => {
		if (req.method !== "POST") return json(res, 200, lab.memory());
		const b = await readBody(req);
		const about = memoryLines(b["about"]);
		const notes = memoryLines(b["notes"]);
		const paused = b["paused"];
		return json(
			res,
			200,
			lab.saveMemory({
				...(about === undefined ? {} : { about }),
				...(notes === undefined ? {} : { notes }),
				...(typeof paused === "boolean" ? { paused } : {}),
			}),
		);
	};

	// The page shows where each rule applies, so the agent's own folder gets a name.
	const ruleWhere = (cwd: string) => {
		if (cwd === Home) return "In your Lab folder";
		if (cwd.startsWith(`${Home}${sep}`))
			return `In ${cwd.slice(Home.length + 1)} in your Lab folder`;
		return `In ${cwd}`;
	};
	const allowed: Route = async (req, res) => {
		if (req.method === "POST") {
			const { remove } = await readBody(req);
			if (
				typeof remove !== "number" ||
				!Number.isInteger(remove) ||
				remove < 0 ||
				remove >= lab.rules.length
			)
				return json(res, 400, {
					error: `remove has to be the place of a rule in the list, and ${JSON.stringify(remove)} isn't one. Reload the list and try again.`,
				});
			const [rule] = lab.rules.splice(remove, 1);
			// Gone here but still on disk would bring it back after a restart.
			if (rule && !lab.saveRules()) {
				lab.rules.splice(remove, 0, rule);
				return json(res, 500, {
					error:
						"Couldn't save the change, so the command is still allowed. Try again.",
				});
			}
		}
		return json(res, 200, {
			items: lab.rules.map((r) => ({ ...r, where: ruleWhere(r.cwd) })),
		});
	};

	const chooseModel: Route = async (req, res) => {
		const { model } = await readBody(req);
		if (
			model !== null &&
			(typeof model !== "string" || !/^[\w.:/@[\]-]{1,120}$/.test(model))
		)
			return json(res, 400, {
				error: `That isn't a model name: ${JSON.stringify(model)}.`,
			});
		settings =
			cleanSettings({
				...settings,
				model: model === "default" ? null : model,
				modelEngine: model && model !== "default" ? engine : null,
			}) ?? settings;
		writeJson(settingsFile, settings);
		pushSettings();
		return json(res, 200, { chosen: settings["model"] });
	};

	const appError: Route = async (req, res) => {
		const { message, where, version, fatal } = await readBody(req);
		const text = String(message ?? "").slice(0, 500);
		// Reports from an older version of the app are already gone.
		if (!text || (version && version !== design.version)) return json(res, 200, {});
		if (reportedFor !== design.version) {
			reported.clear();
			reportedFor = design.version;
		}
		appendFileSync(
			errorsFile,
			`${new Date().toISOString()} ${design.version} ${String(where ?? "").slice(0, 80)} ${text}\n`,
		);
		if (statSync(errorsFile).size > 1024 * 1024) truncateSync(errorsFile, 0);
		if (fatal === true && version === undoneTo) {
			lab.note(
				`The phone still couldn't open the app after the server put the earlier version back (${text}), so it left it there. The cause may be on the phone, not in app/.`,
			);
		} else if (fatal === true && design.undo()) {
			undoneTo = design.version;
			lab.store.add({
				kind: "notice",
				text: "The last change to this app didn't open on your phone, so the version before it is back.",
			});
			lab.note(
				`Your last change to app/ stopped the phone app from opening (${text}), so the server put the version before it back. Find what broke before trying again.`,
			);
			repair(
				`the last change to app/ stopped the app from opening (${text}), so the version before it is back. Find what broke, then make that change again so it works`,
			);
		} else if (!reported.has(text) && reported.size < 20) {
			reported.add(text);
			lab.note(
				`The phone app hit an error in ${String(where ?? "the page").slice(0, 80)}: "${text}". If it comes from a change you made to app/, fix it.`,
			);
			repair(`${String(where ?? "the page").slice(0, 80)} threw "${text}"`);
		}
		return json(res, 200, {});
	};

	// Updates come from GitHub with no agent involved. A release is merged,
	// installed and tested in update/trial, then put in while the agent is idle.
	let update: Live & { kind: "update" } = {
		kind: "update",
		state: "idle",
		current: pkg.version,
	};
	const setUpdate = (change: Record<string, unknown>) => {
		update = { ...update, ...change, at: new Date().toISOString() };
		lab.store.live(update);
	};
	let preparing: Promise<void> | null = null;
	const checkUpdate = () => {
		preparing ??= (async () => {
			try {
				setUpdate({ state: "checking", detail: "" });
				const v = await latest(pkg.version);
				if (!v || v === bad(Dir)) {
					setUpdate({
						state: "current",
						version: null,
						detail: v
							? `v${v} kept stopping on this computer, so the version before it is back. The next release tries again.`
							: "",
					});
					return;
				}
				setUpdate({ state: "preparing", version: v, detail: "Downloading" });
				await prepare(v, SOURCE, Dir, (detail) => setUpdate({ detail }));
				setUpdate({ state: "ready", detail: "" });
				installWhenIdle();
			} catch (e) {
				setUpdate({ state: "failed", detail: (e as Error).message });
			} finally {
				preparing = null;
			}
		})();
		return preparing;
	};
	const install = () => {
		if (update["state"] !== "ready" || lab.status.working) return false;
		setUpdate({ state: "installing", detail: "" });
		lab.save();
		setTimeout(() => process.exit(INSTALL), 300);
		return true;
	};
	const installWhenIdle = () => {
		if (settings["autoUpdate"] !== false) install();
	};
	lab.store.listen((e) => {
		if (e.kind === "done" && update["state"] === "ready")
			setTimeout(installWhenIdle, 60_000);
	});
	setTimeout(checkUpdate, 2 * 60_000).unref();
	setInterval(checkUpdate, 12 * 3_600_000).unref();
	if (onTrial(Dir))
		setTimeout(() => {
			const t = confirm(Dir);
			if (!t) return;
			lab.store.add({
				kind: "notice",
				text: `The Lab updated itself to v${t.version}.${t.conflicts.length > 0 ? ` Changes made on this computer to ${t.conflicts.slice(0, 3).join(", ")} clashed with it, so the release's version is in and the old one is kept in ${join(work(Dir), "conflicts")}.` : ""}`,
			});
		}, 120_000).unref();

	const rename: Route = async (req, res) => {
		const { name } = await readBody(req);
		if (typeof name !== "string" || name.trim().length > 40)
			return json(res, 400, { error: "A name has to be 40 characters or fewer." });
		// A blank name goes back to the one the computer calls itself.
		setConfig({ name: name.trim() || undefined });
		macNow = await mac().catch(() => macNow);
		if (macNow) lab.store.live(macNow);
		return json(res, 200, { name: macNow?.name ?? name.trim() });
	};

	// Routes that need the token or the preview link.
	const routes = new Map<string, Route>([
		["GET /pair-phone", pairPhone],
		["GET /events", (req, res, url) => events(req, res, url)],
		["POST /send", send],
		[
			"POST /upload",
			async (req, res, url) => {
				const name = url.searchParams.get("name") ?? "";
				const given = String(req.headers["content-type"] ?? "").split(";")[0];
				const type =
					given && given !== "application/octet-stream" ? given : typeOf(name);
				return json(res, 200, await lab.upload(name, type, req));
			},
		],
		[
			"POST /to-phone",
			async (req, res, url) => {
				const name = url.searchParams.get("name") ?? "";
				const given = String(req.headers["content-type"] ?? "").split(";")[0];
				const type =
					given && given !== "application/octet-stream" ? given : typeOf(name);
				return json(res, 200, await lab.toPhone(name, type, req));
			},
		],
		[
			"POST /shortcuts",
			async (req, res) => {
				const items = cleanShortcuts((await readBody(req))["items"]);
				if (!items)
					return json(res, 400, { error: "items must be a list of { label, text }." });
				writeJson(shortcutsFile, items);
				shortcuts = items;
				pushShortcuts();
				return json(res, 200, { items });
			},
		],
		[
			"POST /stop",
			async (_req, res) => {
				await lab.stop();
				return json(res, 202, {});
			},
		],
		// Setup calls this after an update or a new relay. The supervisor
		// starts a fresh child, which reads the new code and config.
		["GET /update", (_req, res) => json(res, 200, update)],
		[
			"POST /update",
			async (req, res) => {
				const { action } = await readBody(req);
				if (action === "install")
					return install()
						? json(res, 202, update)
						: json(res, 409, {
								error:
									update["state"] === "ready"
										? "The agent is working, so the update goes in once it's done."
										: "There's no update ready to install.",
							});
				checkUpdate();
				return json(res, 202, update);
			},
		],
		[
			"POST /restart",
			(_req, res) => {
				json(res, 202, {});
				setTimeout(() => process.exit(0), 200);
			},
		],
		[
			"POST /answer",
			async (req, res) => {
				if (!bearer(req))
					return json(res, 403, {
						error: "Answer this on your phone or in The Lab window.",
					});
				const { ref, allow, always } = await readBody(req);
				return lab.answer(String(ref), allow === true, always === true)
					? json(res, 200, {})
					: json(res, 404, {
							error: "That question was already answered or has expired.",
						});
			},
		],
		["* /memory", memory],
		[
			"* /schedules",
			async (req, res) => {
				if (req.method === "POST") {
					const items = cleanSchedules((await readBody(req))["items"]);
					if (!items)
						return json(res, 400, {
							error: "items must be a list of { label, text, time }.",
						});
					writeJson(schedulesFile, items);
					schedules = items;
				}
				return json(res, 200, { items: scheduleView() });
			},
		],
		["* /allowed", allowed],
		[
			"* /settings",
			async (req, res) => {
				if (req.method === "POST") {
					const { values } = await readBody(req);
					const cleaned = cleanSettings({
						...settings,
						...(values && typeof values === "object" ? values : {}),
					});
					if (!cleaned)
						return json(res, 400, { error: "values must be an object of settings." });
					writeJson(settingsFile, cleaned);
					settings = cleaned;
					pushSettings();
				}
				return json(res, 200, { values: settings });
			},
		],
		[
			"GET /models",
			async (_req, res, url) =>
				json(
					res,
					200,
					// A list saved under the other engine names the wrong models.
					(url.searchParams.has("saved") &&
						lab.state.models?.engine === (engine ?? "claude") &&
						lab.state.models) ||
						(await lab.models()),
				),
		],
		["POST /model", chooseModel],
		[
			"POST /mode",
			async (req, res) => {
				const { mode } = await readBody(req);
				const to = ASK_MODES.find((m) => m === mode);
				if (!to)
					return json(res, 400, {
						error: `That isn't a mode: ${JSON.stringify(mode)}.`,
					});
				// Asking more takes effect now. Asking less waits for his Allow.
				if (ASK_MODES.indexOf(to) <= ASK_MODES.indexOf(lab.mode)) {
					lab.setMode(to);
					return json(res, 200, { mode: to });
				}
				return json(res, 202, { mode: lab.mode, asking: to, ref: lab.askMode(to) });
			},
		],
		["POST /app-error", appError],
		["GET /folders", (_req, res) => json(res, 200, folders)],
		[
			"POST /folders",
			async (_req, res) => {
				await askFolders();
				return json(res, 200, folders);
			},
		],
		["POST /name", rename],
		[
			"GET /mac",
			async (_req, res) => {
				// Someone has the app in front of them, so every change goes out.
				macNow = await mac().catch(() => macNow);
				if (macNow) lab.store.live(macNow);
				return json(res, 200, {});
			},
		],
		[
			"POST /signin",
			// The phone gives a request 8 seconds and an engine can take longer to
			// start, so the page asks again until this has the address.
			async (_req, res) =>
				json(
					res,
					200,
					await Promise.race([
						signIn.begin(),
						sleep(6000, { waiting: true }, { ref: false }),
					]),
				),
		],
		[
			"POST /signin/code",
			async (req, res) => {
				const { code: pasted } = await readBody(req);
				const clean = typeof pasted === "string" ? pasted.trim() : "";
				if (!clean || clean.length > 4096 || /\s/.test(clean))
					return json(res, 400, { error: "That doesn't look like a sign-in code." });
				await signIn.paste(clean);
				return json(res, 200, {});
			},
		],
		[
			"POST /signin/resend",
			async (_req, res) => json(res, 200, { sent: lab.resend() }),
		],
		[
			"GET /check",
			async (_req, res) => {
				const items = await check();
				for (const i of items) {
					i.title = words(i.title);
					if (i.detail) i.detail = words(i.detail);
				}
				return json(res, 200, { items });
			},
		],
		[
			"POST /presence",
			async (_req, res) => {
				// Only counts when someone is actually at the keyboard, so a browser
				// tab left open in front doesn't silence the phone all evening.
				if ((await idle().catch(() => Number.POSITIVE_INFINITY)) < 120)
					atMacUntil = Date.now() + 45_000;
				return json(res, 200, {});
			},
		],
		["GET /design", (_req, res) => json(res, 200, design.bundle())],
		[
			"POST /design/undo",
			(_req, res) => json(res, design.undo() ? 200 : 409, { version: design.version }),
		],
		[
			"GET /web-bridge.js",
			(_req, res) => {
				res.writeHead(200, {
					"content-type": TYPES[".js"],
					"cache-control": "no-store",
				});
				return res.end(bridge);
			},
		],
	]);

	const question: Route = (_req, res, _url, path) => {
		const ref = path.slice(6);
		const card = lab.question(ref);
		if (!card)
			return json(res, 404, {
				error: "That question was already answered or has expired.",
			});
		const { always, ...shown } = card;
		return json(res, 200, { ref, ...shown, always: Boolean(always) });
	};
	const filesDir = join(Dir, "files");
	const stored: Route = (_req, res, _url, path) => {
		const found = lab.fileFor(path.slice(7));
		const p = found && within(filesDir, found);
		if (!p) return json(res, 404, { error: "That file is gone." });
		const type = typeOf(p);
		return sendFile(res, p, {
			"cache-control": "private, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			// A sandboxed PDF won't open in Chrome or Safari, and their viewers
			// don't run its script on this origin anyway.
			...(type === TYPES[".pdf"]
				? {}
				: {
						"content-security-policy":
							"sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
					}),
			...(SHOWN.has(type) ? {} : { "content-disposition": "attachment" }),
		});
	};
	// The desktop view of the same app, for checking a design change on
	// the computer itself.
	const desktop: Route = (_req, res, _url, path) => {
		const p = within(
			appDir,
			resolve(appDir, `.${path === "/" ? "/index.html" : path}`),
		);
		if (!(p && statSync(p).isFile()))
			return json(res, 404, { error: `No such file: ${path}` });
		if (p.endsWith("index.html")) {
			const page = readFileSync(p, "utf8").replace(
				/<head([^>]*)>/i,
				'<head$1><script src="/web-bridge.js"></script>',
			);
			res.writeHead(200, {
				"content-type": TYPES[".html"],
				"cache-control": "no-store",
			});
			return res.end(page);
		}
		return sendFile(res, p, { "cache-control": "no-store" });
	};
	const byPrefix = (method: string | undefined, path: string): Route | undefined => {
		if (method !== "GET") return undefined;
		if (path.startsWith("/files/")) return stored;
		if (path.startsWith("/asks/")) return question;
		return desktop;
	};
	const find = (table: Map<string, Route>, method: string | undefined, path: string) =>
		table.get(`${method} ${path}`) ?? table.get(`* ${path}`);

	const server = createServer(async (req, res) => {
		let url: URL;
		let path: string;
		// A path like /% throws here, and outside the try that ended the server.
		try {
			url = new URL(req.url ?? "/", "http://lab");
			path = decodeURIComponent(url.pathname);
		} catch {
			return json(res, 400, { error: "That address isn't valid." });
		}
		// A service worker could sit between the page and the computer and
		// see everything, so the browser is never given a script to run as one.
		if (req.headers["service-worker"])
			return json(res, 403, { error: "The Lab doesn't use service workers." });
		try {
			const before = find(open, req.method, path);
			if (before) {
				await before(req, res, url, path);
				return;
			}
			const how = authed(req) ?? (previewing(req, path) ? "cookie" : null);
			if (!how)
				return json(res, 401, {
					error:
						req.method === "GET"
							? "Not paired with this computer."
							: "The preview only looks. Send from the phone instead.",
				});
			const refused = how === "cookie" ? ownPage(req) : null;
			if (refused) return json(res, 403, { error: refused });
			const route = find(routes, req.method, path) ?? byPrefix(req.method, path);
			if (route) {
				await route(req, res, url, path);
				return;
			}
			json(res, 404, { error: `No route for ${req.method} ${path}` });
		} catch (e) {
			json(res, 400, { error: e instanceof Error ? e.message : String(e) });
		}
	});
	// Node gives a request 5 minutes to arrive, and a 100 MB upload over a
	// slow phone connection can take longer than that.
	server.requestTimeout = 60 * 60_000;
	// Exiting at once would have the supervisor start it again straight into
	// the same clash, so it waits a little first.
	server.on("error", (e: NodeJS.ErrnoException) => {
		const taken = e.code === "EADDRINUSE";
		console.error(
			`${new Date().toISOString()} ${taken ? `port ${port} is already in use by another program, so The Lab can't start` : `couldn't listen on port ${port}: ${e.message}`}`,
		);
		setTimeout(() => process.exit(taken ? PORT_TAKEN : 1), 3000);
	});
	server.listen(port, "127.0.0.1", () =>
		process.stdout.write(
			`${new Date().toISOString()} The Lab ${pkg.version} on 127.0.0.1:${port}, home ${Home}\n`,
		),
	);
	// Addresses change when the computer moves networks, so the phone hears
	// the new ones over whichever route still works.
	let sentReach = JSON.stringify(reach());
	let sentPhone = JSON.stringify(phoneNow());
	setInterval(() => {
		const now = reach();
		const phone = phoneNow();
		if (JSON.stringify(phone) !== sentPhone) {
			sentPhone = JSON.stringify(phone);
			lab.store.live(phone);
		}
		if (JSON.stringify(now) === sentReach) return;
		sentReach = JSON.stringify(now);
		lab.store.live(now);
	}, 10_000).unref();
}
