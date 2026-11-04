// How the phone reaches the server without Tailscale. Each phone connection
// is carried, sealed, either straight over the local network or through a
// relay that both ends dial out to, so the relay and anyone on the Wi-Fi only
// ever see ciphertext. The server itself still listens on 127.0.0.1 alone.
//
// The handshake is Noise NK with a pre-shared key, done by hand: the phone
// knows this computer's static key and a pass from pairing, sends a fresh
// ephemeral key, and both sides derive two AES-256-GCM keys from both
// Diffie-Hellman results and the pass. Frames are numbered implicitly, so a
// replayed, dropped or reordered frame fails to open.
//
// phone/.../Tunnel.kt is the other end and has to stay in step with this file.
import {
	createCipheriv,
	createDecipheriv,
	createECDH,
	createHash,
	type ECDH,
	hkdfSync,
	randomBytes,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { type Duplex, duplexPair } from "node:stream";

const LABEL = Buffer.from("the lab tunnel 1");
const HELLO = 1;
const WELCOME = 2;
const OPEN = 1;
const DATA = 2;
const END = 3;
const ACK = 4;
// What the relay puts in front of each frame for the computer.
const R_DATA = 0;
const R_LEAVE = 2;
const CHUNK = 32 * 1024;
// Bytes a stream may have in flight before it waits for an ack, which keeps
// the relay and both ends from buffering a whole 100 MB upload.
const WINDOW = 1024 * 1024;
const ACK_EVERY = 64 * 1024;
const MAX_PACKET = 256 * 1024;

export interface Keys {
	secret: string;
	priv: string;
	pass: string;
}
export interface Spec {
	relay?: string;
	room: string;
	key: string;
	pass: string;
	lan: string[];
}
export interface TunnelState {
	relay: string;
	lan: string;
	peers: number;
}

// For events that need a listener but nothing done, like a socket error
// that the close after it cleans up.
const ignore = () => {
	// Nothing to do.
};

const b64 = (b: Buffer) => b.toString("base64url");
const raw = (s: string) => Buffer.from(s, "base64url");
export const roomOf = (secret: string) =>
	b64(createHash("sha256").update(secret).digest());

export function keys(dir: string): Keys {
	const file = join(dir, "tunnel.json");
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
	const ec = createECDH("prime256v1");
	ec.generateKeys();
	const k = {
		secret: b64(randomBytes(32)),
		priv: b64(ec.getPrivateKey()),
		pass: b64(randomBytes(32)),
	};
	writeFileSync(file, `${JSON.stringify(k, null, 2)}\n`, { mode: 0o600 });
	return k;
}

const staticKey = (k: Keys) => {
	const ec = createECDH("prime256v1");
	ec.setPrivateKey(raw(k.priv));
	return ec;
};

// Adapters for virtual machines, WSL, Docker and internet sharing never lead
// to the phone, and the phone only tries the first few addresses.
const VIRTUAL =
	/vethernet|virtualbox|vmware|vmnet|docker|wsl|hyper-v|^br-|^bridge\d|^utun|^veth|zerotier/i;

export function lanAddresses(port: number): string[] {
	const out: { at: string; rank: number }[] = [];
	for (const [name, list] of Object.entries(networkInterfaces()))
		for (const a of list ?? []) {
			if (a.family !== "IPv4" || a.internal || a.address.startsWith("169.254."))
				continue;
			// A Tailscale address (100.64.0.0/10) only answers when the phone has
			// Tailscale on, so the home network's address is tried before it.
			const [x, y = 0] = a.address.split(".").map(Number);
			out.push({
				at: `${a.address}:${port}`,
				rank: VIRTUAL.test(name) ? 2 : x === 100 && y >= 64 && y < 128 ? 1 : 0,
			});
		}
	return out
		.toSorted((a, b) => a.rank - b.rank)
		.map((a) => a.at)
		.slice(0, 6);
}

export const specOf = (k: Keys, relay: string | undefined, lan: string[]): Spec => ({
	...(relay ? { relay } : {}),
	room: roomOf(k.secret),
	key: b64(staticKey(k).getPublicKey()),
	pass: k.pass,
	lan,
});

class Box {
	private n = 0n;
	private readonly key: Buffer;
	constructor(key: Buffer) {
		this.key = key;
	}
	private iv() {
		const iv = Buffer.alloc(12);
		iv.writeBigUInt64BE(this.n++, 4);
		return iv;
	}
	seal(pt: Buffer) {
		const c = createCipheriv("aes-256-gcm", this.key, this.iv());
		return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
	}
	open(ct: Buffer) {
		if (ct.length < 16) throw new Error("short frame");
		const d = createDecipheriv("aes-256-gcm", this.key, this.iv());
		d.setAuthTag(ct.subarray(-16));
		return Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]);
	}
}

