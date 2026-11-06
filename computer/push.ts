// Tells an iPhone something happened while The Lab isn't running, through
// Apple's push service. Android doesn't need this, as its app keeps its own link
// open. Everything sent passes through Apple, so a push only ever says what kind
// of thing happened, and the words wait in the app.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { type ClientHttp2Session, connect } from "node:http2";
import { isAbsolute, join } from "node:path";
import { saveFile } from "./config.ts";

type Env = "sandbox" | "production";
type Apple = { keyId: string; teamId: string; topic: string; keyFile: string };
type Event = { kind: string; [k: string]: unknown };
type Options = {
	dir: string;
	name: () => string;
	room: () => string;
	url?: string;
	patience?: number;
};

const BODY: Record<string, string> = {
	ask: "Needs your OK",
	reply: "Has a reply for you",
	file: "Sent you a file",
	notice: "Has something to tell you",
};
// Apple refuses a token refreshed more than every 20 minutes or older than 60.
const TOKEN_LIFE = 50 * 60_000;
const URLS: Record<Env, string> = {
	sandbox: "https://api.sandbox.push.apple.com",
	production: "https://api.push.apple.com",
};
// A question lapses on the computer after 5 minutes, so it shouldn't arrive later.
const ASK_LIFE = 300;
// A connection that died while the computer slept still looks open, so an answer
// that takes this long means going again on a new one.
const PATIENCE = 15_000;

const base64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export const goodToken = (t: unknown): t is string =>
	typeof t === "string" && /^[0-9a-f]{32,400}$/i.test(t);

export function startPush(o: Options) {
	const appleFile = join(o.dir, "apple-push.json");
	const tokensFile = join(o.dir, "push-tokens.json");
	const sessions = new Map<string, ClientHttp2Session>();
	let bearer = { text: "", at: 0 };

	const apple = (): Apple | null => {
		try {
			const a = JSON.parse(readFileSync(appleFile, "utf8")) as Partial<Apple>;
			return a.keyId && a.teamId && a.topic && a.keyFile ? (a as Apple) : null;
		} catch {
			return null;
		}
	};
	const tokens = (): Record<string, Env> => {
		try {
			return JSON.parse(readFileSync(tokensFile, "utf8"));
		} catch {
			return {};
		}
	};
	const saveTokens = (t: Record<string, Env>) =>
		saveFile(tokensFile, JSON.stringify(t), 0o600);

	const jwt = (a: Apple) => {
		if (Date.now() - bearer.at < TOKEN_LIFE) return bearer.text;
		const at = Date.now();
		const head = base64url(JSON.stringify({ alg: "ES256", kid: a.keyId }));
		const claims = base64url(
			JSON.stringify({ iss: a.teamId, iat: Math.floor(at / 1000) }),
		);
		const file = isAbsolute(a.keyFile) ? a.keyFile : join(o.dir, a.keyFile);
		const signed = sign("sha256", Buffer.from(`${head}.${claims}`), {
			key: createPrivateKey(readFileSync(file)),
			dsaEncoding: "ieee-p1363",
		});
		bearer = { text: `${head}.${claims}.${base64url(signed)}`, at };
		return bearer.text;
	};

	// Apple asks for one connection held open rather than one per push.
	const session = (url: string) => {
		const was = sessions.get(url);
		if (was && !was.closed && !was.destroyed) return was;
		const s = connect(url);
		s.on("error", (e) => {
			console.error("reaching Apple's push service:", e.message);
			s.destroy();
		});
		s.unref();
		sessions.set(url, s);
		return s;
	};

	const deliver = (a: Apple, token: string, env: Env, e: Event, again = true) => {
		const payload = {
			aps: {
				alert: { title: o.name() || "The Lab", body: BODY[e.kind] },
				sound: "default",
				"thread-id": o.room(),
			},
			room: o.room(),
			...(e.kind === "ask" ? { ref: String(e["ref"] ?? "") } : {}),
		};
		const link = session(o.url ?? URLS[env]);
		const req = link.request({
			":method": "POST",
			":path": `/3/device/${token}`,
			authorization: `bearer ${jwt(a)}`,
			"apns-topic": a.topic,
			"apns-push-type": "alert",
			"apns-priority": "10",
			"apns-expiration": String(
				e.kind === "ask" ? Math.floor(Date.now() / 1000) + ASK_LIFE : 0,
			),
			// A newer one of the same kind replaces it, so a long task doesn't pile up. It
			// has the room in it so two computers don't replace each other's, and Apple
			// allows 64 bytes.
			"apns-collapse-id": createHash("sha256")
				.update(`${o.room()}:${e.kind === "ask" ? `ask-${String(e["ref"])}` : e.kind}`)
				.digest("base64url"),
		});
		let status = 0;
		let body = "";
		let over = false;
		const resend = (why: string) => {
			if (over) return;
			over = true;
			console.error(`sending a push: ${why}`);
			if (!again) return;
			try {
				deliver(a, token, env, e, false);
			} catch (err) {
				console.error("sending a push:", err);
			}
		};
		req.setTimeout(o.patience ?? PATIENCE, () => {
			resend("Apple's push service went quiet");
			link.destroy();
		});
		req.setEncoding("utf8");
		req.on("response", (h) => {
			status = Number(h[":status"]);
		});
		req.on("data", (d) => {
			body += d;
		});
		req.on("error", (err) => resend(err.message));
		req.on("end", () => {
			if (over) return;
			if (status === 0) return resend("the connection closed with no answer");
			over = true;
			if (status === 200) return;
			if (status === 410 || body.includes("BadDeviceToken")) {
				const left = tokens();
				delete left[token];
				saveTokens(left);
				return;
			}
			console.error(`Apple refused a push: ${status} ${body}`);
		});
		req.end(JSON.stringify(payload));
	};

	return {
		// False only when the file can't be written, so the phone tries again.
		register(token: string, env: Env) {
			const all = tokens();
			if (all[token] === env) return true;
			all[token] = env;
			return saveTokens(all);
		},
		unregister(token: string) {
			const all = tokens();
			if (!(token in all)) return true;
			delete all[token];
			return saveTokens(all);
		},
		// Whether a push can go at all, so the phone knows to make its own notifications.
		ready: () => Boolean(apple()),
		// The phone leaves a push alone while The Lab is open, so this always sends.
		event(e: Event) {
			if (!BODY[e.kind] || e["silent"] || e["onMac"]) return;
			if (!existsSync(appleFile)) return;
			const a = apple();
			if (!a) return;
			try {
				for (const [t, env] of Object.entries(tokens())) deliver(a, t, env, e);
			} catch (err) {
				console.error("sending a push:", err);
			}
		},
		close() {
			for (const s of sessions.values()) s.close();
		},
	};
}
