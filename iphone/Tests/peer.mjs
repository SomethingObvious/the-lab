// A real computer/tunnel.ts in front of a small server, for CoreTests.swift.
// Prints its details as one line of JSON, and stops when stdin closes.
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTunnel } from "../../computer/tunnel.ts";

const site = createServer((req, res) => {
	if (req.url === "/health") return res.end("ok");
	if (req.url === "/big") return res.end(Buffer.alloc(3 * 1024 * 1024, 55));
	let n = 0;
	req.on("data", (d) => {
		n += d.length;
	});
	req.on("end", () => res.end(`got ${n}`));
});
await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
const relay = process.argv[2] || undefined;
const lanPort = 20000 + Math.floor(Math.random() * 20000);
const t = startTunnel({
	dir: mkdtempSync(join(tmpdir(), "lab-peer-")),
	port: site.address().port,
	relay,
	lanPort,
	lanHost: "127.0.0.1",
});
await new Promise((ok) => setTimeout(ok, 300));
const spec = t.spec();
process.stdout.write(`${JSON.stringify({ ...spec, lan: [`127.0.0.1:${lanPort}`] })}\n`);
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