function derive(
	mine: ECDH,
	ours: ECDH,
	theirs: Buffer,
	pass: Buffer,
	ep: Buffer,
	ec: Buffer,
	s: Buffer,
) {
	const ikm = Buffer.concat([mine.computeSecret(theirs), ours.computeSecret(theirs)]);
	const okm = Buffer.from(
		hkdfSync("sha256", ikm, pass, Buffer.concat([LABEL, ep, ec, s]), 64),
	);
	return { p2c: okm.subarray(0, 32), c2p: okm.subarray(32) };
}

interface Stream {
	sock: Duplex;
	unacked: number;
	pending: number;
	ended: boolean;
}

// Streams over one session. Either end can be handed a local Duplex: the
// computer's are sockets to the server, the test's are one half of a pair.
class Mux {
	streams = new Map<number, Stream>();
	private readonly out: (pt: Buffer) => void;
	constructor(out: (pt: Buffer) => void) {
		this.out = out;
	}

	frame(id: number, type: number, data: Buffer = Buffer.alloc(0)) {
		const h = Buffer.alloc(5);
		h.writeUInt32BE(id);
		h[4] = type;
		this.out(Buffer.concat([h, data]));
	}

	attach(id: number, sock: Duplex) {
		const s: Stream = { sock, unacked: 0, pending: 0, ended: false };
		this.streams.set(id, s);
		sock.on("data", (b: Buffer) => {
			// The other end has let go, so nothing will ack this. It drains away
			// rather than holding the socket open until the session ends.
			if (s.ended) return;
			for (let i = 0; i < b.length; i += CHUNK)
				this.frame(id, DATA, b.subarray(i, i + CHUNK));
			s.unacked += b.length;
			if (s.unacked > WINDOW) sock.pause();
		});
		sock.on("error", () => sock.destroy());
		sock.on("close", () => {
			if (this.streams.get(id) !== s) return;
			this.streams.delete(id);
			if (!s.ended) this.frame(id, END);
		});
	}

	take(pt: Buffer, opener?: () => Duplex) {
		if (pt.length < 5) throw new Error("short frame");
		const id = pt.readUInt32BE(0);
		const type = pt[4];
		const data = pt.subarray(5);
		const s = this.streams.get(id);
		if (type === OPEN && opener && !s) return this.attach(id, opener());
		if (!s) return;
		if (type === DATA) {
			s.sock.write(data, () => {
				s.pending += data.length;
				if (s.pending >= ACK_EVERY && this.streams.get(id) === s) {
					const n = Buffer.alloc(4);
					n.writeUInt32BE(s.pending);
					s.pending = 0;
					this.frame(id, ACK, n);
				}
			});
		} else if (type === ACK && data.length === 4) {
			s.unacked -= data.readUInt32BE(0);
			if (s.unacked <= WINDOW && s.sock.isPaused()) s.sock.resume();
		} else if (type === END) {
			s.ended = true;
			s.sock.end();
			s.sock.resume();
		}
	}

	closeAll() {
		for (const s of this.streams.values()) {
			s.ended = true;
			s.sock.destroy();
		}
		this.streams.clear();
	}
}

// The computer's end of one phone's session.
export class Responder {
	private session?: { mux: Mux; inBox: Box };
	private readonly k: Keys;
	private readonly port: number;
	private readonly send: (b: Buffer) => void;
	private readonly drop: () => void;
	constructor(k: Keys, port: number, send: (b: Buffer) => void, drop: () => void) {
		this.k = k;
		this.port = port;
		this.send = send;
		this.drop = drop;
	}

	packet(b: Buffer) {
		try {
			if (!this.session) return this.hello(b);
			this.session.mux.take(this.session.inBox.open(b), () =>
				connect(this.port, "127.0.0.1"),
			);
		} catch {
			this.close();
			this.drop();
		}
	}

	private hello(b: Buffer) {
		if (b.length !== 66 || b[0] !== HELLO) throw new Error("bad hello");
		const ep = b.subarray(1);
		const s = staticKey(this.k);
		const e = createECDH("prime256v1");
		e.generateKeys();
		const { p2c, c2p } = derive(
			s,
			e,
			ep,
			raw(this.k.pass),
			ep,
			e.getPublicKey(),
			s.getPublicKey(),
		);
		const inBox = new Box(p2c);
		const outBox = new Box(c2p);
		this.send(
			Buffer.concat([
				Buffer.from([WELCOME]),
				e.getPublicKey(),
				outBox.seal(Buffer.from("lab")),
			]),
		);
		this.session = { mux: new Mux((pt) => this.send(outBox.seal(pt))), inBox };
	}

