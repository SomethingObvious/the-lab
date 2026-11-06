// Runs the simulator build against two real servers and a real relay, the way
// the Android app gets checked on its emulator. Alpha is reached straight over
// the network and Beta only through the relay.
//   node iphone/check.mjs path/to/TheLab.app folder-for-screenshots
import { spawn, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keys, specOf } from "../computer/tunnel.ts";

const [app, shots] = process.argv.slice(2);
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const ID = "com.somethingobvious.thelab";
const RELAY = process.env.LAB_TEST_RELAY ?? "http://127.0.0.1:8797";
mkdirSync(shots, { recursive: true });

const sim = (...a) => {
	const r = spawnSync("xcrun", ["simctl", ...a], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`simctl ${a.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const failed = [];
const report = (ok, what, note = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${what}${note ? ` :: ${note}` : ""}`);
	if (!ok) failed.push(what);
};
const until = async (f, secs = 30) => {
	const end = Date.now() + secs * 1000;
	while (Date.now() < end) {
		const v = await f().catch(() => null);
		if (v) return v;
		await sleep(400);
	}
	return null;
};

class Lab {
	constructor(name, port) {
		Object.assign(this, { name, port });
		this.root = mkdtempSync(join(tmpdir(), "lab-sim-"));
		this.home = join(this.root, "home");
		this.dir = join(this.root, ".thelab");
		mkdirSync(this.dir, { recursive: true });
		this.token = `sim-token-${name}${"x".repeat(30)}`;
		writeFileSync(
			join(this.dir, "config.json"),
			JSON.stringify({ token: this.token, port, engine: "codex", relay: RELAY, name }),
		);
		cpSync(join(REPO, "computer/template/app"), join(this.home, "app"), {
			recursive: true,
		});
		writeFileSync(join(this.root, "no-trash"), "");
	}
	async start() {
		const log = openSync(join(shots, `${this.name}.log`), "a");
		this.p = spawn("node", [join(REPO, "computer/server.ts")], {
			cwd: join(REPO, "computer"),
			stdio: ["ignore", log, log],
			env: {
				...process.env,
				LAB_CHILD: "1",
				LAB_HOME: this.home,
				LAB_DIR: this.dir,
				LAB_LAN_HOST: "127.0.0.1",
				LAB_TRASH_DIR: join(this.root, "no-trash"),
				LAB_CODEX_BIN: join(REPO, "iphone/Tests/engine.cjs"),
			},
		});
		const up = await until(
			() => fetch(`http://127.0.0.1:${this.port}/health`).then((r) => r.ok),
			120,
		);
		if (!up) throw new Error(`${this.name} didn't start`);
	}
	stop() {
		this.p.kill("SIGKILL");
	}
	spec(direct) {
		return {
			...specOf(keys(this.dir), RELAY, []),
			lan: direct ? [`127.0.0.1:${this.port + 1}`] : [],
		};
	}
	post(path, body, type = "application/json") {
		return fetch(`http://127.0.0.1:${this.port}${path}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": type },
			body,
		});
	}
	events() {
		const f = join(this.dir, "events.jsonl");
		return existsSync(f) ? readFileSync(f, "utf8") : "";
	}
}

let serial = 0;
const docs = () => join(sim("get_app_container", "booted", ID, "data"), "Documents");
const command = async (c, secs = 30) => {
	const id = ++serial;
	const d = docs();
	mkdirSync(d, { recursive: true });
	const tmp = join(d, `tmp-${id}`);
	writeFileSync(tmp, JSON.stringify({ ...c, id }));
	renameSync(tmp, join(d, "command.json"));
	const out = join(d, `answer-${id}.json`);
	const got = await until(
		async () => existsSync(out) && JSON.parse(readFileSync(out, "utf8")),
		secs,
	);
	if (!got) throw new Error(`no answer to ${c.op}`);
	rmSync(out);
	return got;
};
const page = async (js) => {
	const r = await command({
		op: "eval",
		js: `return JSON.stringify(await (async () => { ${js} })())`,
	});
	if (r.error) throw new Error(r.error);
	return r.value === "" || r.value === undefined ? undefined : JSON.parse(r.value);
};
const state = () => command({ op: "state" });
const shot = (name) => sim("io", "booted", "screenshot", join(shots, `${name}.png`));
const onPage = (text, secs = 30) =>
	until(
		() =>
			page(
				`return document.documentElement.innerText.includes(${JSON.stringify(text)})`,
			),
		secs,
	);
const launch = () => sim("launch", "booted", ID);
// A real tap, because the card only counts a real one and nothing in the page can make it.
const tapAllow = (udid) => {
	const r = spawnSync(
		"xcodebuild",
		[
			"test-without-building",
			"-project",
			join(dirname(fileURLToPath(import.meta.url)), "TheLab.xcodeproj"),
			"-scheme",
			"TheLab",
			"-destination",
			`id=${udid}`,
			"-only-testing:TheLabUITests/AllowTests/testAllow",
			`SYMROOT=${dirname(dirname(app))}`,
			"ARCHS=arm64",
			"CODE_SIGN_STYLE=Manual",
			"CODE_SIGN_IDENTITY=-",
		],
		{ encoding: "utf8", timeout: 300_000, maxBuffer: 1 << 28 },
	);
	writeFileSync(join(shots, "uitest.log"), `${r.stdout}\n${r.stderr}`);
	return r.status === 0;
};
const opened = (host, path = "/app/index.html") =>
	until(async () => {
		const s = await state();
		return s.ready && s.url === `lab://${host}${path}` && s.link === "online"
			? s
			: null;
	}, 60);

async function main() {
	const devices = JSON.parse(sim("list", "devices", "available", "-j")).devices;
	const phone = Object.entries(devices)
		.filter(([runtime]) => runtime.includes("iOS"))
		.flatMap(([, list]) => list)
		.find((d) => d.name.startsWith("iPhone"));
	if (!phone) throw new Error("There's no iPhone simulator on this machine.");
	console.log(`Using ${phone.name}`);
	sim("bootstatus", phone.udid, "-b");
	sim("install", "booted", app);

	const alpha = new Lab("Alpha", 18431);
	const beta = new Lab("Beta", 18441);
	try {
		await alpha.start();
		await beta.start();

		launch();
		await until(() => state(), 120);
		await sleep(1500);
		const fresh = await state();
		report(
			fresh.url === "lab://main/shell/rescue.html" && fresh.link === "unpaired",
			"opens unpaired on the safe screen",
			fresh.url,
		);
		shot("01-unpaired");

		await command({ op: "pair", spec: alpha.spec(true), token: alpha.token });
		const a = await opened("main");
		report(
			Boolean(a),
			"pairs and opens the design from the computer",
			JSON.stringify(a ?? (await state())),
		);
		report(a?.route === "direct", "reaches Alpha straight over the network", a?.route);
		report(
			(await page("return lab.platform")) === "ios",
			"the page knows it's on an iPhone",
		);
		await sleep(1500);
		shot("02-alpha");

		await page(`lab.send("hello from the iphone")`);
		report(
			Boolean(
				await until(async () => alpha.events().includes("hello from the iphone")),
			),
			"a message reaches the computer",
		);
		report(Boolean(await onPage("All done.")), "the reply comes back to the page");
		await sleep(500);
		shot("03-reply");

		const icon = readFileSync(
			join(REPO, "iphone/TheLab/Assets.xcassets/AppIcon.appiconset/icon.png"),
		);
		const up = await alpha.post("/to-phone?name=icon.png", icon, "image/png");
		report(up.ok, "the computer sends a picture", String(up.status));
		const sent = up.ok ? await up.json() : {};
		const url = sent.url ?? "/files/icon.png";
		const seen = await page(`
			const whole = await fetch(${JSON.stringify(url)});
			const part = await fetch(${JSON.stringify(url)}, { headers: { Range: "bytes=0-9" } });
			const small = await fetch(lab.fileUrl(${JSON.stringify(url)}, { w: 64 }));
			return { whole: whole.status, size: (await whole.arrayBuffer()).byteLength, part: part.status, partSize: (await part.arrayBuffer()).byteLength, small: small.status, smallSize: (await small.arrayBuffer()).byteLength };
		`);
		report(
			seen.whole === 200 && seen.size === icon.length,
			"the page loads the file through the app",
			JSON.stringify(seen),
		);
		report(
			seen.part === 206 && seen.partSize === 10,
			"a range request gets just that range",
		);
		report(
			seen.small === 200 && seen.smallSize < icon.length,
			"a thumbnail is smaller than the original",
			String(seen.smallSize),
		);
		await sleep(800);
		shot("04-file");

		const closed = await page(
			`return lab.call("POST", "/answer", {}).then(() => "open", (e) => e.message)`,
		);
		report(closed !== "open", "the page can't answer its own Allow card", closed);
		const checks = await page("return lab.check()");
		report(
			Array.isArray(checks?.items) &&
				checks.items.some((i) => /straight/.test(i.title)),
			"the setup check reports the route",
			JSON.stringify(checks?.items?.slice(-3)),
		);

		await page(`lab.send("this needs ok")`);
		const asked = await until(async () => /"kind":"ask"/.test(alpha.events()), 30);
		report(Boolean(asked), "the agent's question reaches the computer's history");
		await sleep(2500);
		const shadowed = await page(`
			const card = document.querySelector("lab-ask");
			return card ? { rect: card.getBoundingClientRect().height } : null;
		`);
		report(
			shadowed?.rect > 0,
			"the Allow card is drawn on the page",
			JSON.stringify(shadowed),
		);
		const clear = await until(
			() =>
				page(`
					const card = document.querySelector("lab-ask").getBoundingClientRect();
					return card.bottom <= document.querySelector("#now").getBoundingClientRect().top;
				`),
			10,
		);
		report(Boolean(clear), "the Allow buttons aren't under the Needs Your OK bar");
		shot("05-ask");
		report(
			tapAllow(phone.udid),
			"a real tap on Allow goes through the native confirmation",
		);
		launch();
		await opened("main");
		report(
			Boolean(await onPage("Decision was accept")),
			"answering lets the agent carry on",
		);

		await command({ op: "keyboard", height: 336 });
		await sleep(600);
		const held = await page(
			`return { height: innerHeight, keyboard: document.documentElement.hasAttribute("data-keyboard") }`,
		);
		report(held.keyboard, "the page is told the keyboard is up", JSON.stringify(held));
		shot("06-keyboard");
		await command({ op: "keyboard", height: 0 });
		await sleep(600);

		await command({ op: "pair", spec: beta.spec(false), token: beta.token });
		const b = await opened("c1");
		report(
			Boolean(b),
			"adds a second computer and shows it",
			JSON.stringify(b ?? (await state())),
		);
		await command({ op: "relayOnly", to: "c1" });
		const onRelay = await until(async () => {
			const s = await state();
			return s.route === "relay" && s.link === "online" ? s : null;
		}, 40);
		report(
			Boolean(onRelay),
			"Beta runs through the relay",
			JSON.stringify(onRelay ?? (await state())),
		);
		await page(
			`localStorage.setItem("whose", "beta"); lab.send("hello over the relay")`,
		);
		report(
			Boolean(await until(async () => beta.events().includes("hello over the relay"))),
			"a message crosses the relay",
		);
		report(Boolean(await onPage("All done.")), "its reply comes back across the relay");
		const big = Buffer.alloc(3 * 1024 * 1024, 7);
		const bigUp = await beta.post(
			"/to-phone?name=big.bin",
			big,
			"application/octet-stream",
		);
		const bigUrl = bigUp.ok ? (await bigUp.json()).url : "";
		const bigSeen = await page(
			`return (await (await fetch(${JSON.stringify(bigUrl)})).arrayBuffer()).byteLength`,
		);
		report(
			bigSeen === big.length,
			"3 MB comes across the relay whole",
			String(bigSeen),
		);
		await sleep(800);
		shot("07-beta-relay");

		await command({ op: "switch", to: "main" });
		await opened("main");
		const items = await page(
			`return document.documentElement.innerText.includes("hello from the iphone")`,
		);
		report(items, "switching back shows Alpha's own history");
		report(
			(await page(`return localStorage.getItem("whose")`)) === null,
			"each computer's page keeps its storage to itself",
		);

		alpha.stop();
		const down = await until(
			async () => ((await state()).link !== "online" ? await state() : null),
			90,
		);
		report(Boolean(down), "notices the computer has gone", JSON.stringify(down));
		await page(`lab.send("sent while it was away")`);
		shot("08-away");
		sim("terminate", "booted", ID);
		await sleep(800);
		launch();
		await until(() => state(), 120);
		await alpha.start();
		const back = await opened("main");
		report(
			Boolean(back),
			"reconnects after a restart on both sides",
			JSON.stringify(back ?? (await state())),
		);
		report(
			Boolean(
				await until(async () => alpha.events().includes("sent while it was away"), 40),
			),
			"the unsent message survives and goes",
		);
		const chip = await until(
			() =>
				page(
					`return document.querySelector("#chips").textContent.includes("fake") || null`,
				),
			15,
		);
		report(
			Boolean(chip),
			"names the model on a page that opened while the computer was away",
		);

		sim("launch", "booted", "com.apple.Preferences");
		// Past the 30 or so seconds iOS allows, as coming back around then is what got it killed.
		await sleep(40_000);
		launch();
		report(Boolean(await opened("main")), "comes back from the background connected");

		sim("ui", "booted", "appearance", "dark");
		await sleep(2500);
		shot("09-dark");
		const reds = await page(
			`return { bg: getComputedStyle(document.documentElement).backgroundColor, insets: getComputedStyle(document.documentElement).getPropertyValue("--lab-inset-top") }`,
		);
		report(
			parseFloat(reds.insets) > 0,
			"the page gets the phone's safe areas",
			JSON.stringify(reds),
		);
	} finally {
		alpha.p?.kill("SIGKILL");
		beta.p?.kill("SIGKILL");
		spawnSync("sh", [
			"-c",
			`xcrun simctl spawn booted log show --last 15m --style compact --predicate 'process == "TheLab"' > "${join(shots, "app.log")}"
			xcrun simctl spawn booted log show --last 15m --style compact --predicate 'eventMessage CONTAINS "thelab" AND process != "TheLab"' > "${join(shots, "launch.log")}"
			cp ~/Library/Logs/DiagnosticReports/TheLab* "${shots}" 2>/dev/null
			codesign -dv --entitlements - "${app}" > "${join(shots, "signature.txt")}" 2>&1`,
		]);
	}
	if (failed.length > 0) {
		console.log(`${failed.length} failed:\n${failed.join("\n")}`);
		process.exit(1);
	}
	console.log("All passed.");
}

await main();
process.exit(0);
