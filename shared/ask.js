// <lab-ask ref="...">, the one place an Allow card can be answered.
//
// Each shell (the Android app, the Windows and Mac windows) injects this before
// any page script runs, with the placeholder below swapped for a key only the
// shell knows. The design is restyled by the agent, so it can't be trusted to
// answer for him: this element fetches the question from the shell itself,
// draws it in a closed shadow root, and only passes on a real tap on a card
// that's been fully on screen, uncovered, for a moment.
//
// The page can replace any built-in after this runs, so the code below only
// calls what it captured up front. It has no promises, iterators, spreads or
// destructuring, since each of those looks up something the page could patch
// (a patched array iterator could turn his Deny into Always Allow).
(() => {
	const key = "__LAB_ASK_KEY__";
	if (globalThis !== globalThis.top || globalThis.customElements?.get("lab-ask"))
		return;

	const apply = Reflect.apply;
	const create = Object.create;
	const describe = Object.getOwnPropertyDescriptor;
	const hasOwn = Object.prototype.hasOwnProperty;
	const isArray = Array.isArray;
	const stringify = JSON.stringify;
	const parse = JSON.parse;
	const Str = String;
	const replace = String.prototype.replace;
	const U8 = Uint8Array;
	const floor = Math.floor;
	const now = performance.now.bind(performance);
	const later = setTimeout.bind(globalThis);
	const random = crypto.getRandomValues.bind(crypto);
	const define = customElements.define.bind(customElements);
	const attach = Element.prototype.attachShadow;
	const getAttr = Element.prototype.getAttribute;
	const setAttr = Element.prototype.setAttribute;
	const rectOf = Element.prototype.getBoundingClientRect;
	const listen = EventTarget.prototype.addEventListener;
	const byId = DocumentFragment.prototype.getElementById;
	const setHTML = describe(ShadowRoot.prototype, "innerHTML").set;
	const setText = describe(Node.prototype, "textContent").set;
	const setHidden = describe(HTMLElement.prototype, "hidden").set;
	const setDisabled = describe(HTMLButtonElement.prototype, "disabled").set;
	const ownerOf = describe(Node.prototype, "ownerDocument").get;
	const connected = describe(Node.prototype, "isConnected").get;
	const MsgEvent = MessageEvent;
	const dataOf = describe(MessageEvent.prototype, "data").get;
	const Observer = globalThis.IntersectionObserver;
	const observe = Observer?.prototype.observe;
	const disconnect = Observer?.prototype.disconnect;
	const entry = globalThis.IntersectionObserverEntry?.prototype;
	const ratioOf = entry && describe(entry, "intersectionRatio")?.get;
	const visibleOf = entry && describe(entry, "isVisible")?.get;
	const weakGet = WeakMap.prototype.get;
	const weakSet = WeakMap.prototype.set;
	const then = Promise.prototype.then;
	const mapGet = Map.prototype.get;
	const mapSet = Map.prototype.set;
	const mapDelete = Map.prototype.delete;
	const doc = document;

	const own = (o, k) =>
		o && typeof o === "object" && apply(hasOwn, o, [k]) ? o[k] : undefined;
	const textOf = (o, k) => {
		const v = own(o, k);
		return typeof v === "string" ? v : "";
	};

	// The shell's channel. Replies carry a fresh random nonce, never the key,
	// and only the first reply to a nonce counts.
	const waiting = new Map();
	const heard = (e) => {
		let raw;
		if (e instanceof MsgEvent) raw = apply(dataOf, e, []);
		else raw = typeof e === "string" ? e : e?.data;
		let m;
		try {
			m = typeof raw === "string" ? parse(raw) : raw;
		} catch {
			return;
		}
		const nonce = own(m, "nonce");
		if (typeof nonce !== "string") return;
		const done = apply(mapGet, waiting, [nonce]);
		if (!done) return;
		apply(mapDelete, waiting, [nonce]);
		done(m);
	};
	let post = null;
	let confirmsAllow = false;
	const android = globalThis.labNative;
	const webview = globalThis.chrome?.webview;
	const webkit = globalThis.webkit?.messageHandlers?.labAsk;
	if (android) {
		post = android.postMessage.bind(android);
		android.addEventListener.bind(android)("message", heard);
	} else if (webview) {
		post = webview.postMessage.bind(webview);
		webview.addEventListener.bind(webview)("message", heard);
	} else if (webkit) {
		// WebKit has no isVisible, so the Mac window asks again in a native
		// dialog before it passes an Allow on. The handler replies through the
		// promise postMessage returns, and the captured then hands the reply
		// straight to heard whatever the page has done to Promise.
		const send = webkit.postMessage.bind(webkit);
		post = (m) => apply(then, send(m), [heard, () => undefined]);
		confirmsAllow = true;
	}
	const digits = "0123456789abcdef";
	const hex = (n) => {
		const b = random(new U8(n));
		let s = "";
		for (let i = 0; i < n; i++) s += digits[floor(b[i] / 16)] + digits[b[i] % 16];
		return s;
	};
	// Calls back with the shell's reply, or with nothing after 20 seconds.
	const rpc = (m, done) => {
		const nonce = hex(16);
		m.key = key;
		m.nonce = nonce;
		apply(mapSet, waiting, [nonce, done]);
		later(() => {
			if (apply(mapGet, waiting, [nonce]) !== done) return;
			apply(mapDelete, waiting, [nonce]);
			done(null);
		}, 20_000);
		post(stringify(m));
	};

	const entities = {
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	};
	const esc = (s) => apply(replace, Str(s), [/[&<>"']/g, (c) => entities[c]]);
	// Fixed colours and a generic font, as anything inherited from the page
	// could hide the words or swap their glyphs.
	const style = `
:host { display: block; contain: content; }
.card { all: initial; color-scheme: inherit; display: block; box-sizing: border-box; padding: 16px;
  border-radius: 14px; border: 1px solid light-dark(#c9c9d1, #4a4a55);
  background: light-dark(#ffffff, #1f1f24); color: light-dark(#18181c, #f2f2f5);
  font: 15px/1.45 system-ui, sans-serif; text-align: start; }
:where(.card *) { box-sizing: border-box; font: inherit; color: inherit; margin: 0; }
h2 { font-size: 17px; font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
p, li { margin-top: 6px; overflow-wrap: anywhere; }
.soft { color: light-dark(#55555f, #b4b4bf); }
ul { padding-inline-start: 20px; margin-top: 6px; }
.why b { display: block; font-size: 13px; font-weight: 600; color: light-dark(#55555f, #b4b4bf); }
pre { margin-top: 8px; padding: 10px; border-radius: 8px; max-height: 40vh; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.4 ui-monospace, monospace;
  background: light-dark(#f1f1f4, #2a2a31); }
button { all: initial; color-scheme: inherit; box-sizing: border-box; cursor: pointer; font: 600 15px/1 system-ui, sans-serif;
  min-height: 44px; padding: 0 18px; border-radius: 22px; display: inline-flex; align-items: center;
  justify-content: center; }
button:focus-visible { outline: 3px solid light-dark(#2f5bd3, #8fb0ff); outline-offset: 2px; }
button:disabled { cursor: default; opacity: 0.55; }
.more { min-height: 32px; padding: 0; margin-top: 8px; color: light-dark(#2f5bd3, #8fb0ff); font-weight: 500; }
.row { display: flex; gap: 10px; margin-top: 14px; }
.row button { flex: 1; }
.deny { background: light-dark(#e9e9ee, #34343c); color: light-dark(#18181c, #f2f2f5); }
.allow { background: light-dark(#1d6b3a, #4cc17a); color: light-dark(#ffffff, #0b2414); }
.always { min-height: 36px; padding: 0; margin-top: 10px; width: 100%; font-weight: 500;
  color: light-dark(#2f5bd3, #8fb0ff); }
/* A fixed height, so a note can't move the card under his finger and turn a
   second tap on Allow into one on Always Allow. */
.note { margin-bottom: -10px; height: 1.5em; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  font-size: 13px; color: light-dark(#55555f, #b4b4bf); }
`;
	const heldMs = 800;
	const buttons = ["deny", "allow", "always"];

	const plain = (msg) =>
		`<style>${style}</style><div class="card"><p class="soft">${msg}</p></div>`;
	const page = (ask) => {
		const title = textOf(ask, "title");
		const from = textOf(ask, "from");
		const why = textOf(ask, "why");
		const detail = textOf(ask, "detail");
		const facts = own(ask, "facts");
		let list = "";
		if (isArray(facts))
			for (let i = 0; i < facts.length && i < 8; i++)
				list += `<li>${esc(textOf(facts, i))}</li>`;
		return `<style>${style}</style><div class="card" id="card" role="group" aria-labelledby="t">
<h2 id="t">${esc(title)}</h2>
${from ? `<p class="soft">${esc(from)}</p>` : ""}
${list ? `<ul>${list}</ul>` : ""}
${why ? `<p class="why"><b>The agent says</b>${esc(why)}</p>` : ""}
${detail ? `<button type="button" class="more" id="more" aria-expanded="false" aria-controls="detail">Show the Details</button><pre id="detail" hidden>${esc(detail)}</pre>` : ""}
<div class="row"><button type="button" class="deny" id="deny">Deny</button><button type="button" class="allow" id="allow">Allow</button></div>
${own(ask, "always") === true ? `<button type="button" class="always" id="always">Always Allow This Exact Command</button>` : ""}
<p class="note" id="note" role="status"></p></div>`;
	};

	const states = new WeakMap();
	const el = (s, id) => apply(byId, s.root, [id]);
	const say = (s, msg) => {
		const note = el(s, "note");
		if (note) apply(setText, note, [msg]);
	};
	const lock = (s, on) => {
		for (let i = 0; i < buttons.length; i++) {
			const b = el(s, buttons[i]);
			if (b) apply(setDisabled, b, [on]);
		}
	};

	// An Allow counts only for a real tap on this card, with the card wholly
	// in view and nothing over it or fading it, for long enough to read.
	const fair = (s, button) => {
		if (!apply(connected, s.host, []) || apply(ownerOf, s.host, []) !== doc)
			return false;
		const r = apply(rectOf, button, []);
		if (r.width < 24 || r.height < 24) return false;
		if (confirmsAllow) return s.ratio >= 0.99;
		return s.since !== null && now() - s.since >= heldMs;
	};

	const answer = (s, allow, always, e, button) => {
		if (!e.isTrusted || s.busy) return;
		if (allow && !fair(s, button)) {
			say(
				s,
				s.since === null && !confirmsAllow
					? "Scroll so all of it shows, then tap again."
					: "Read it for a second, then tap again.",
			);
			return;
		}
		s.busy = true;
		lock(s, true);
		say(s, "Sending…");
		const m = create(null);
		m.op = "askAnswer";
		m.ref = s.ref;
		m.allow = allow;
		m.always = always;
		rpc(m, (r) => {
			const status = own(r, "status");
			if (typeof status === "number" && status >= 200 && status < 300)
				return say(s, allow ? "Allowed." : "Denied.");
			if (status === 404) return say(s, "Already answered, or it has expired.");
			if (status === 499) {
				s.busy = false;
				lock(s, false);
				return say(s, "");
			}
			s.busy = false;
			lock(s, false);
			say(s, "Didn't reach the computer. Try again.");
		});
	};

	const wire = (s) => {
		const card = el(s, "card");
		if (!card) return;
		const more = el(s, "more");
		if (more)
			apply(listen, more, [
				"click",
				() => {
					s.open = !s.open;
					apply(setHidden, el(s, "detail"), [!s.open]);
					apply(setAttr, more, ["aria-expanded", s.open ? "true" : "false"]);
					apply(setText, more, [s.open ? "Hide the Details" : "Show the Details"]);
				},
			]);
		const deny = el(s, "deny");
		const allow = el(s, "allow");
		const always = el(s, "always");
		apply(listen, deny, ["click", (e) => answer(s, false, false, e, deny)]);
		apply(listen, allow, ["click", (e) => answer(s, true, false, e, allow)]);
		if (always)
			apply(listen, always, ["click", (e) => answer(s, true, true, e, always)]);
		if (!Observer) return;
		const opts = create(null);
		opts.threshold = [0, 0.5, 0.99, 1];
		if (visibleOf) {
			opts.trackVisibility = true;
			opts.delay = 100;
		}
		s.watch = new Observer((list) => {
			for (let i = 0; i < list.length; i++) {
				s.ratio = apply(ratioOf, list[i], []);
				// Without isVisible there's no telling what covers the card.
				const shown = visibleOf && s.ratio >= 0.99 && apply(visibleOf, list[i], []);
				if (!shown) s.since = null;
				else if (s.since === null) s.since = now();
			}
		}, opts);
		apply(observe, s.watch, [card]);
	};

	const load = (s) => {
		const ref = s.ref;
		s.since = null;
		s.ratio = 0;
		s.busy = false;
		s.open = false;
		if (s.watch) apply(disconnect, s.watch, []);
		s.watch = null;
		if (!post)
			return apply(setHTML, s.root, [
				plain("Answer this on your phone or in The Lab window."),
			]);
		if (!ref) return apply(setHTML, s.root, [plain("")]);
		apply(setHTML, s.root, [plain("Loading the question…")]);
		const m = create(null);
		m.op = "askInfo";
		m.ref = ref;
		rpc(m, (r) => {
			if (s.ref !== ref) return;
			const ask = own(r, "ask");
			if (!ask || typeof ask !== "object") {
				apply(setHTML, s.root, [
					plain(
						own(r, "status") === 404
							? "This was already answered or has expired."
							: "Couldn't load this question. Check the connection to the computer.",
					),
				]);
				return;
			}
			apply(setHTML, s.root, [page(ask)]);
			wire(s);
		});
	};

	class LabAsk extends HTMLElement {
		static get observedAttributes() {
			return ["ref"];
		}
		constructor() {
			super();
			const s = create(null);
			s.host = this;
			const how = create(null);
			how.mode = "closed";
			s.root = apply(attach, this, [how]);
			s.ref = null;
			s.watch = null;
			apply(weakSet, states, [this, s]);
		}
		connectedCallback() {
			const s = apply(weakGet, states, [this]);
			const ref = apply(getAttr, this, ["ref"]) || "";
			if (!s || ref === s.ref) return;
			s.ref = ref;
			load(s);
		}
		attributeChangedCallback() {
			const s = apply(weakGet, states, [this]);
			if (!s || !apply(connected, this, [])) return;
			const ref = apply(getAttr, this, ["ref"]) || "";
			if (ref === s.ref) return;
			s.ref = ref;
			load(s);
		}
	}
	define("lab-ask", LabAsk);
})();