	get ready() {
		return this.session !== undefined;
	}

	close() {
		this.session?.mux.closeAll();
	}
}

// One packet per length-prefixed frame, for the direct link.
function framed(sock: Socket, onPacket: (b: Buffer) => void) {
	let buf: Buffer = Buffer.alloc(0);
	sock.on("data", (d: Buffer) => {
		buf = buf.length > 0 ? Buffer.concat([buf, d]) : d;
		while (buf.length >= 4) {
			const n = buf.readUInt32BE(0);
			if (n > MAX_PACKET) {
				sock.destroy();
				return;
			}
			if (buf.length < 4 + n) break;
			onPacket(buf.subarray(4, 4 + n));
			buf = buf.subarray(4 + n);
		}
	});
	return (b: Buffer) => {
		const h = Buffer.alloc(4);
		h.writeUInt32BE(b.length);
		if (!sock.destroyed) sock.write(Buffer.concat([h, b]));
	};
}

const relayUrl = (relay: string, room: string) =>
	`${relay.replace(/\/+$/, "").replace(/^http/, "ws")}/r/${room}`;

export interface TunnelOptions {
	dir: string;
	port: number;
	relay?: string | undefined;
	lanPort: number;
	lanHost?: string | undefined;
}

export function startTunnel(o: TunnelOptions) {
	const k = keys(o.dir);
	const state: TunnelState = {
		relay: o.relay ? "connecting" : "off",
		lan: "starting",
		peers: 0,
	};
	let stopped = false;

	// Anyone on the same Wi-Fi can connect, so a connection that hasn't
	// finished the handshake in 10 s goes, and only 32 are kept at once.
	// Keepalive notices a phone that walked off the network.
	const lan = createServer((sock) => {
		sock.setNoDelay(true);
		sock.setKeepAlive(true, 30_000);
		let r: Responder | null = null;
		const send = framed(sock, (p) => r?.packet(p));
		r = new Responder(k, o.port, send, () => sock.destroy());
		state.peers++;
		const hello = setTimeout(() => {
			if (!r?.ready) sock.destroy();
		}, 10_000);
		sock.on("error", ignore);
		sock.on("close", () => {
			clearTimeout(hello);
			state.peers--;
			r?.close();
		});
	});
	lan.maxConnections = 32;
	lan.on("error", (e) => {
		state.lan = `off: ${e.message}`;
	});
	lan.listen(o.lanPort, o.lanHost ?? "0.0.0.0", () => {
		state.lan = "on";
	});

	let ws: WebSocket | null = null;
	let wait = 1000;
	let seen = 0;
	const sessions = new Map<number, Responder>();
	const endSessions = () => {
		for (const r of sessions.values()) r.close();
		state.peers -= sessions.size;
		sessions.clear();
	};
	const dialRelay = () => {
		if (stopped || !o.relay) return;
		const sock = new WebSocket(relayUrl(o.relay, roomOf(k.secret)), ["lab", k.secret]);
		ws = sock;
		sock.binaryType = "arraybuffer";
		const to = (peer: number, type: number, body: Buffer = Buffer.alloc(0)) => {
			if (sock.readyState !== WebSocket.OPEN) return;
			const h = Buffer.alloc(5);
			h.writeUInt32BE(peer);
			h[4] = type;
			sock.send(Buffer.concat([h, body]));
		};
		sock.addEventListener("open", () => {
			state.relay = "connected";
			wait = 1000;
			seen = Date.now();
		});
		sock.addEventListener("message", (ev) => {
			seen = Date.now();
			if (typeof ev.data === "string") return;
			const b = Buffer.from(ev.data as ArrayBuffer);
			if (b.length < 5) return;
			const peer = b.readUInt32BE(0);
			const type = b[4];
			if (type === R_LEAVE) {
				if (sessions.has(peer)) state.peers--;
				sessions.get(peer)?.close();
				sessions.delete(peer);
				return;
			}
			if (type !== R_DATA) return;
			let r = sessions.get(peer);
			if (!r) {
				const fresh: Responder = new Responder(
					k,
					o.port,
					(p) => to(peer, R_DATA, p),
					() => {
						if (sessions.get(peer) === fresh) {
							sessions.delete(peer);
							state.peers--;
						}
						to(peer, R_LEAVE);
					},
				);
				r = fresh;
				sessions.set(peer, r);
				state.peers++;
			}
			r.packet(b.subarray(5));
		});
		sock.addEventListener("error", ignore);
		sock.addEventListener("close", (ev) => {
			if (ws !== sock) return;
			ws = null;
			endSessions();
			// 4001 means another copy of the server took the room, so this one
			// waits a minute instead of taking it straight back.
			state.relay =
				ev.code === 4003
					? "refused: this computer is not the room owner"
					: ev.code === 4001
						? "replaced by another copy of the server"
						: `reconnecting (${ev.code || "no answer"})`;
			if (ev.code === 4001) wait = 60_000;
			if (!stopped) setTimeout(dialRelay, wait);
			wait = Math.min(wait * 2, ev.code === 4001 ? 120_000 : 30_000);
		});
	};
	dialRelay();

	// The relay answers "ping" without waking up, so silence for this long
	// means the link died without a close.
	const beat = setInterval(() => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (Date.now() - seen > 75_000) {
			const dead = ws;
			ws = null;
			endSessions();
			state.relay = "reconnecting (timed out)";
			dead.close();
			dialRelay();
			return;
		}
		ws.send("ping");
	}, 30_000);

	return {
		state,
		spec: () => specOf(k, o.relay, lanAddresses(o.lanPort)),
		close() {
			stopped = true;
			clearInterval(beat);
			lan.close();
			ws?.close();
			endSessions();
		},
	};
}

