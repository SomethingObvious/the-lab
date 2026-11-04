// The relay for computer/tunnel.ts. One Durable Object per room passes
// sealed frames between a computer and its phones. It holds no keys, so it
// can't read or change what it passes, only drop it.
//
// The computer proves it owns the room by sending the secret that hashes to
// the room's name. Phones only know the name, so they can't take its place.
import { DurableObject } from "cloudflare:workers";

const ROOM = /^[A-Za-z0-9_-]{43}$/;
const DATA = 0;
const LEAVE = 2;
const PHONES = 8;
// The computer says "ping" every 30 s, so a socket that has been quiet for
// longer than this died without a close.
const STALE = 100_000;

const sha = async (s) => {
	const d = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
	);
	return btoa(String.fromCharCode(...d))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/[=]+$/, "");
};

// A socket that is closing already throws on send and close, which mustn't
// stop the rest of a takeover.
const quietly = (f) => {
	try {
		f();
	} catch {
		// It was going anyway.
	}
};

const header = (peer, type) => {
	const h = new Uint8Array(5);
	new DataView(h.buffer).setUint32(0, peer);
	h[4] = type;
	return h;
};

export class Room extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	async fetch(req) {
		const room = new URL(req.url).pathname.split("/")[2];
		const offered = (req.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.map((s) => s.trim());
		const [client, server] = Object.values(new WebSocketPair());
		if (offered[0] === "lab" && offered[1]) {
			// Accepted and then closed, because a refused upgrade only reaches
			// the computer as 1006 and it couldn't tell this apart from a drop.
			if ((await sha(offered[1])) !== room) {
				server.accept();
				server.close(4003, "Not the owner of this room.");
				return new Response(null, {
					status: 101,
					webSocket: client,
					headers: { "sec-websocket-protocol": "lab" },
				});
			}
			// The phones' sessions were with the copy being replaced, so they
			// start over with this one.
			for (const old of this.ctx.getWebSockets("pc")) {
				old.serializeAttachment({ replaced: true });
				quietly(() => old.close(4001, "Another copy of the server took over."));
			}
			for (const p of this.ctx.getWebSockets("phone"))
				quietly(() => p.close(4000, "The computer restarted."));
			for (const w of this.ctx.getWebSockets("waiting")) {
				quietly(() => w.send("here"));
				quietly(() => w.close(1000, "The computer is back."));
			}
			this.ctx.acceptWebSocket(server, ["pc"]);
			server.serializeAttachment({ at: Date.now() });
			return new Response(null, {
				status: 101,
				webSocket: client,
				headers: { "sec-websocket-protocol": "lab" },
			});
		}
		// A phone that found the computer away holds this open, so it hears
		// the moment the computer connects instead of checking back on a timer.
		if (new URL(req.url).searchParams.has("wait")) {
			// Anyone who knows the room can wait, so the oldest makes way rather
			// than a stranger keeping his phone out. That phone only loses the
			// early word and checks back on its timer.
			const waiting = this.staying("waiting");
			if (waiting.length >= PHONES) this.evict(waiting, () => true);
			this.ctx.acceptWebSocket(server, ["waiting"]);
			server.serializeAttachment({ waiting: true, at: Date.now() });
			if (this.pc()) {
				server.send("here");
				server.close(1000, "The computer is here.");
			}
			return new Response(null, { status: 101, webSocket: client });
		}
		// The room is no secret, so a full one makes way for the newcomer by
		// closing the oldest socket the computer hasn't answered past its
		// handshake. Only a phone with the keys gets that far.
		const phones = this.staying("phone");
		if (phones.length >= PHONES && !this.evict(phones, (a) => !a.trusted))
			return new Response("Too many phones in this room.", { status: 429 });
		let peer;
		do peer = crypto.getRandomValues(new Uint32Array(1))[0];
		while (this.ctx.getWebSockets(`p${peer}`).length > 0);
		this.ctx.acceptWebSocket(server, ["phone", `p${peer}`]);
		server.serializeAttachment({ peer, at: Date.now() });
		if (!this.pc()) {
			server.send("away");
			server.close(4004, "The computer is not connected.");
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws, msg) {
		if (typeof msg === "string") return;
		const body = new Uint8Array(msg);
		const { peer, waiting } = ws.deserializeAttachment() ?? {};
		if (waiting) return;
		if (peer === undefined) {
			if (body.length < 5) return;
			const to = new DataView(body.buffer, body.byteOffset).getUint32(0);
			const phone = this.ctx.getWebSockets(`p${to}`)[0];
			if (!phone) return;
			if (body[4] === DATA) {
				phone.send(body.subarray(5));
				// The first frame back is the handshake, which any HELLO gets.
				// A second one means the phone proved it has the keys.
				const a = phone.deserializeAttachment() ?? {};
				if (!a.trusted) {
					a.heard = (a.heard ?? 0) + 1;
					if (a.heard > 1) a.trusted = true;
					phone.serializeAttachment(a);
				}
			} else if (body[4] === LEAVE)
				phone.close(4000, "The computer ended this session.");
			return;
		}
		const pc = this.pc();
		if (!pc) {
			ws.send("away");
			ws.close(4004, "The computer is not connected.");
			return;
		}
		const out = new Uint8Array(5 + body.length);
		out.set(header(peer, DATA));
		out.set(body, 5);
		pc.send(out);
	}

	// The sockets with this tag, less any already told to make way, which stay
	// listed until their close goes through.
	staying(tag) {
		return this.ctx
			.getWebSockets(tag)
			.filter((s) => !s.deserializeAttachment()?.evicted);
	}

	// Closes the oldest of the sockets that may go, and says whether there was one.
	evict(sockets, may) {
		let oldest = null;
		let at = Number.POSITIVE_INFINITY;
		for (const s of sockets) {
			const a = s.deserializeAttachment() ?? {};
			if (may(a) && (a.at ?? 0) < at) {
				oldest = s;
				at = a.at ?? 0;
			}
		}
		if (!oldest) return false;
		oldest.serializeAttachment({ ...oldest.deserializeAttachment(), evicted: true });
		quietly(() => oldest.close(4005, "Another phone took this place in the room."));
		return true;
	}

	// The computer's socket, leaving out one that's closing after a takeover
	// and one that stopped pinging, which is closed so the computer dials again
	// if it's still there.
	pc() {
		const now = Date.now();
		return this.ctx.getWebSockets("pc").find((s) => {
			const a = s.deserializeAttachment() ?? {};
			if (a.replaced) return false;
			const seen =
				this.ctx.getWebSocketAutoResponseTimestamp(s)?.getTime() ?? a.at ?? now;
			if (now - seen < STALE) return true;
			try {
				s.close(4002, "No ping from the computer.");
			} catch {
				// It was closing already.
			}
			return false;
		});
	}

	webSocketClose(ws, code) {
		this.gone(ws, code);
	}
	webSocketError(ws) {
		this.gone(ws, 1011);
	}

	gone(ws, code) {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code);
		} catch {
			// It was closed already, which is all this wanted.
		}
		const { peer, replaced, waiting } = ws.deserializeAttachment() ?? {};
		if (waiting) return;
		if (peer === undefined) {
			// The session keys went with the computer, so its phones start over.
			// A copy that was replaced already sent them to the new one.
			if (!replaced)
				for (const p of this.ctx.getWebSockets("phone"))
					p.close(4000, "The computer went away.");
			return;
		}
		const pc = this.pc();
		if (pc)
			try {
				pc.send(header(peer, LEAVE));
			} catch {
				// The computer's socket is closing too, and that close starts its phones over.
			}
	}
}

export default {
	fetch(req, env) {
		const url = new URL(req.url);
		const [, kind, room] = url.pathname.split("/");
		if (kind === "r" && ROOM.test(room ?? "")) {
			if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
				return new Response("Expected a WebSocket.", { status: 426 });
			return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(req);
		}
		if (url.pathname === "/") return new Response("The Lab relay.\n");
		return new Response("Not found.\n", { status: 404 });
	},
};
