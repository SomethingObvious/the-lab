// Runs the real worker in Cloudflare's local runtime against the computer's
// real tunnel code. From relay/: node --test test.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { dial, startTunnel } from "../computer/tunnel.ts";

const PORT = 8797;
const RELAY = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}`;
let worker;
let site;
let sitePort;

const closed = (ws) =>
	new Promise((ok) => {
		ws.addEventListener("close", (e) => ok(e.code));
	});
const opened = (ws) =>
	new Promise((ok, no) => {
		ws.addEventListener("open", ok);
		ws.addEventListener("error", no);
	});
const aRoom = () => {
	const secret = randomBytes(32).toString("base64url");
	return {
		secret,
		room: createHash("sha256").update(secret).digest("base64url"),
	};
};
const tunnel = () =>
	startTunnel({
		dir: mkdtempSync(join(tmpdir(), "lab-relay-")),
		port: sitePort,
		relay: RELAY,
		lanPort: 0,
		lanHost: "127.0.0.1",
	});
const connected = async (t) => {
	for (let i = 0; i < 100 && t.state.relay !== "connected"; i++) await wait(50);
	assert.equal(t.state.relay, "connected");
};

before(async () => {
	site = createServer((_, res) => res.end("hello"));
	await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
	sitePort = site.address().port;
	worker = spawn(
		process.execPath,
		[
			"node_modules/wrangler/bin/wrangler.js",
			"dev",
			"--port",
			String(PORT),
			"--ip",
			"127.0.0.1",
		],
		{ cwd: import.meta.dirname, stdio: "ignore", env: { ...process.env, CI: "1" } },
	);
	for (let i = 0; i < 240; i++) {
		if (
			await fetch(RELAY).then(
				(r) => r.ok,
				() => false,
			)
		)
			return;
		await wait(250);
	}
	throw new Error("The local relay didn't come up.");
});
after(() => {
	worker?.kill();
	site?.close();
});

test("it answers only what it should over plain HTTP", async () => {
	assert.equal(await (await fetch(RELAY)).text(), "The Lab relay 2.\n");
	assert.equal((await fetch(RELAY, { method: "POST" })).status, 405);
	assert.equal((await fetch(`${RELAY}/nope`)).status, 404);
	assert.equal((await fetch(`${RELAY}/r/${aRoom().room}`)).status, 426);
	const browser = await new Promise((ok, no) => {
		request(`${RELAY}/r/${aRoom().room}`, {
			headers: {
				connection: "upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": randomBytes(16).toString("base64"),
				origin: "https://example.com",
			},
		})
			.on("response", (r) => ok(r.statusCode))
			.on("upgrade", () => ok(101))
			.on("error", no)
			.end();
	});
	assert.equal(browser, 403);
});

test("only the owner's secret can take the room", async () => {
	const { room } = aRoom();
	const ws = new WebSocket(`${WS}/r/${room}`, ["lab", "not-the-secret"]);
	assert.equal(await closed(ws), 4003);
});

test("a phone goes through the relay to the computer and back", async () => {
	const t = tunnel();
	await connected(t);
	const s = await dial(t.spec(), { relay: RELAY });
	assert.ok(s);
	s.close();
	t.close();
});

test("a phone is told when the computer is away, and when it's back", async () => {
	const { secret, room } = aRoom();
	const phone = new WebSocket(`${WS}/r/${room}`);
	assert.equal(await closed(phone), 4004);
	const waiting = new WebSocket(`${WS}/r/${room}?wait=1`);
	await opened(waiting);
	const heard = new Promise((ok) => {
		waiting.addEventListener("message", (e) => ok(e.data));
	});
	const pc = new WebSocket(`${WS}/r/${room}`, ["lab", secret]);
	await opened(pc);
	assert.equal(await heard, "here");
	pc.close();
});

test("a stranger who won't prove itself gets cut off", async () => {
	const { secret, room } = aRoom();
	const pc = new WebSocket(`${WS}/r/${room}`, ["lab", secret]);
	await opened(pc);
	const stranger = new WebSocket(`${WS}/r/${room}`);
	await opened(stranger);
	const end = closed(stranger);
	for (let i = 0; i < 600; i++) stranger.send(new Uint8Array(1));
	assert.equal(await end, 4006);
	pc.close();
});

test("an oversized frame closes the socket that sent it", async () => {
	const { secret, room } = aRoom();
	const pc = new WebSocket(`${WS}/r/${room}`, ["lab", secret]);
	await opened(pc);
	const phone = new WebSocket(`${WS}/r/${room}`);
	await opened(phone);
	const end = closed(phone);
	phone.send(new Uint8Array(600 * 1024));
	assert.equal(await end, 1009);
	pc.close();
});

test("strangers filling the room don't keep a real phone out", async () => {
	const t = tunnel();
	await connected(t);
	const spec = t.spec();
	const strangers = [];
	for (let i = 0; i < 8; i++) {
		const s = new WebSocket(`${WS}/r/${spec.room}`);
		await opened(s);
		strangers.push(s);
	}
	const s = await dial(spec, { relay: RELAY });
	assert.ok(s);
	s.close();
	t.close();
	for (const x of strangers) x.close();
});

test("a new copy of the computer takes over and tells the old one", async () => {
	const { secret, room } = aRoom();
	const a = new WebSocket(`${WS}/r/${room}`, ["lab", secret]);
	await opened(a);
	const end = closed(a);
	const b = new WebSocket(`${WS}/r/${room}`, ["lab", secret]);
	await opened(b);
	assert.equal(await end, 4001);
	b.close();
});