// The phone's side, for the tests and for checking a route from this
// computer. Resolves once the handshake is done.
export async function dial(
	sp: Spec,
	how: { host: string; port: number } | { relay: string },
	timeout = 8000,
) {
	const e = createECDH("prime256v1");
	e.generateKeys();
	const ep = e.getPublicKey();
	let send: (b: Buffer) => void;
	let close: () => void;
	let onPacket: (b: Buffer) => void = ignore;
	let onLost: (why: string) => void = ignore;

	if ("host" in how) {
		const sock = connect(how.port, how.host);
		sock.setNoDelay(true);
		send = framed(sock, (b) => onPacket(b));
		close = () => sock.destroy();
		sock.on("error", ignore);
		sock.on("close", () => onLost("closed"));
	} else {
		const ws = new WebSocket(relayUrl(how.relay, sp.room));
		ws.binaryType = "arraybuffer";
		const queued: Buffer[] = [];
		send = (b) =>
			ws.readyState === WebSocket.OPEN
				? ws.send(b as Uint8Array<ArrayBuffer>)
				: queued.push(b);
		ws.addEventListener("open", () => {
			for (const b of queued.splice(0)) ws.send(b as Uint8Array<ArrayBuffer>);
		});
		ws.addEventListener("message", (ev) =>
			typeof ev.data === "string"
				? onLost(ev.data)
				: onPacket(Buffer.from(ev.data as ArrayBuffer)),
		);
		ws.addEventListener("close", () => onLost("closed"));
		close = () => ws.close();
	}

	const welcome = await new Promise<Buffer>((ok, fail) => {
		const t = setTimeout(() => fail(new Error("no answer")), timeout);
		onPacket = (b) => {
			clearTimeout(t);
			ok(b);
		};
		onLost = (why) => {
			clearTimeout(t);
			fail(new Error(why));
		};
		send(Buffer.concat([Buffer.from([HELLO]), ep]));
	}).catch((err) => {
		close();
		throw err;
	});

	const s = raw(sp.key);
	if (welcome.length !== 1 + 65 + 3 + 16 || welcome[0] !== WELCOME) {
		close();
		throw new Error("bad welcome");
	}
	const ec = welcome.subarray(1, 66);
	const ikm = Buffer.concat([e.computeSecret(s), e.computeSecret(ec)]);
	const okm = Buffer.from(
		hkdfSync("sha256", ikm, raw(sp.pass), Buffer.concat([LABEL, ep, ec, s]), 64),
	);
	const outBox = new Box(okm.subarray(0, 32));
	const inBox = new Box(okm.subarray(32));
	let proof = "";
	try {
		proof = inBox.open(welcome.subarray(66)).toString();
	} catch (err) {
		close();
		throw new Error("wrong key", { cause: err });
	}
	if (proof !== "lab") {
		close();
		throw new Error("wrong key");
	}
	const mux = new Mux((pt) => send(outBox.seal(pt)));
	let lost = false;
	onPacket = (b) => {
		try {
			mux.take(inBox.open(b));
		} catch {
			lost = true;
			mux.closeAll();
			close();
		}
	};
	onLost = () => {
		lost = true;
		mux.closeAll();
	};
	let next = 1;
	return {
		get lost() {
			return lost;
		},
		// A socket-like stream to the server, for http.request's createConnection.
		connection(): Duplex {
			const [mine, theirs] = duplexPair();
			const id = next;
			next += 2;
			mux.frame(id, OPEN);
			mux.attach(id, theirs);
			return mine;
		},
		close() {
			mux.closeAll();
			close();
		},
	};
}
