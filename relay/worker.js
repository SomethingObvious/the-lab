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

const sha = async (s) => {
	const d = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
	);
	return btoa(String.fromCharCode(...d))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/[=]+$/, "");
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
				old.close(4001, "Another copy of the server took over.");
			}
			for (const p of this.ctx.getWebSockets("phone"))
				p.close(4000, "The computer restarted.");
			this.ctx.acceptWebSocket(server, ["pc"]);
			return new Response(null, {
				status: 101,
				webSocket: client,
				headers: { "sec-websocket-protocol": "lab" },
			});
		}
		const phones = this.ctx.getWebSockets("phone");
		if (phones.length >= PHONES)
			return new Response("Too many phones in this room.", { status: 429 });
		let peer;
		do peer = crypto.getRandomValues(new Uint32Array(1))[0];
		while (this.ctx.getWebSockets(`p${peer}`).length > 0);
		this.ctx.acceptWebSocket(server, ["phone", `p${peer}`]);
		server.serializeAttachment({ peer });
		if (!this.pc()) {
			server.send("away");
			server.close(4004, "The computer is not connected.");
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	webSocketMessage(ws, msg) {
		if (typeof msg === "string") return;
		const body = new Uint8Array(msg);
		const { peer } = ws.deserializeAttachment() ?? {};
		if (peer === undefined) {
			if (body.length < 5) return;
			const to = new DataView(body.buffer, body.byteOffset).getUint32(0);
			const phone = this.ctx.getWebSockets(`p${to}`)[0];
			if (!phone) return;
			if (body[4] === DATA) phone.send(body.subarray(5));
			else if (body[4] === LEAVE) phone.close(4000, "The computer ended this session.");
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

	// The computer's socket, leaving out one that's closing after a takeover.
	pc() {
		return this.ctx
			.getWebSockets("pc")
			.find((s) => !s.deserializeAttachment()?.replaced);
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
		const { peer, replaced } = ws.deserializeAttachment() ?? {};
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
