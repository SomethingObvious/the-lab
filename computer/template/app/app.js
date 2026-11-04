const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const esc = (s) =>
	String(s ?? "").replace(
		/[&<>"']/g,
		(c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);
const icon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;
// A part that throws is skipped and reported to the computer, so the rest of
// the page keeps working and the agent hears what to fix.
const guard = (where, fn, fallback) => {
	try {
		return fn();
	} catch (err) {
		console.error(err);
		lab.reportError?.(err?.message || String(err), where);
		return fallback;
	}
};
const DefaultSettings = {
	topBar: [
		{ id: "status", size: "small" },
		{ id: "battery", size: "small" },
		{ id: "storage", size: "wide" },
	],
	topBarHidden: false,
	theme: "system",
	textSize: 100,
	steps: "live",
	times: true,
	enterSends: false,
	chips: true,
	digest: true,
	motion: "full",
	model: null,
	modelChip: true,
	effort: null,
	replies: "normal",
};
let settings = { ...DefaultSettings };

// Every shape is the same 96 point polar outline, so CSS can morph any one
// into any other by transitioning `d`.
const Shapes = {
	circle: [0, 0],
	cookie: [9, 0.075],
	burst: [12, 0.085],
	clover: [4, 0.17],
	flower: [8, 0.11],
	triangle: [3, 0.12],
	pentagon: [5, 0.1],
};
function outline(n, a) {
	const r0 = 48 / (1 + a);
	let d = "";
	for (let k = 0; k < 96; k++) {
		const t = (k / 96) * 2 * Math.PI;
		const r = r0 * (1 + a * Math.cos(n * t));
		d += `${k ? "L" : "M"}${(50 + r * Math.sin(t)).toFixed(2)} ${(50 - r * Math.cos(t)).toFixed(2)}`;
	}
	return `path("${d}Z")`;
}
const P = Object.fromEntries(
	Object.entries(Shapes).map(([k, [n, a]]) => [k, outline(n, a)]),
);
const css = document.createElement("style");
css.textContent = `:root{${Object.entries(P)
	.map(([k, v]) => `--sh-${k}:${v}`)
	.join(";")}}
.shape{d:${P.circle}}
${Object.keys(P)
	.map((k) => `.s-${k}{d:${P[k]}}`)
	.join("\n")}
@keyframes morph{0%,100%{d:${P.burst}}25%{d:${P.cookie}}50%{d:${P.pentagon}}75%{d:${P.clover}}}`;
document.head.append(css);
const shape = (name, id) =>
	`<svg viewBox="0 0 100 100" aria-hidden="true"><path class="shape s-${name}"${id ? ` id="${id}"` : ""}/></svg>`;
const loader = () =>
	`<svg viewBox="0 0 100 100" aria-hidden="true"><path class="shape"/></svg>`;

function inline(s) {
	return (
		s
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
			.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
			.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => {
				const h = hostOf(u);
				return `<a href="${u}" data-ext>${t}</a>${h && !t.toLowerCase().includes(h.replace(/^www\./, "")) ? ` <span class="host">(${h})</span>` : ""}`;
			})
			// A bare address already shows where it goes.
			.replace(
				/(^|[\s(])(https?:\/\/[^\s<)]*[^\s<).,;:!?'"])/g,
				'$1<a href="$2" data-ext>$2</a>',
			)
	);
}
// A link's words can say anything, so its real address is shown beside it.
const hostOf = (u) => {
	try {
		return new URL(u.replace(/&amp;/g, "&")).host;
	} catch {
		return "";
	}
};
function md(src) {
	const out = [];
	esc(src)
		.split(/```[^\n]*\n?/)
		.forEach((part, i) => {
			if (i % 2) {
				out.push(`<pre><code>${part.replace(/\n$/, "")}</code></pre>`);
				return;
			}
			for (const block of part.split(/\n{2,}/)) {
				const b = block.trim();
				if (!b) continue;
				const lines = b.split("\n");
				if (lines.every((l) => /^\s*[-*] /.test(l)))
					out.push(
						`<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`,
					);
				else if (lines.every((l) => /^\s*\d+[.)] /.test(l)))
					out.push(
						`<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)] /, ""))}</li>`).join("")}</ol>`,
					);
				else out.push(`<p>${lines.map(inline).join("<br>")}</p>`);
			}
		});
	return out.join("");
}
const plain = (s) =>
	String(s || "")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[*`#>]/g, "")
		.replace(/\s+/g, " ")
		.trim();

// Made once. Building a formatter per call was most of the first draw.
const fmt = (o) => new Intl.DateTimeFormat([], o);
const Hm = fmt({ hour: "numeric", minute: "2-digit" });
const Long = fmt({ weekday: "long", month: "long", day: "numeric" });
const Short = fmt({ month: "short", day: "numeric" });
const clock = (iso) => Hm.format(new Date(iso));
const dayKey = (iso) => new Date(iso).toDateString();
function dayLabel(iso) {
	const d = new Date(iso);
	const today = new Date();
	const y = new Date(today);
	y.setDate(today.getDate() - 1);
	if (d.toDateString() === today.toDateString()) return "Today";
	if (d.toDateString() === y.toDateString()) return "Yesterday";
	return Long.format(d);
}
const shortDay = (iso) => {
	const l = dayLabel(iso);
	return l === "Today"
		? clock(iso)
		: l === "Yesterday"
			? "Yesterday"
			: Short.format(new Date(iso));
};
const mmss = (ms) => {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const took = (ms) => {
	const s = Math.round(ms / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};
const bytes = (n) =>
	n < 1024
		? `${n} B`
		: n < 1e6
			? `${Math.round(n / 1e3)} KB`
			: n < 1e9
				? `${(n / 1e6).toFixed(1)} MB`
				: `${n >= 1e11 ? Math.round(n / 1e9) : (n / 1e9).toFixed(1)} GB`;
function ago(iso) {
	const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
	if (m < 1) return "just now";
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}
function uptime(s) {
	const d = Math.floor(s / 86_400);
	const h = Math.floor((s % 86_400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d) return `${d} day${d > 1 ? "s" : ""}, ${h} hour${h === 1 ? "" : "s"}`;
	return h ? `${h} h ${m} min` : `${m} min`;
}
const isImage = (f) =>
	(f.type || "").startsWith("image/") ||
	/\.(jpe?g|png|gif|webp|heic)$/i.test(f.name || "");
// Thumbnails ask for a copy whose short side covers the drawn size in
// device pixels, so they're sharp without decoding the original.
const thumb = (url, cssPx) =>
	esc(lab.fileUrl(url, { w: Math.ceil(cssPx * (devicePixelRatio || 1)) }));

// One mark per state, each its own shape.
const Marks = {
	ok: ["cookie", "check"],
	bad: ["clover", "x"],
	wait: ["burst", "pause"],
	stopped: ["circle", "stop"],
	go: [null, null],
};
// Read before a request in the list. Working and asking say so in the meta line.
const Said = { ok: "Done, ", bad: "Didn't finish, ", stopped: "Stopped, " };
function mark(state) {
	const [s, ic] = Marks[state];
	return `<span class="state ${state}">${s ? shape(s) : loader()}${ic ? icon(ic) : ""}</span>`;
}

// Screen reader lines. Polite ones in a burst are read as one.
const said = [];
let sayTimer = null;
function say(msg, urgent) {
	if (urgent) {
		$("sr-alert").textContent = "";
		setTimeout(() => {
			$("sr-alert").textContent = msg;
		}, 50);
		return;
	}
	said.push(msg);
	clearTimeout(sayTimer);
	sayTimer = setTimeout(() => {
		$("sr").textContent = said.splice(0).join(" ");
	}, 150);
}

// Redrawing replaces elements, so the focused control is found again by
// its data attributes and focused in the new markup.
const keyOf = (el) =>
	[...el.attributes]
		.filter((a) => a.name.startsWith("data-"))
		.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`)
		.join("");
function refocus(within, change, fallback) {
	const a = document.activeElement;
	if (!a || a === document.body || !within.contains(a)) return change();
	const keys = [keyOf(a)];
	if (a.dataset.answer) keys.push(`[data-answered="${CSS.escape(a.dataset.answer)}"]`);
	const out = change();
	if (a.isConnected) return out;
	const scope = out instanceof Element ? out : within;
	const next =
		keys
			.filter(Boolean)
			.map((k) => (scope.matches?.(k) ? scope : scope.querySelector(k)))
			.find(Boolean) || fallback?.();
	if (next) focusSoft(next);
	return out;
}
// Redraws only touch the nodes that differ, so a photo isn't decoded
// again, a spinner keeps turning, a transition gets to run and focus stays
// put. A changed field is swapped whole, since what he typed lives in a
// property the markup can't see.
function morph(a, b) {
	if (a.isEqualNode(b)) return;
	if (a.nodeType !== 1) {
		a.nodeValue = b.nodeValue;
		return;
	}
	if (/^(INPUT|TEXTAREA|SELECT)$/.test(a.nodeName)) {
		a.replaceWith(b);
		return;
	}
	for (const name of a.getAttributeNames())
		if (!b.hasAttribute(name)) a.removeAttribute(name);
	for (const { name, value } of b.attributes)
		if (a.getAttribute(name) !== value) a.setAttribute(name, value);
	patch(a, b);
}
function patch(a, b) {
	const was = [...a.childNodes];
	const now = [...b.childNodes];
	now.forEach((y, i) => {
		const x = was[i];
		if (!x) a.append(y);
		else if (x.nodeName === y.nodeName) morph(x, y);
		else x.replaceWith(y);
	});
	for (const x of was.slice(now.length)) x.remove();
}
const tpl = document.createElement("template");
const setHTML = (el, html) => {
	tpl.innerHTML = html;
	patch(el, tpl.content);
};
const setText = (el, s) => {
	if (el.textContent !== s) el.textContent = s;
};
// Elements that aren't controls get tabindex only while they hold focus,
// so TalkBack doesn't read a whole turn as one item.
function focusSoft(el) {
	if (!el.matches("button, input, textarea, a[href], [tabindex]")) {
		el.tabIndex = -1;
		el.addEventListener("blur", () => el.removeAttribute("tabindex"), { once: true });
	}
	el.focus({ preventScroll: true });
}

const items = [];
const byRef = new Map();
// Which turn or notice each event landed in, so search can jump to it.
const byEid = new Map();
let cur = null;
let settled = -1;
let link = { state: "connecting" };
let status = { working: false, label: "" };
let mac = null;
let shortcuts = [];
let outbox = [];
let pending = [];
let uploading = 0;
let selected = null;
let moreOpen = false;
let booted = false;

const thread = $("thread");
const log = document.createElement("div");
log.className = "log";
const queue = document.createElement("div");
queue.className = "queue";
const older = document.createElement("button");
older.type = "button";
older.className = "pill older";
older.id = "older";
older.hidden = true;
older.textContent = "Show Earlier Messages";

function newTurn(you, at) {
	const t = {
		type: "turn",
		i: items.length,
		id: you ? `y${you.id}` : `t${Math.random()}`,
		you,
		at,
		steps: [],
		failed: {},
		asks: [],
		answers: {},
		out: [],
		notes: [],
		snap: null,
		done: null,
		open: undefined,
		raw: new Set(),
	};
	items.push(t);
	cur = t;
	return t;
}

// Only the newest turns are in the page. Older ones are drawn in as he
// scrolls up, and dropped again once he's back at the newest message.
const Window = 40;
const First = 10;
let shownFrom = 0;
let windowed = false;
let filling = true;
const idle = globalThis.requestIdleCallback || ((fn) => setTimeout(fn, 16));
// Opening the app draws the newest turns at once and the rest of the
// window ten at a time, so no single task holds up the first frame.
function fill() {
	const floor = floorOf(items.length, Window);
	if (shownFrom > floor) reveal(Math.max(floor, floorOf(shownFrom, First)));
	if (shownFrom > floor) idle(fill);
	else filling = false;
}
function floorOf(end, n) {
	let k = 0;
	for (let i = end - 1; i >= 0; i--)
		if (items[i].type === "turn" && ++k === n) return i;
	return 0;
}

// Events only mark what changed. One frame then draws it all, so loading
// two thousand events of history draws each turn and the side list once.
const dirty = new Set();
const want = { now: false, side: false, files: false };
let frame = 0;
function schedule() {
	if (booted && !frame) frame = requestAnimationFrame(flush);
}
function flushNow() {
	if (frame) {
		cancelAnimationFrame(frame);
		flush();
	}
}
function flush() {
	frame = 0;
	const stick = pinned || nearBottom();
	if (!windowed && items.length > 0) {
		shownFrom = floorOf(items.length, First);
		windowed = true;
		idle(fill);
	}
	for (const item of dirty) draw(item);
	if (stick && !overlay()) trim();
	older.hidden = shownFrom === 0;
	if (want.now) drawNow();
	if (want.side) drawSide();
	if (want.files && shown($("files-view"))) drawFiles();
	want.now = false;
	want.side = false;
	want.files = false;
	if (stick) toBottom();
}

// History is older than this, so only live events are read out.
const fresh = (e) => booted && Date.now() - Date.parse(e.at) < 30_000;
function announce(e, t) {
	if (e.kind === "ask") say(`Needs your OK: ${e.title}`);
	else if (e.kind === "reply") {
		const p = plain(e.text);
		say(`The computer replied: ${p.length > 160 ? `${p.slice(0, 157)}...` : p}`);
	} else if (e.kind === "file") say(`The computer sent ${e.name}.`);
	else if (e.kind === "failed")
		say(`A step failed: ${t.steps.find((s) => s.ref === e.ref)?.title || e.text}`);
	else if (e.kind === "done")
		say(
			e.stopped
				? "Stopped."
				: e.ok
					? `Done after ${took(e.ms)}.`
					: "That one didn't finish.",
		);
}

function take(e) {
	switch (e.kind) {
		case "link": {
			const was = link.state;
			link = e;
			drawLink(was);
			drawGlance();
			return;
		}
		case "status": {
			const flip = status.working !== e.working;
			status = e;
			want.now = true;
			if (flip) {
				want.side = true;
				if (cur) dirty.add(cur);
			} else patchRun();
			schedule();
			return;
		}
		case "mac":
			mac = e;
			drawGlance();
			return;
		case "settings": {
			const was = settings;
			settings = { ...DefaultSettings, ...e.values };
			settingsChanged(was);
			return;
		}
		case "loaded":
			loaded = true;
			want.side = true;
			want.files = true;
			schedule();
			return;
		case "shortcuts":
			shortcuts = e.items || [];
			drawChips();
			return;
		case "outbox":
			outbox = e.items || [];
			drawQueue();
			return;
		case "insets": {
			fold();
			// The WebView isn't resized for the keyboard, so the browser's own scroll-on-focus thinks the field is still in view.
			const a = document.activeElement;
			if (a?.matches("input, textarea") && a.closest("#sheet"))
				a.scrollIntoView({ block: "nearest" });
			return;
		}
		case "fold":
			posture();
			return;
		case "backprogress":
			follow(e.progress, e.edge);
			return;
		case "backcancel":
			follow(0);
			return;
		case "openFailed":
			toast("Nothing on this phone can open that file.", true);
			return;
		case "answerFailed":
			toast(
				"Couldn't reach the computer, so that answer didn't go through. Try again once it's back.",
				true,
			);
			return;
		case "stopFailed":
			toast("Couldn't reach the computer to stop it. Try again once it's back.", true);
			return;
		// The computer turned a message down, so his words go back in the box.
		case "sendFailed":
			if (e.text && !text.value.includes(e.text))
				text.value = text.value ? `${e.text}\n${text.value}` : e.text;
			growText();
			canSend();
			keep(text.value);
			toast(e.error || "That message didn't send.", true);
			return;
		case "you": {
			const t = newTurn(e, e.at);
			byEid.set(String(e.id), t);
			dirty.add(t);
			want.side = true;
			if (e.files?.length) want.files = true;
			schedule();
			if (e.scheduled && fresh(e)) say(`Scheduled: ${e.scheduled}.`);
			return;
		}
		case "notice": {
			const n = { type: "notice", i: items.length, id: `n${e.id}`, e, at: e.at };
			items.push(n);
			byEid.set(String(e.id), n);
			dirty.add(n);
			schedule();
			if (fresh(e)) say(e.text);
			return;
		}
		// The snapshot taken as a task starts is the one Put Things Back uses.
		case "snapshot":
			if (cur && !cur.snap && !cur.done) {
				cur.snap = e;
				dirty.add(cur);
				schedule();
			}
			return;
		// Shared from another app, or the tile: the text waits in the composer.
		case "compose": {
			if (e.text) text.value = text.value ? `${text.value}\n${e.text}` : e.text;
			if (e.files?.length) {
				pending.push(...e.files);
				drawPending();
			}
			growText();
			canSend();
			keep(text.value);
			text.focus();
			return;
		}
		default:
			addToTurn(e);
	}
}

function addToTurn(e) {
	// Anything else that isn't part of a turn is for some other design.
	if (
		![
			"step",
			"failed",
			"ask",
			"answered",
			"reply",
			"file",
			"done",
			"blocked",
			"memory",
		].includes(e.kind)
	)
		return;
	const t =
		e.kind === "failed" || e.kind === "answered"
			? byRef.get(e.ref) || cur
			: cur || newTurn(null, e.at);
	if (!t) return;
	if (e.kind === "step") {
		t.steps.push(e);
		byRef.set(e.ref, t);
	} else if (e.kind === "failed") t.failed[e.ref] = e.text;
	else if (e.kind === "ask") {
		t.asks.push(e);
		byRef.set(e.ref, t);
	} else if (e.kind === "answered") t.answers[e.ref] = e;
	else if (e.kind === "reply" || e.kind === "file") t.out.push(e);
	else if (e.kind === "blocked" || e.kind === "memory") t.notes.push(e);
	else if (e.kind === "done") markDone(e);
	byEid.set(String(e.id), t);
	dirty.add(t);
	if (e.kind === "ask" || e.kind === "answered" || e.kind === "done") {
		want.now = true;
		want.side = true;
	}
	if (e.kind === "file") want.files = true;
	if (fresh(e)) announce(e, t);
	schedule();
}

// `upto` is the last message this run answered. One queued behind it
// waits for its own done.
function markDone(e) {
	let last = settled;
	for (let i = settled + 1; i < items.length; i++) {
		const o = items[i];
		if (o.type !== "turn" || o.done) continue;
		if (e.upto && o.you && o.you.id > e.upto) break;
		o.done = e;
		dirty.add(o);
		last = i;
	}
	settled = last;
}

// The conversation

const fromBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight;
const nearBottom = () => fromBottom() < 120;
// Whether he was reading the newest message, kept so a resize can stay there.
let pinned = true;
const toBottom = () => {
	thread.scrollTop = thread.scrollHeight;
	pinned = true;
};

const elOf = (item) => (item.type === "turn" ? turnEl(item) : noticeEl(item.e));
// The top of the window always gets its day, even mid-day.
const needsDay = (i) =>
	i === shownFrom || dayKey(items[i - 1].at) !== dayKey(items[i].at);
function dayEl(item) {
	const d = document.createElement("div");
	d.className = "day";
	d.textContent = dayLabel(item.at);
	item.dayEl = d;
	return d;
}

const brokenEl = () => {
	const d = document.createElement("div");
	d.className = "notice broken";
	d.textContent =
		"This part couldn't be shown, and the computer has been told about it.";
	return d;
};
const safeEl = (item) =>
	guard("drawing the conversation", () => elOf(item), null) || brokenEl();
function draw(item) {
	dirty.delete(item);
	if (item.i < shownFrom) return;
	const el = safeEl(item);
	if (item.el) {
		const old = item.el;
		refocus(
			old,
			() => {
				morph(old, el);
			},
			() => old.querySelector(".bubble") || old,
		);
		return;
	}
	if (needsDay(item.i)) log.insertBefore(dayEl(item), digestEl);
	log.insertBefore(el, digestEl);
	item.el = el;
}

// Draws older items in above the window without moving what he's reading.
function reveal(to) {
	flushNow();
	if (to >= shownFrom) return;
	const first = items[shownFrom];
	const top0 = first.el.getBoundingClientRect().top;
	const frag = document.createDocumentFragment();
	const from = shownFrom;
	shownFrom = to;
	for (let i = to; i < from; i++) {
		const it = items[i];
		dirty.delete(it);
		if (needsDay(i)) frag.append(dayEl(it));
		it.el = safeEl(it);
		frag.append(it.el);
	}
	if (first.dayEl && dayKey(items[from - 1].at) === dayKey(first.at)) {
		first.dayEl.remove();
		first.dayEl = null;
	}
	log.insertBefore(frag, first.dayEl || first.el);
	thread.scrollTop += first.el.getBoundingClientRect().top - top0;
	older.hidden = shownFrom === 0;
}
const more = () => {
	if (!(older.hidden || filling)) reveal(floorOf(shownFrom, Window));
};
new IntersectionObserver(
	(list) => {
		if (list.some((x) => x.isIntersecting)) more();
	},
	{ root: thread, rootMargin: "800px 0px 0px 0px" },
).observe(older);

// Back at the newest message, the turns he scrolled up through are dropped.
function trim() {
	const floor = floorOf(items.length, Window);
	if (floor - shownFrom < Window) return;
	const a = document.activeElement;
	for (let i = shownFrom; i < floor; i++) if (items[i].el?.contains(a)) return;
	for (let i = shownFrom; i < floor; i++) {
		const it = items[i];
		it.el?.remove();
		it.dayEl?.remove();
		it.el = null;
		it.dayEl = null;
	}
	shownFrom = floor;
	const firstShown = items[floor];
	if (firstShown.el && !firstShown.dayEl)
		log.insertBefore(dayEl(firstShown), firstShown.el);
}

// A status change while working only renames the live step.
function patchRun() {
	const b = cur?.el?.querySelector(".run.live:not(.wait) .run-head b");
	if (b) setText(b, status.label || "Working");
}

function noticeEl(e) {
	const div = document.createElement("div");
	div.dataset.eid = e.id;
	// The welcome card. Got It hides it, and Settings can bring it back.
	if (e.points) {
		div.className = "welcome";
		div.hidden = Boolean(settings.welcomeDone);
		div.innerHTML = `<h2>${esc(e.title || "Before You Start")}</h2><ul>${e.points.map((p, i) => `<li class="w-${i % 5}"><span class="w-ic" aria-hidden="true">${icon(p.icon || "check")}</span><span>${esc(p.text)}</span></li>`).join("")}</ul><button type="button" class="pill" data-welcome>Got It</button>`;
		return div;
	}
	div.className = "notice";
	div.innerHTML = `<div>${esc(e.text)}</div>${e.action ? `<button type="button" class="pill" data-send="${esc(e.action.send)}">${esc(e.action.label)}</button>` : ""}`;
	return div;
}

// A message sent mid-task joins the running turn, so every turn since the
// last done belongs to the same run and ends with its done.
const active = (t) => !t.done && t.i > settled && status.working;
const openByDefault = (t) =>
	settings.steps === "open" || (settings.steps !== "closed" && active(t));
const waitingAsk = (t) => t.asks.find((a) => !t.answers[a.ref]);

function youEl(e, queued) {
	const files = (e.files || [])
		.map((f) =>
			isImage(f)
				? `<button type="button" class="thumb" data-open="${esc(f.url)}" aria-label="Open ${esc(f.name)}"><img src="${thumb(f.url, 176)}" alt="" width="176" height="176" loading="lazy" decoding="async"></button>`
				: `<button type="button" class="mini-file" data-open="${esc(f.url)}">${icon("doc")}<span>${esc(f.name)}</span></button>`,
		)
		.join("");
	const saved = shortcuts.some((s) => s.text.trim() === (e.text || "").trim());
	const actions =
		!queued && selected === e.cid && e.text
			? `<div class="you-actions">
        ${moreOpen ? `<span class="more"><button type="button" class="pill" data-again="${esc(e.cid)}">${icon("redo")}Send Again</button><button type="button" class="pill" data-copy="${esc(e.cid)}">${icon("copy")}Copy</button></span>` : ""}
        <span class="split"><button type="button" data-save="${esc(e.cid)}" ${saved ? "disabled" : ""}>${icon("star")}${saved ? "Saved as Shortcut" : "Save as Shortcut"}</button><button type="button" data-more aria-label="More Actions" aria-expanded="${moreOpen}">${icon("chev")}</button></span>
      </div>`
			: "";
	const meta = queued
		? `${icon("clock")}Waiting to send`
		: e.scheduled
			? `${icon("clock")}<span class="sr">Scheduled, </span>${esc(e.scheduled)} at ${clock(e.at)}`
			: clock(e.at);
	return `<div class="you${queued ? " queued" : ""}" data-eid="${esc(e.id ?? "")}">
      ${files ? `<div class="you-files">${files}</div>` : ""}
      ${e.text ? `<button type="button" class="bubble" data-cid="${esc(e.cid)}" aria-expanded="${selected === e.cid}">${esc(e.text)}</button>` : ""}
      <span class="meta${queued || e.scheduled ? "" : " time"}">${meta}</span>${actions}</div>`;
}

function runEl(t) {
	const live = active(t);
	if (!(t.steps.length > 0 || live)) return "";
	const ask = waitingAsk(t);
	const open = t.open ?? openByDefault(t);
	let state;
	let sum;
	const n = t.steps.length;
	const count = `<span class="nw">${n} step${n === 1 ? "" : "s"}</span>`;
	if (live && ask) {
		state = "wait";
		sum = `<b>Waiting for you</b> · ${count}`;
	} else if (live) {
		state = "go";
		sum = `<b>${esc(status.label || "Working")}</b>${n ? ` · ${count}` : ""}`;
	} else if (t.done?.stopped) {
		state = "stopped";
		sum = `<b>Stopped</b> · ${count}`;
	} else if (t.done && !t.done.ok) {
		state = "bad";
		sum = `<b>Didn't finish</b> · ${count}`;
	} else if (t.done) {
		state = "ok";
		sum = `<b>Done</b> · ${count} · ${took(t.done.ms)}`;
	} else {
		state = "stopped";
		sum = count;
	}
	const start = Date.parse(t.at);
	const steps = open
		? `<ol class="steps">${t.steps
				.map((s, i) => {
					const bad = t.failed[s.ref];
					const isLive = live && !ask && i === n - 1 && !bad;
					const raw = t.raw.has(s.ref);
					return `<li class="step${bad ? " bad" : ""}${isLive ? " live" : ""}${s.sub ? " sub" : ""}">
        <button type="button" data-raw="${esc(s.ref)}" aria-expanded="${raw}"><span class="dotk">${isLive ? loader() : shape(bad ? "clover" : "circle")}</span><span class="label">${bad ? '<span class="sr">Failed: </span>' : ""}${esc(s.title)}</span><span class="when">${mmss(Date.parse(s.at) - start)}</span></button>
        ${bad ? `<div class="err">${esc(bad)}</div>` : ""}
        ${raw ? `<pre class="raw">${esc(s.detail || "")}</pre><div class="raw-tools"><button type="button" class="link-btn" data-copyraw="${esc(s.ref)}">${icon("copy")}Copy</button></div>` : ""}
      </li>`;
				})
				.join("")}</ol>`
		: "";
	return `<div class="run${open ? " open" : ""}${live ? " live" : ""}${live && ask ? " wait" : ""}">
      <button type="button" class="run-head" data-run="${esc(t.id)}" aria-expanded="${open}">${mark(state)}<span class="sum">${sum}</span>${n ? icon("chev") : ""}</button>
      ${steps}</div>`;
}

function askEl(t, a) {
	const given = t.answers[a.ref];
	const what = esc(a.plain || a.title);
	if (given?.by === "timeout")
		return `<div class="answered" data-answered="${esc(a.ref)}">${mark("wait")}<span>No answer in time: ${what}</span><button type="button" class="link-btn" data-askagain="${esc(a.ref)}">Ask Me Again</button></div>`;
	if (given)
		return `<div class="answered" data-answered="${esc(a.ref)}">${mark(given.allow ? "ok" : "stopped")}<span>${given.always ? "Always allowed" : given.allow ? "Allowed" : "Denied"}: ${what}</span></div>`;
	if (t.done)
		return `<div class="answered">${mark("stopped")}<span>Not answered: ${what}</span></div>`;
	const raw = t.raw.has(a.ref);
	return `<div class="ask" data-ask="${esc(a.ref)}" data-eid="${esc(a.id)}">
      <div class="ask-top"><span class="ask-mark">${shape("burst")}${icon("shield")}</span><h2>${esc(a.title)}</h2></div>
      ${a.from ? `<p class="ask-from">${esc(a.from)}</p>` : ""}
      ${a.facts?.length ? `<ul class="ask-facts">${a.facts.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` : ""}
      ${a.why ? `<p class="ask-why"><span>The agent says</span>${esc(a.why)}</p>` : ""}
      ${a.detail ? `<button type="button" class="link-btn ask-more" data-raw="${esc(a.ref)}" aria-expanded="${raw}">${icon("chev")}${raw ? "Hide the Details" : "Show the Details"}</button>${raw ? `<pre>${esc(a.detail)}</pre>` : ""}` : ""}
      <div class="ask-row" role="group" aria-label="Needs your OK"><button type="button" class="deny" data-answer="${esc(a.ref)}" data-allow="0">Deny</button><button type="button" class="allow" data-answer="${esc(a.ref)}" data-allow="1">Allow</button></div>
      ${a.always ? `<button type="button" class="link-btn ask-always" data-answer="${esc(a.ref)}" data-allow="1" data-always="1">Always Allow This Exact Command</button>` : ""}
    </div>`;
}

// What the guard turned down, and what got saved to memory.
function noteEl(e) {
	if (e.kind === "blocked")
		return `<div class="guard" data-eid="${esc(e.id)}">${mark("stopped")}<span><b>${esc(e.label || "Not allowed")}: ${esc(e.title)}</b>${e.text ? `<span>${esc(e.text)}</span>` : ""}</span></div>`;
	const lines = [];
	if (e.added?.length)
		lines.push(
			`<b>Saved to memory</b>${e.added.map((l) => `<span>${esc(l)}</span>`).join("")}`,
		);
	if (e.removed?.length)
		lines.push(
			`<b>Taken out of memory</b>${e.removed.map((l) => `<span>${esc(l)}</span>`).join("")}`,
		);
	return `<div class="saved" data-eid="${esc(e.id)}">${icon("star")}<span>${lines.join("")}</span><button type="button" class="link-btn" data-menu="memory">See Memory</button></div>`;
}

const fileIcon = (name = "flower") =>
	`<span class="fi">${shape(name)}${icon("doc")}</span>`;
function outEl(e) {
	if (e.kind === "reply" && e.silent)
		return `<div class="end quiet" data-eid="${esc(e.id)}">${icon("check")}Nothing to report</div>`;
	if (e.kind === "reply")
		return `<div class="reply" data-eid="${esc(e.id)}">${md(e.text)}</div>`;
	if (isImage(e))
		return `<button type="button" class="photo" data-open="${esc(e.url)}" data-eid="${esc(e.id)}"><img src="${thumb(e.url, 300)}" alt="" loading="lazy" decoding="async"><span>${esc(e.caption || e.name)}</span></button>`;
	return `<button type="button" class="file" data-open="${esc(e.url)}" data-eid="${esc(e.id)}">${fileIcon()}<span><span class="fn">${esc(e.name)}</span><br><span class="fs">${esc(e.caption ? `${e.caption} · ` : "")}${bytes(e.size || 0)}</span></span></button>`;
}

function turnEl(t) {
	const div = document.createElement("div");
	div.className = "turn";
	let end = "";
	if (t.done?.stopped) end = `<div class="end">Stopped after ${took(t.done.ms)}</div>`;
	else if (t.done && !t.done.ok)
		end = `<div class="end">${esc(t.done.error || "This one didn't finish.")}</div>`;
	// A task that changed files can be put back to the snapshot taken as it
	// started. macOS keeps local snapshots for about a day.
	const changed =
		t.done &&
		!active(t) &&
		t.snap &&
		Date.now() - Date.parse(t.snap.at) < 24 * 3_600_000 &&
		t.steps.some((s) => s.effect === "change" || s.effect === "delete");
	const back = changed
		? `<button type="button" class="pill restore" data-restore="${esc(t.id)}">${icon("redo")}Put Things Back to ${clock(t.snap.at)}</button>`
		: "";
	div.innerHTML =
		(t.you ? youEl(t.you) : "") +
		runEl(t) +
		t.asks.map((a) => askEl(t, a)).join("") +
		t.notes.map(noteEl).join("") +
		t.out.map(outEl).join("") +
		end +
		back;
	return div;
}

// While he was away

// What finished while the app was closed, grouped by what it means for
// him rather than by task.
const seenKey = "lab-seen";
const lastSeen = () => {
	try {
		return Number(localStorage.getItem(seenKey)) || 0;
	} catch {
		return 0;
	}
};
const markSeen = () => {
	try {
		localStorage.setItem(seenKey, String(Date.now()));
	} catch {
		// Storage can be refused, and then the digest just shows again next time.
	}
};
const digestEl = document.createElement("section");
digestEl.className = "digest";
digestEl.hidden = true;
digestEl.setAttribute("aria-labelledby", "digest-title");
let digestFirst = null;
const titleList = (xs) =>
	xs
		.slice(0, 3)
		.map((x) => esc(x.title))
		.join(", ") + (xs.length > 3 ? `, and ${xs.length - 3} more` : "");
const countOf = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
function drawDigest(since) {
	const turns = items.filter(
		(t) => t.type === "turn" && t.done && Date.parse(t.done.at) > since,
	);
	if (
		!since ||
		Date.now() - since < 10 * 60_000 ||
		turns.length === 0 ||
		settings.digest === false
	)
		return;
	const of = (effect) =>
		turns.flatMap((t) => t.steps.filter((s) => s.effect === effect));
	const sent = of("send");
	const gone = of("delete");
	const changed = of("change");
	const system = of("system");
	const missed = turns.flatMap((t) =>
		t.asks.filter((a) => t.answers[a.ref]?.by === "timeout"),
	);
	const failed = turns.filter((t) => !(t.done.ok || t.done.stopped));
	const ran = turns.filter((t) => t.you?.scheduled);
	const rows = [
		sent.length > 0 && ["send", "Sent off the computer", titleList(sent)],
		gone.length > 0 && ["delete", "Deleted or moved to the Trash", titleList(gone)],
		system.length > 0 && ["system", "Installed or changed settings", titleList(system)],
		changed.length > 0 && ["change", "Changed files", titleList(changed)],
		missed.length > 0 && [
			"wait",
			`${countOf(missed.length, "question")} not answered in time`,
			titleList(missed.map((a) => ({ title: a.plain || a.title }))),
		],
		failed.length > 0 && [
			"bad",
			`${countOf(failed.length, "task")} didn't finish`,
			titleList(failed.map((t) => ({ title: t.you?.text || "A task" }))),
		],
	].filter(Boolean);
	const snap = turns.find((t) => t.snap)?.snap;
	digestFirst = turns[0].you?.id ?? null;
	setHTML(
		digestEl,
		`<h2 id="digest-title">While You Were Away</h2>
      <p class="digest-sum">${countOf(turns.length, "task")} finished${ran.length > 0 ? `, ${ran.length} of ${turns.length === 1 ? "it" : "them"} scheduled` : ""}.${rows.length > 0 ? "" : " Nothing was sent, deleted or changed."}</p>
      ${rows.length > 0 ? `<ul>${rows.map(([k, label, names]) => `<li class="dg-${k}"><b>${label}</b><span>${names}</span></li>`).join("")}</ul>` : ""}
      ${snap ? `<p class="digest-snap">${icon("redo")}<span>A Time Machine snapshot from ${shortDay(snap.at)}${dayLabel(snap.at) === "Today" ? "" : ` at ${clock(snap.at)}`} can put things back.</span></p>` : ""}
      <div class="digest-btns">${digestFirst !== null ? '<button type="button" class="pill" data-digest="show">Show Me</button>' : ""}<button type="button" class="pill" data-digest="close">Got It</button></div>`,
	);
	digestEl.hidden = false;
	if (booted) toBottom();
}
document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		markSeen();
		return;
	}
	flushNow();
	drawDigest(lastSeen());
	markSeen();
});

function drawQueue() {
	setHTML(
		queue,
		outbox
			.map((m) => `<div class="turn">${youEl({ ...m, id: "" }, true)}</div>`)
			.join(""),
	);
	if (booted) toBottom();
}

// The top bar. Every widget is an entry in Widgets that says what to show,
// and one tile drawing handles every size, so adding a widget is adding an
// entry. `data` returns null to leave the tile out, and a widget that throws
// is skipped and reported instead of breaking the header.
//   name, about   how it's listed when he adds widgets
//   sizes         which of small, wide, long and big it fits, first is the default
//   tone          sun, mint, pink, lilac or deep (the header's own colour)
//   data()        { value, label, detail, meter (0 to 1), icon }
//   tap()         what a tap does. Without it, a tap opens the details.
const SizeNames = { small: "Small", wide: "Wide", long: "Full Width", big: "Big" };
const upFor = () => (mac ? uptime(mac.uptime).split(",")[0] : "");
const used = (x) => (x?.total ? 1 - x.free / x.total : null);
const Widgets = {
	status: {
		name: "Connection",
		about: "Online, and how long the computer has been up",
		sizes: ["small", "wide"],
		tone: () => (link.state === "online" ? "pink" : "off"),
		data: () =>
			link.state === "unpaired"
				? { value: "Not paired", label: "" }
				: link.state === "connecting"
					? { value: "Connecting", label: mac ? `up ${upFor()}` : "" }
					: link.state !== "online"
						? { value: "Offline", label: mac ? `seen ${ago(mac.at)}` : "" }
						: {
								value: "Online",
								label: mac ? `up ${upFor()}` : "",
								detail: mac?.name,
							},
	},
	battery: {
		name: "Battery",
		about: "Charge, and whether it is plugged in",
		sizes: ["small", "wide", "long"],
		tone: () =>
			mac?.battery && mac.battery.percent <= 20 && !mac.battery.charging
				? "pink"
				: "sun",
		data: () =>
			!mac
				? null
				: !mac.battery
					? { value: "Plugged in", label: "No battery", icon: "bolt" }
					: {
							value: `${mac.battery.percent}%`,
							label: mac.battery.charging ? "Charging" : "On battery",
							icon: mac.battery.charging ? "bolt" : "",
							meter: mac.battery.percent / 100,
						},
	},
	storage: {
		name: "Storage",
		about: "Free space on the disk",
		sizes: ["wide", "small", "long", "big"],
		tone: () => "mint",
		data: () =>
			mac && {
				value: `${bytes(mac.disk.free)} free`,
				short: bytes(mac.disk.free),
				label: `of ${bytes(mac.disk.total)}`,
				meter: used(mac.disk),
			},
	},
	memory: {
		name: "Memory",
		about: "Free memory for apps",
		sizes: ["wide", "small", "long", "big"],
		tone: () => "lilac",
		data: () =>
			mac?.memory && {
				value: `${bytes(mac.memory.free)} free`,
				short: bytes(mac.memory.free),
				label: `of ${bytes(mac.memory.total)} memory`,
				meter: used(mac.memory),
			},
	},
	cpu: {
		name: "Processor",
		about: "How busy the computer is",
		sizes: ["small", "wide", "long"],
		tone: () => "deep",
		data: () =>
			mac &&
			typeof mac.cpu === "number" && {
				value: `${mac.cpu}%`,
				label: "Processor",
				meter: mac.cpu / 100,
			},
	},
	name: {
		name: "Name",
		about: "What this phone calls the computer",
		sizes: ["wide", "long", "small"],
		tone: () => "lilac",
		data: () =>
			mac && {
				value: mac.name,
				label:
					mac.os === "windows" ? "Windows PC" : mac.os === "linux" ? "Linux" : "Mac",
			},
		tap: () => openRename(),
	},
	uptime: {
		name: "Up Time",
		about: "How long since the computer last restarted",
		sizes: ["small", "wide"],
		tone: () => "deep",
		data: () => mac && { value: upFor(), label: "Up for", icon: "clock" },
	},
	task: {
		name: "Agent",
		about: "What the agent is doing right now",
		sizes: ["wide", "long", "small"],
		tone: () => (status.working ? "mint" : "deep"),
		data: () => {
			const last = items.findLast?.((t) => t.type === "turn" && t.done);
			return status.working
				? { value: "Working", label: status.label || "", icon: "redo" }
				: {
						value: "Ready",
						label: last ? `Last task ${ago(last.done.at)}` : "Nothing asked yet",
						icon: "check",
					};
		},
		tap: () => {
			const t = cur || items.findLast?.((x) => x.type === "turn");
			if (t?.you) jump(t.you.id);
		},
	},
	model: {
		name: "Model",
		about: "Which model the agent uses",
		sizes: ["wide", "long", "small"],
		tone: () => "deep",
		data: () => ({ value: modelName(), label: "Model", icon: "star" }),
		tap: () => openModels(),
	},
	next: {
		name: "Next Schedule",
		about: "The next scheduled message",
		sizes: ["wide", "long", "big"],
		tone: () => "sun",
		data: () => {
			const n = (upcoming || [])
				.filter((s) => s.next && !s.paused)
				.toSorted((a, b) => Date.parse(a.next) - Date.parse(b.next))[0];
			return n
				? {
						value: n.label,
						label: `${dayLabel(n.next) === "Today" ? "Today" : shortDay(n.next)} at ${clock(n.next)}`,
						icon: "clock",
					}
				: { value: "Nothing scheduled", label: "Schedules", icon: "clock" };
		},
		tap: () => load("schedules", "Schedules", "/schedules", drawSchedules),
	},
	today: {
		name: "Today",
		about: "How much you asked for today",
		sizes: ["small", "wide"],
		tone: () => "lilac",
		data: () => {
			const key = new Date().toDateString();
			const n = items.filter(
				(t) => t.type === "turn" && t.you && dayKey(t.you.at) === key,
			).length;
			return {
				value: String(n),
				label: n === 1 ? "request today" : "requests today",
			};
		},
	},
};

// What to call the model he picked, from the last list the computer sent.
let modelList = null;
const modelName = () => {
	const id = settings.model;
	if (!id) return "Default";
	return modelList?.choices.find((m) => m.id === id)?.name || id;
};
// For the Next Schedule widget, asked for at start and after any change.
let upcoming = null;
const refreshSchedules = async () => {
	let r;
	try {
		r = await call("GET", "/schedules");
	} catch {
		// The widget keeps the last list it had until the next try.
		return;
	}
	upcoming = r.items;
	drawGlance();
};

const glance = $("glance");
const detailRow = (k, v) => `<span>${k}</span><b>${v}</b>`;
let glanceOpen = false;
const tile = (w) => {
	const def = Widgets[w.id];
	if (!def) return "";
	const d = def.data();
	if (!d) return "";
	const size = def.sizes.includes(w.size) ? w.size : def.sizes[0];
	const meter =
		typeof d.meter === "number" && size !== "small"
			? `<span class="t-meter"><i style="width:${Math.round(Math.min(1, Math.max(0, d.meter)) * 100)}%"></i></span>`
			: "";
	const value = size === "small" && d.short ? d.short : d.value;
	const spoken = [d.value, d.label, d.detail].filter(Boolean).join(", ");
	return `<button type="button" class="widget t-${size} tone-${def.tone()}" data-widget="${esc(w.id)}" aria-label="${esc(spoken)}">
      <span class="t-value">${d.icon ? icon(d.icon) : ""}<span>${esc(value)}</span></span>
      ${d.label ? `<span class="t-label">${esc(d.label)}</span>` : ""}
      ${d.detail && (size === "long" || size === "big") ? `<span class="t-detail">${esc(d.detail)}</span>` : ""}${meter}</button>`;
};
function drawGlance() {
	const hidden = Boolean(settings.topBarHidden);
	head.classList.toggle("bar-hidden", hidden);
	glance.classList.toggle("off", link.state !== "online");
	// The title always says which computer this is and whether it's there.
	const where =
		link.state === "online"
			? "Online"
			: link.state === "connecting"
				? "Connecting"
				: link.state === "unpaired"
					? "Not paired"
					: "Offline";
	setText($("head-sub"), mac ? `${mac.name} · ${where}` : where);
	$("fold-head").setAttribute(
		"aria-label",
		hidden ? "Show the Top Bar" : "Hide the Top Bar",
	);
	$("fold-head").setAttribute("aria-expanded", String(!hidden));
	refocus(
		glance,
		() =>
			setHTML(
				glance,
				hidden
					? ""
					: settings.topBar
							.map((w) => guard(`the ${w.id} widget`, () => tile(w), ""))
							.join(""),
			),
		() => $("fold-head"),
	);
	glance.hidden = hidden || glance.children.length === 0;
	const details = $("glance-more");
	details.hidden = hidden || !glanceOpen || !mac;
	if (!details.hidden) {
		setHTML(
			details,
			`${detailRow("Name", `<span class="name-row"><span>${esc(mac.name)}</span><button type="button" class="link-btn rename" data-rename>${icon("edit")}Rename</button></span>`)}
        ${detailRow("Battery", mac.battery ? `${mac.battery.percent}%, ${mac.battery.charging ? "charging" : "on battery"}` : "Plugged in, no battery")}
        ${detailRow("Storage", `${bytes(mac.disk.free)} free of ${bytes(mac.disk.total)}`)}
        ${mac.memory ? detailRow("Memory", `${bytes(mac.memory.free)} free of ${bytes(mac.memory.total)}`) : ""}
        ${typeof mac.cpu === "number" ? detailRow("Processor", `${mac.cpu}% busy`) : ""}
        ${detailRow("Up for", uptime(mac.uptime))}
        ${detailRow("Updated", ago(mac.at))}
        <div class="more-btns"><button type="button" class="link-btn" data-topbar>${icon("edit")}Edit the Top Bar</button><button type="button" class="link-btn" data-hidemore>${icon("chev")}Hide Details</button></div>`,
		);
	}
}
function toggleGlance(open) {
	glanceOpen = open;
	drawGlance();
	backing();
}

// Edit the Top Bar: each change saves at once, so the header behind the
// sheet shows it straight away.
function openTopBar() {
	const bar = settings.topBar;
	const inBar = new Set(bar.map((w) => w.id));
	const rows = bar
		.map((w, i) => {
			const def = Widgets[w.id];
			if (!def)
				return `<li class="tb-row"><span class="tb-name"><b>${esc(w.id)}</b><span>This widget isn't in this version of the app.</span></span><button type="button" class="icon-btn" data-tbremove="${i}" aria-label="Remove ${esc(w.id)}">${icon("trash")}</button></li>`;
			const size = def.sizes.includes(w.size) ? w.size : def.sizes[0];
			return `<li class="tb-row">
        <span class="tb-name"><b>${esc(def.name)}</b><span>${esc(def.about)}</span></span>
        <span class="tb-tools">
          <button type="button" class="icon-btn" data-tbmove="${i}:-1" aria-label="Move ${esc(def.name)} earlier"${i === 0 ? " disabled" : ""}><svg class="ic up" aria-hidden="true"><use href="#i-chev"/></svg></button>
          <button type="button" class="icon-btn" data-tbmove="${i}:1" aria-label="Move ${esc(def.name)} later"${i === bar.length - 1 ? " disabled" : ""}>${icon("chev")}</button>
          <button type="button" class="icon-btn" data-tbremove="${i}" aria-label="Remove ${esc(def.name)}">${icon("trash")}</button>
        </span>
        ${def.sizes.length > 1 ? `<span class="seg" role="radiogroup" aria-label="Size of ${esc(def.name)}">${def.sizes.map((s) => `<button type="button" role="radio" aria-checked="${s === size}" data-tbsize="${i}:${s}">${SizeNames[s]}</button>`).join("")}</span>` : ""}
      </li>`;
		})
		.join("");
	const spare = Object.entries(Widgets).filter(([id]) => !inBar.has(id));
	openSheet(
		"topbar",
		"Edit the Top Bar",
		`${bar.length > 0 ? `<ul class="tb-list">${rows}</ul>` : '<p class="hint">The top bar is empty. Add a widget below.</p>'}
      ${spare.length > 0 ? `<h3>Add a Widget</h3><ul class="tb-list">${spare.map(([id, def]) => `<li class="tb-row add"><span class="tb-name"><b>${esc(def.name)}</b><span>${esc(def.about)}</span></span><button type="button" class="pill" data-tbadd="${esc(id)}">${icon("plus")}Add</button></li>`).join("")}</ul>` : ""}
      <button type="button" class="link-btn tb-reset" data-tbreset>${icon("redo")}Put Back the Usual Widgets</button>`,
		'<button type="button" class="primary" data-close>Done</button>',
	);
}
// A failed save puts the old bar back, so the sheet is drawn again from it
// and no button is left pointing at a row that's gone.
const editBar = async (fn, focus) => {
	const draft = settings.topBar.map((w) => ({ ...w }));
	fn(draft);
	const next = draft.filter(Boolean);
	const save = saveSettings({ topBar: next });
	const redraw = () => {
		if (sheetKind !== "topbar") return;
		openTopBar();
		((focus && sheet.querySelector(focus)) || $("sheet-title")).focus();
	};
	redraw();
	await save;
	if (settings.topBar !== next) redraw();
};

// The header gives its height to the conversation while reading history,
// while search or files are open, with large text, and whenever the screen
// is short. Short screens also dock the toolbar (the `tight` class).
const head = $("head");
const app = $("app");
// A view that's animating closed is drawn but counts as closed.
const shown = (el) => !(el.hidden || el.leaving);
const overlay = () => shown($("files-view")) || !$("search-row").hidden;
// The probe is "Write a message" set at 16 px, which is 117 px wide in
// Roboto Flex. Drawn wider than that, the phone's font size is turned up.
let bigText = false;
function measure() {
	bigText =
		$("probe").getBoundingClientRect().width > 117 * 1.15 ||
		Number.parseFloat(getComputedStyle($("probe")).fontSize) > 18 ||
		(Number(settings.textSize) || 100) >= 130;
	root.classList.toggle("big-text", bigText);
}
function fold() {
	const tight = innerHeight < 560 || root.hasAttribute("data-keyboard");
	app.classList.toggle("tight", tight);
	const d = fromBottom();
	// A waiting question needs the room more than the stats do.
	const asking = !$("now").hidden && $("now").classList.contains("asking");
	const was = head.classList.contains("compact");
	const compact =
		tight || bigText || overlay() || asking || d > 300 ? true : d < 60 ? false : was;
	if (compact === was) return;
	const topBefore = thread.getBoundingClientRect().top;
	head.classList.toggle("compact", compact);
	// What he's reading stays put on screen while the header changes height.
	if (!pinned) thread.scrollTop += thread.getBoundingClientRect().top - topBefore;
}
let threadH = 0;
// Set once the shell says the whole history is in, so an empty list
// isn't claimed while it's still on its way.
let loaded = false;
thread.addEventListener(
	"scroll",
	() => {
		if (thread.clientHeight === threadH) pinned = nearBottom();
		threadH = thread.clientHeight;
		fold();
		if (pinned && !frame && !filling && !overlay()) trim();
	},
	{ passive: true },
);
new MutationObserver(() => {
	posture();
	fold();
}).observe(root, {
	attributes: true,
	attributeFilter: ["data-keyboard", "data-fold"],
});
// This waits a frame, so the padding it changes can't feed back into the
// sizes observed in the same frame.
new ResizeObserver(() =>
	requestAnimationFrame(() => {
		app.style.setProperty("--now-h", `${$("now").offsetHeight || 72}px`);
		if (pinned) toBottom();
	}),
).observe($("now"));
// Late growth keeps him at the newest message: a photo that only has a size
// once it loads, or turns that skip layout until they're on screen.
const stay = new ResizeObserver(() => {
	if (pinned) toBottom();
});
stay.observe(thread);
stay.observe(log);

// Half open, nothing sits on the hinge. The shell sets data-fold, and
// viewport segments are the fallback where the WebView reports them.
const segs = [
	matchMedia("(horizontal-viewport-segments: 2)"),
	matchMedia("(vertical-viewport-segments: 2)"),
];
function posture() {
	root.classList.toggle("book", root.dataset.fold === "book" || segs[0].matches);
	root.classList.toggle("table", root.dataset.fold === "tabletop" || segs[1].matches);
}
for (const m of segs) m.addEventListener("change", posture);
posture();

let tick = null;
// While it works the toolbar mark springs to the next shape every other
// second. Each change is a transition on `d`, so it only lays out while
// it moves, where a looping morph lays out every frame.
const Cycle = ["burst", "cookie", "pentagon", "clover"];
let beat = 0;
let tickFor = "";
function drawNow() {
	const bar = $("now");
	if (!status.working && bar.contains(document.activeElement)) focusSoft(text);
	bar.hidden = !status.working;
	thread.classList.toggle("under-now", status.working);
	drawGlance();
	if (!status.working) {
		clearInterval(tick);
		tick = null;
		tickFor = "";
		return;
	}
	const ask = cur && waitingAsk(cur);
	bar.classList.toggle("asking", Boolean(ask));
	setText($("now-label"), ask ? "Needs your OK" : status.label || "Working");
	$("now-jump").hidden = !ask;
	fold();
	// An ask counts from when it was asked, and work from when the run began.
	const since = Date.parse(ask ? ask.at : status.since || cur?.at);
	// A new label every step mustn't restart the clock or the mark's beat.
	if (tick && tickFor === `${ask?.ref}:${since}`) return;
	clearInterval(tick);
	tickFor = `${ask?.ref}:${since}`;
	const upd = () => {
		if (document.hidden) return;
		setText(
			$("now-time"),
			ask
				? `Asked ${mmss(Date.now() - since)} ago`
				: `Working for ${mmss(Date.now() - since)}`,
		);
		if (!ask && beat++ % 2 === 0)
			$("now-mark")
				.querySelector(".shape")
				.setAttribute("class", `shape s-${Cycle[Math.floor(beat / 2) % 4]}`);
	};
	upd();
	tick = setInterval(upd, 1000);
}

function drawLink(was) {
	const show = link.state === "offline" || link.state === "unpaired";
	const stick = nearBottom();
	$("banner").hidden = !show;
	setText($("banner-text"), link.detail || "Can't reach the computer.");
	$("banner-fix").hidden = link.fix !== "tailscale";
	$("banner-retry").hidden = link.state === "unpaired";
	if (stick && booted) toBottom();
	if (booted && was !== link.state) {
		if (show) say(link.detail || "Can't reach the computer.");
		else if (link.state === "online" && (was === "offline" || was === "unpaired"))
			say("Connected to the computer again.");
	}
}

// More: memory, schedules, always-allowed commands and the setup check

const call = (method, path, body) =>
	lab.call
		? lab.call(method, path, body)
		: Promise.reject(
				new Error(
					"This version of the app is too old for that. Update it from the computer.",
				),
			);
const offline = (err) =>
	`<p class="hint">${esc(err?.message && !/fetch|network/i.test(err.message) ? err.message : "Couldn't reach the computer. Try again once it's back.")}</p>`;
const closeBtn = '<button type="button" data-close>Close</button>';
// Settings live in settings.json on the computer, so the agent can change them
// too. Every row in the Settings sheet is an entry here.
//   key      the field in settings.json, for switch and choice rows
//   type     switch, choice (options are [value, label]) or open (runs open())
//   hint     a line under the label, or a function that returns one
//   apply    what changing it redraws, if anything beyond applySettings()
const redrawTurns = () => {
	for (const it of items) if (it.type === "turn" && it.el) dirty.add(it);
	want.side = true;
	schedule();
};
const thinking = {
	key: "effort",
	type: "choice",
	label: "Thinking",
	hint: "Quick answers sooner. Thorough takes longer over hard tasks.",
	options: [
		["low", "Quick"],
		[null, "Normal"],
		["high", "Thorough"],
	],
	apply: () => drawChips(),
};
const Settings = [
	{ head: "Agent" },
	{ type: "open", label: "Model", hint: () => modelName(), open: () => openModels() },
	thinking,
	{
		key: "replies",
		type: "choice",
		label: "Replies",
		hint: "How much the agent writes back",
		options: [
			["short", "Short"],
			["normal", "Normal"],
			["long", "Detailed"],
		],
	},
	{
		type: "open",
		label: "Notifications",
		hint: "Sounds, vibration and what shows on the lock screen",
		open: () => lab.fix?.("notifications"),
	},
	{
		key: "statusCard",
		type: "choice",
		label: "Status Card",
		hint: "Whether the card in your notifications comes back after you swipe it away",
		options: [
			["tasks", "Each Task"],
			["always", "Always"],
			["never", "Never"],
		],
	},
	{
		type: "open",
		label: "Rename This Computer",
		hint: () => mac?.name || "",
		open: () => openRename(),
	},
	{
		type: "open",
		label: "Show the Welcome Card Again",
		open: async () => {
			closeSheet();
			await saveSettings({ welcomeDone: false });
			// It's the first thing in the conversation, so a long history needs a jump back to it.
			const card = items.find((it) => it.type === "notice" && it.e.points);
			if (card) jump(card.e.id);
			else toast("This conversation doesn't have a welcome card.", true);
		},
	},
	{ head: "Top Bar" },
	{
		key: "topBarHidden",
		type: "switch",
		label: "Hide the Top Bar",
		hint: "Keeps the title and the name of the computer",
	},
	{
		type: "open",
		label: "Edit the Top Bar",
		hint: "Add, remove, resize and reorder widgets",
		open: () => openTopBar(),
	},
	{ head: "Look" },
	{
		key: "theme",
		type: "choice",
		label: "Theme",
		options: [
			["system", "Like the Phone"],
			["light", "Light"],
			["dark", "Dark"],
		],
	},
	{
		key: "textSize",
		type: "choice",
		label: "Text Size",
		options: [
			[100, "Default"],
			[115, "Large"],
			[130, "Largest"],
		],
		apply: () => {
			measure();
			fold();
		},
	},
	{
		key: "motion",
		type: "choice",
		label: "Animations",
		options: [
			["full", "All"],
			["calm", "Fewer"],
		],
	},
	{ head: "Conversation" },
	{
		key: "steps",
		type: "choice",
		label: "Steps",
		hint: "When the steps of a task show",
		options: [
			["live", "While Working"],
			["open", "Always"],
			["closed", "Tapped"],
		],
		apply: redrawTurns,
	},
	{ key: "times", type: "switch", label: "Show the Time on Messages" },
	{
		key: "chips",
		type: "switch",
		label: "Show Shortcuts Above the Message Box",
		apply: () => drawChips(),
	},
	{
		key: "modelChip",
		type: "switch",
		label: "Show the Model Above the Message Box",
		hint: "One tap to change the model or how hard it thinks",
		apply: () => drawChips(),
	},
	{
		key: "enterSends",
		type: "switch",
		label: "Enter Key Sends",
		hint: "Otherwise Enter starts a new line",
		apply: () => {
			text.enterKeyHint = settings.enterSends ? "send" : "enter";
		},
	},
	{
		key: "digest",
		type: "switch",
		label: "Sum Up What Happened While You Were Away",
	},
];
const urlTheme = root.dataset.theme;
function applySettings() {
	const s = settings;
	if (s.theme === "light" || s.theme === "dark") root.dataset.theme = s.theme;
	else if (urlTheme) root.dataset.theme = urlTheme;
	else delete root.dataset.theme;
	root.style.setProperty(
		"--ts",
		String(Math.min(1.6, Math.max(0.8, (Number(s.textSize) || 100) / 100))),
	);
	root.classList.toggle("calm", s.motion === "calm");
	root.classList.toggle("no-times", s.times === false);
	lab.statusCard?.(s.statusCard ?? "tasks");
}
async function saveSettings(change) {
	const was = settings;
	settings = { ...settings, ...change };
	settingsChanged(was);
	try {
		await call("POST", "/settings", { values: change });
	} catch (err) {
		const now = settings;
		settings = was;
		settingsChanged(now);
		toast(
			err.message || "Couldn't reach the computer, so that setting wasn't saved.",
			true,
		);
	}
}
function settingsChanged(was) {
	applySettings();
	for (const row of Settings)
		if (row.apply && was[row.key] !== settings[row.key])
			guard(`the ${row.label} setting`, row.apply);
	if (was.model !== settings.model) drawChips();
	if (was.welcomeDone !== settings.welcomeDone)
		for (const it of items)
			if (it.type === "notice" && it.e.points) {
				dirty.add(it);
				schedule();
			}
	drawGlance();
	fold();
}
function settingRow(row) {
	if (row.head) return `<h3>${esc(row.head)}</h3>`;
	const hint = typeof row.hint === "function" ? row.hint() : row.hint;
	const sub = hint ? `<span>${esc(hint)}</span>` : "";
	if (row.type === "switch")
		return `<label class="set-row"><span class="set-text"><b>${esc(row.label)}</b>${sub}</span><input type="checkbox" role="switch" class="switch" data-set="${esc(row.key)}"${settings[row.key] ? " checked" : ""}></label>`;
	if (row.type === "choice")
		return `<div class="set-row choice"><span class="set-text"><b id="set-${esc(row.key)}">${esc(row.label)}</b>${sub}</span><span class="seg" role="radiogroup" aria-labelledby="set-${esc(row.key)}">${row.options.map(([v, l]) => `<button type="button" role="radio" aria-checked="${String(settings[row.key]) === String(v)}" data-setkey="${esc(row.key)}" data-setval="${esc(JSON.stringify(v))}">${esc(l)}</button>`).join("")}</span></div>`;
	return `<button type="button" class="set-row open" data-setopen="${Settings.indexOf(row)}"><span class="set-text"><b>${esc(row.label)}</b>${sub}</span>${icon("chev")}</button>`;
}
function openSettings() {
	openSheet(
		"settings",
		"Settings",
		`<div class="set-list">${Settings.map((r) => guard(`the ${r.label || r.head} setting`, () => settingRow(r), "")).join("")}</div>`,
		closeBtn,
	);
}

// The list comes from whatever provider the agent is set up with, so it's
// asked for each time rather than written down here.
async function openModels() {
	openSheet(
		"models",
		"Model",
		'<p class="hint">Asking the computer which models it has</p>',
		closeBtn,
	);
	try {
		modelList = await call("GET", "/models");
	} catch (err) {
		if (sheetKind === "models") setHTML($("sheet-body"), offline(err));
		return;
	}
	if (sheetKind !== "models") return;
	drawModels();
}
function drawModels() {
	const m = modelList;
	const chosen = settings.model || "default";
	const listed = m.choices.some((c) => c.id === chosen);
	const choices = m.choices.some((c) => c.id === "default")
		? m.choices
		: [
				{
					id: "default",
					name: "Default",
					description: "Whatever the provider recommends",
				},
				...m.choices,
			];
	refocus(
		$("sheet-body"),
		() => {
			setHTML(
				$("sheet-body"),
				`<div class="set-list">${settingRow(thinking)}</div>
        <p class="hint">These are the models ${m.engine === "codex" ? "Codex" : "Claude"} on the computer can use right now${m.inUse ? `. It's running ${esc(m.inUse)}` : ""}. A change starts with your next message.</p>
        <ul class="model-list" role="radiogroup" aria-label="Model">${choices.map((c) => `<li><button type="button" role="radio" class="model-row" aria-checked="${c.id === chosen}" data-model="${esc(c.id)}"><span class="radio" aria-hidden="true"></span><span><b>${esc(c.name)}</b>${c.description ? `<span>${esc(c.description)}</span>` : ""}</span></button></li>`).join("")}</ul>
        <label for="model-other">Another Model</label>
        <div class="model-other"><input id="model-other" value="${listed || chosen === "default" ? "" : esc(chosen)}" placeholder="Its exact name" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done"><button type="button" class="pill" data-modelother>Use It</button></div>
        <p class="hint">For a model your provider has that isn't listed. Type its name exactly as the provider writes it.</p>`,
			);
		},
		() => $("sheet-title"),
	);
}
async function pickModel(id) {
	try {
		await call("POST", "/model", { model: id === "default" ? null : id });
		const was = settings;
		settings = { ...settings, model: id === "default" ? null : id };
		settingsChanged(was);
		if (sheetKind === "models") drawModels();
		toast(`It will use ${modelName()} from your next message.`);
	} catch (err) {
		toast(
			err.message || "Couldn't reach the computer, so the model wasn't changed.",
			true,
		);
	}
}
let memo = null;
let plan = null;
let rules = null;
let wipeArmed = false;
const menuRow = (k, ic, title, sub) =>
	`<li><button type="button" class="menu-row" data-menu="${k}"><span class="mr-ic">${icon(ic)}</span><span><b>${title}</b><span>${sub}</span></span></button></li>`;
function openMenu() {
	openSheet(
		"menu",
		"More",
		`<ul class="menu-list">
      ${menuRow("settings", "edit", "Settings", "The model, thinking, replies, theme and top bar")}
      ${menuRow("memory", "star", "Memory", "What the agent remembers about you")}
      ${menuRow("schedules", "clock", "Schedules", "Messages the computer sends itself on a timer")}
      ${menuRow("allowed", "shield", "Always Allowed", "Commands that run without asking")}
      ${menuRow("check", "check", "Check My Setup", "Whether the computer and this phone are ready")}
      ${menuRow("rename", "edit", "Rename This Computer", mac ? `It's called ${esc(mac.name)} on this phone` : "What this phone calls it")}
    </ul>`,
		closeBtn,
	);
}
async function load(kind, title, path, render) {
	openSheet(kind, title, '<p class="hint">Asking the computer</p>', closeBtn);
	try {
		const got = await call("GET", path);
		if (sheetKind === kind) render(got);
	} catch (err) {
		if (sheetKind === kind) setHTML($("sheet-body"), offline(err));
	}
}
function drawMemory(m) {
	memo = m;
	const pct = Math.min(100, Math.round((m.chars / m.cap) * 100));
	const part = (key, title, empty) =>
		`<h3>${title}</h3>${m[key].length > 0 ? `<ul class="sc-list">${m[key].map((l, i) => `<li><span class="sc-text mem-line">${esc(l)}</span><button type="button" class="icon-btn" data-forget="${key}:${i}" aria-label="Forget ${esc(l)}">${icon("trash")}</button></li>`).join("")}</ul>` : `<p class="hint">${empty}</p>`}`;
	refocus(
		$("sheet-body"),
		() => {
			setHTML(
				$("sheet-body"),
				`<div class="meter${pct >= 80 ? " full" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${m.cap}" aria-valuenow="${m.chars}" aria-label="Memory used"><i style="width:${pct}%"></i></div>
        <p class="hint">${m.chars.toLocaleString()} of ${m.cap.toLocaleString()} characters used.${pct >= 80 ? " When it fills up, the agent has to merge or drop older lines before it can add more." : ""}</p>
        ${m.paused ? '<p class="mem-paused">Memory is paused. The agent can read what is here but can\'t add to it.</p>' : ""}
        ${part("about", "About You", "Nothing yet. Tell the agent something about yourself and it will keep it here.")}
        ${part("notes", "Notes", "Nothing yet. The agent keeps notes on how you like things done.")}
        <div class="mem-btns"><button type="button" class="pill" data-mempause>${icon(m.paused ? "redo" : "pause")}${m.paused ? "Resume Memory" : "Pause Memory"}</button><button type="button" class="pill danger" data-memwipe>${icon("trash")}${wipeArmed ? "Tap Again to Forget Everything" : "Forget Everything"}</button></div>`,
			);
		},
		() => $("sheet-title"),
	);
	setHTML(
		$("sheet-actions"),
		'<button type="button" class="primary" data-close>Done</button>',
	);
}
async function saveMemory(change, done) {
	try {
		drawMemory(await call("POST", "/memory", change));
		if (done) toast(done);
	} catch (err) {
		toast(
			err.message || "Couldn't reach the computer, so memory wasn't changed.",
			true,
		);
	}
}
const Days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DayNames = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const hm = (t) => {
	const [h, m] = t.split(":").map(Number);
	return Hm.format(new Date(2000, 0, 1, h, m));
};
function when(s) {
	if (s.date)
		return `On ${Short.format(new Date(`${s.date}T${s.time}`))} at ${hm(s.time)}`;
	const d = s.days || [];
	const days =
		d.length === 0 || d.length === 7
			? "Every day"
			: d.length === 5 && !d.includes("sat") && !d.includes("sun")
				? "Weekdays"
				: d.map((x) => DayNames[Days.indexOf(x)].slice(0, 3)).join(", ");
	return `${days} at ${hm(s.time)}`;
}
const lastRun = (l) =>
	!l
		? "Hasn't run yet"
		: l.result === "failed"
			? l.fails > 1
				? `Failed the last ${l.fails} times`
				: `Failed ${shortDay(l.at)}`
			: l.result === "silent"
				? `Ran ${shortDay(l.at)}, nothing to report`
				: l.result === "stopped"
					? `Stopped ${shortDay(l.at)}`
					: `Ran ${shortDay(l.at)}`;
const nextRun = (s) => {
	if (s.paused) return "Paused";
	if (!s.next) return "Done";
	return `Next ${shortDay(s.next)}${dayLabel(s.next) === "Today" ? "" : ` at ${clock(s.next)}`}`;
};
const scheduleRow = (
	s,
	i,
) => `<li class="${s.paused ? "paused" : ""}${s.last?.fails >= 3 ? " failing" : ""}">
          <div class="sch-top"><b>${esc(s.label)}</b><span>${nextRun(s)}</span></div>
          <p class="sch-when">${when(s)}${s.quiet ? ", only when there's news" : ""}</p>
          <p class="sch-text">${esc(s.text)}</p>
          <p class="sch-last">${lastRun(s.last)}</p>
          <div class="sch-btns"><button type="button" class="pill" data-schpause="${i}">${icon(s.paused ? "redo" : "pause")}${s.paused ? "Resume" : "Pause"}</button><button type="button" class="pill" data-schedit="${i}">${icon("edit")}Edit</button><button type="button" class="icon-btn" data-schdel="${i}" aria-label="Delete ${esc(s.label)}">${icon("trash")}</button></div>
        </li>`;
function drawSchedules(r) {
	plan = r.items;
	refocus(
		$("sheet-body"),
		() => {
			setHTML(
				$("sheet-body"),

				plan.length > 0
					? `<ul class="sch-list">${plan.map(scheduleRow).join("")}</ul>`
					: '<p class="hint">Nothing is scheduled. Ask the agent something like "every weekday at 8, check my email and tell me what\'s new".</p>',
			);
		},
		() => $("sheet-title"),
	);
}
async function saveSchedules(list, done) {
	try {
		const r = await call("POST", "/schedules", { items: list });
		if (done) toast(done);
		upcoming = r.items;
		drawGlance();
		return r;
	} catch (err) {
		toast(
			err.message || "Couldn't reach the computer, so the schedule wasn't changed.",
			true,
		);
		return null;
	}
}
function editSchedule(i) {
	const s = plan[i];
	const days = s.days || [];
	openSheet(
		"schedit",
		`Edit ${s.label}`,
		`<label for="sch-label">Name</label><input id="sch-label" value="${esc(s.label)}" maxlength="40">
      <label for="sch-text">Sends</label><textarea id="sch-text" rows="3" maxlength="2000">${esc(s.text)}</textarea>
      <label for="sch-time">Time</label><input id="sch-time" type="time" value="${esc(s.time)}" required>
      ${s.date ? `<p class="hint">Runs once, on ${Short.format(new Date(`${s.date}T00:00`))}.</p>` : `<fieldset class="days"><legend>Days</legend>${Days.map((d, k) => `<label class="day-pick"><input type="checkbox" value="${d}"${days.includes(d) ? " checked" : ""}><span aria-hidden="true">${DayNames[k][0]}</span><span class="sr">${DayNames[k]}</span></label>`).join("")}</fieldset><p class="hint">With no days picked, it runs every day.</p>`}
      <label class="check"><input type="checkbox" id="sch-quiet"${s.quiet ? " checked" : ""}><span>Only tell me when there's something to report</span></label>`,
		`<button type="button" data-menu="schedules">Cancel</button><button type="button" class="primary" data-schsave="${i}">Save</button>`,
	);
}
function drawRules(r) {
	rules = r.items;
	refocus(
		$("sheet-body"),
		() => {
			setHTML(
				$("sheet-body"),

				rules.length > 0
					? `<ul class="sc-list">${rules.map((x, i) => `<li><div class="sc-fields"><b>${esc(x.plain)}</b><code class="rule-cmd">${esc(x.command)}</code><span class="sc-text">${esc(x.where || `In ${x.cwd}`)}</span></div><button type="button" class="pill" data-revoke="${i}">Remove</button></li>`).join("")}</ul>`
					: '<p class="hint">Nothing yet. When a card offers Always Allow This Exact Command and you tap it, that command shows up here and runs without asking next time.</p>',
			);
		},
		() => $("sheet-title"),
	);
}
async function openCheck() {
	openSheet(
		"check",
		"Check My Setup",
		'<p class="hint">Checking the computer and this phone</p>',
		closeBtn,
	);
	let got;
	try {
		got = lab.check ? await lab.check() : await call("GET", "/check");
	} catch (err) {
		if (sheetKind === "check") setHTML($("sheet-body"), offline(err));
		return;
	}
	if (sheetKind !== "check") return;
	const list = got.items || [];
	const bad = list.filter((x) => !x.ok).length;
	setHTML(
		$("sheet-body"),
		`<p class="hint">${bad ? `${bad} thing${bad === 1 ? "" : "s"} to fix.` : "Everything looks right."}</p><ul class="check-list">${list.map((x) => `<li class="${x.ok ? "ok" : "bad"}">${mark(x.ok ? "ok" : "bad")}<span><b>${esc(x.title)}</b>${x.detail ? `<span>${esc(x.detail)}</span>` : ""}</span>${x.fix ? `<button type="button" class="pill" data-checkfix="${esc(x.fix)}">Fix</button>` : ""}</li>`).join("")}</ul>`,
	);
	say(bad ? `${bad} thing${bad === 1 ? "" : "s"} to fix.` : "Everything looks right.");
}
function openRestore(t) {
	const at = clock(t.snap.at);
	openSheet(
		"restore",
		`Put Things Back to ${at}?`,
		`<p class="hint">The agent puts back what it changed or deleted in this task. Deleted things come back from the Trash first, then anything else from the Time Machine snapshot taken at ${at}. What you changed yourself since then stays as it is.</p>`,
		`<button type="button" data-close>Cancel</button><button type="button" class="primary" data-restoreok="${esc(t.id)}">Put Things Back</button>`,
	);
}

// Shortcuts

const effortWord = { low: "Quick", high: "Thorough" };
function drawChips() {
	const c = $("chips");
	const listed = shortcuts.length > 0 && settings.chips !== false;
	const model = settings.modelChip !== false;
	c.hidden = !(listed || model);
	const name = settings.model ? modelName() : "Model";
	const effort = effortWord[settings.effort];
	refocus(
		c,
		() => {
			setHTML(
				c,
				(model
					? `<button type="button" class="chip model" id="model-chip" aria-label="Model, ${esc(settings.model ? name : "Default")}${effort ? `, ${effort}` : ""}">${icon("star")}${esc(name)}${effort ? `<span class="chip-sub">${effort}</span>` : ""}</button>`
					: "") + (listed ? shortcutChips() : ""),
			);
		},
		() => text,
	);
	for (const t of items)
		if (t.type === "turn" && t.you && t.you.cid === selected) draw(t);
}
function shortcutChips() {
	return (
		shortcuts
			.map(
				(s) =>
					`<button type="button" class="chip" data-sc="${esc(s.id)}" title="${esc(s.text)}">${esc(s.label)}</button>`,
			)
			.join("") +
		`<button type="button" class="chip edit" id="manage">${icon("edit")}Edit</button>`
	);
}

// Bottom sheet

let sheetKind = null;
let sheetFrom = null;
let draft = [];
const focused = () =>
	document.activeElement && document.activeElement !== document.body
		? document.activeElement
		: null;
const restore = (el, fallback) => {
	(el?.isConnected && !el.closest("[inert]") ? el : fallback)?.focus({
		preventScroll: true,
	});
};
function openSheet(kind, title, body, actions) {
	const again = Boolean(sheetKind);
	if (!again) sheetFrom = focused();
	sheetKind = kind;
	$("sheet-title").textContent = title;
	setHTML($("sheet-body"), body);
	setHTML($("sheet-actions"), actions);
	arrive(sheet);
	arrive($("scrim"));
	backing();
	// Only New Shortcut and Rename open straight into typing. Elsewhere the keyboard would cover the actions.
	if (!again)
		(
			((kind === "new" || kind === "rename") &&
				$("sheet-body").querySelector("input, textarea")) ||
			$("sheet-title")
		).focus();
}
function closeSheet() {
	sheetKind = null;
	leave(sheet, "translateY(100%)");
	leave($("scrim"), "", true);
	backing();
	restore(sheetFrom, text);
}
function openRename() {
	openSheet(
		"rename",
		"Rename This Computer",
		`<label for="rename-to">Name</label><input id="rename-to" value="${esc(mac?.name ?? "")}" maxlength="40" autocomplete="off" enterkeyhint="done"><p class="hint">This is what the phone calls it, in the header and in notifications. Leave it blank to go back to the name the computer gives itself.</p>`,
		`<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savename>Save</button>`,
	);
}
function openManage() {
	if (sheetKind !== "manage") draft = shortcuts.map((s) => ({ ...s }));
	const list =
		draft.length > 0
			? `<ul class="sc-list">${draft.map((s, i) => `<li><div class="sc-fields"><input value="${esc(s.label)}" data-label="${i}" aria-label="Name for ${esc(s.text)}" maxlength="40"><span class="sc-text">${esc(s.text)}</span></div><button type="button" class="icon-btn" data-remove="${i}" aria-label="Remove ${esc(s.label)}">${icon("trash")}</button></li>`).join("")}</ul>`
			: `<p class="hint">No shortcuts left. Tap one of your messages and choose Save as Shortcut to add one.</p>`;
	openSheet(
		"manage",
		"Shortcuts",
		list,
		`<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savelist>Save</button>`,
	);
}
function openNewShortcut(message) {
	const label = message
		.split(/\s+/)
		.slice(0, 4)
		.join(" ")
		.replace(/[.,?!]+$/, "")
		.slice(0, 28);
	openSheet(
		"new",
		"New Shortcut",
		`<label for="sc-label">Name</label><input id="sc-label" value="${esc(label)}" maxlength="40"><label for="sc-text">Sends</label><textarea id="sc-text" rows="3" maxlength="2000">${esc(message)}</textarea>`,
		`<button type="button" data-close>Cancel</button><button type="button" class="primary" data-savenew>Save</button>`,
	);
}
async function saveList(list) {
	const ok = await lab.saveShortcuts(list);
	if (!ok) {
		toast(
			"Couldn't save the shortcuts because the computer can't be reached. Try again once it's back.",
			true,
		);
		return false;
	}
	return true;
}
$("sheet-body").addEventListener("change", (ev) => {
	const k = ev.target.dataset?.set;
	if (k) saveSettings({ [k]: ev.target.checked });
});
$("sheet-body").addEventListener("input", (ev) => {
	const i = ev.target.dataset?.label;
	if (i !== undefined && draft[i]) draft[i].label = ev.target.value;
});

// Drag the sheet down by its handle or title to close it.
const sheet = $("sheet");
let drag = null;
let dragged = false;
sheet.addEventListener("pointerdown", (ev) => {
	if (!ev.target.closest(".handle, #sheet-title")) return;
	drag = { y: ev.clientY, t: ev.timeStamp, dy: 0 };
	dragged = false;
	ev.target.setPointerCapture(ev.pointerId);
	sheet.style.transition = "none";
});
sheet.addEventListener("pointermove", (ev) => {
	if (!drag) return;
	drag.dy = Math.max(0, ev.clientY - drag.y);
	if (drag.dy > 6) dragged = true;
	sheet.style.transform = `translateY(${drag.dy}px)`;
});
const endDrag = (ev) => {
	if (!drag) return;
	const { dy, t } = drag;
	drag = null;
	sheet.style.transition = "";
	sheet.style.transform = "";
	if (
		dy > sheet.offsetHeight * 0.3 ||
		(dy > 24 && dy / Math.max(1, ev.timeStamp - t) > 0.6)
	)
		closeSheet();
};
sheet.addEventListener("pointerup", endDrag);
sheet.addEventListener("pointercancel", endDrag);

// Closing plays a short exit before hiding. Opening again cancels it.
const still = matchMedia("(prefers-reduced-motion: reduce)");
function settle(el) {
	el.leaving = null;
	el.style.transition = "";
	el.style.transform = "";
	el.style.opacity = "";
	el.style.pointerEvents = "";
}
function arrive(el) {
	settle(el);
	el.hidden = false;
}
function leave(el, transform, fade) {
	if (el.hidden || el.leaving) return;
	if (still.matches) {
		el.hidden = true;
		settle(el);
		return;
	}
	const me = {};
	el.leaving = me;
	el.style.pointerEvents = "none";
	el.style.transition = "transform 0.2s var(--ease), opacity 0.2s var(--ease)";
	if (transform) el.style.transform = transform;
	if (fade) el.style.opacity = "0";
	setTimeout(() => {
		if (el.leaving === me) {
			el.hidden = true;
			settle(el);
		}
	}, 200);
}
let backEdge = "left";
const slide = () => `translateX(${backEdge === "right" ? -48 : 48}px)`;

// Predictive back: the top surface follows the gesture, and snaps back if
// he lets go without going back.
function surface() {
	if (sheetKind) return sheet;
	if (shown($("files-view"))) return $("files-view");
	if (!$("search-row").hidden) return $("results");
	return null;
}
function follow(p, edge) {
	const el = surface();
	if (!el) return;
	if (edge) backEdge = edge;
	el.style.transition = p ? "none" : "";
	el.style.transform = !p
		? ""
		: el === sheet
			? `translateY(${Math.round(p * 64)}px) scale(${1 - p * 0.05})`
			: `translateX(${(edge === "right" ? -1 : 1) * Math.round(p * 32)}px) scale(${1 - p * 0.08})`;
}

// Search

// Each message is lowercased once rather than on every key he types.
const lower = new WeakMap();
const has = (o, textOf, needle) => {
	let l = lower.get(o);
	if (l === undefined) {
		l = textOf(o).toLowerCase();
		lower.set(o, l);
	}
	return l.includes(needle);
};
const youText = (y) => y.text || "";
const fileName = (f) => f.name;
const outText = (o) =>
	o.kind === "reply"
		? o.text.replace(/\*\*|`/g, "")
		: `${o.name}${o.caption ? `, ${o.caption}` : ""}`;
// Searches the data rather than the page, so it finds turns that aren't drawn.
function hits(q) {
	const needle = q.trim().toLowerCase();
	if (!needle) return [];
	const out = [];
	for (const t of items) {
		if (t.type !== "turn") continue;
		if (t.you?.text && has(t.you, youText, needle))
			out.push({ who: "You", e: t.you, text: t.you.text });
		for (const f of t.you?.files || [])
			if (has(f, fileName, needle)) out.push({ who: "You", e: t.you, text: f.name });
		for (const o of t.out)
			if (has(o, outText, needle))
				out.push({ who: mac?.name || "Computer", e: o, text: outText(o) });
	}
	return out.toReversed();
}
function snippet(body, q) {
	const i = body.toLowerCase().indexOf(q.toLowerCase());
	let start = Math.max(0, i - 40);
	if (start) {
		const sp = body.indexOf(" ", start);
		if (sp > -1 && sp < i) start = sp + 1;
	}
	const s = (start ? "…" : "") + body.slice(start);
	const j = s.toLowerCase().indexOf(q.toLowerCase());
	return (
		esc(s.slice(0, j)) +
		`<mark>${esc(s.slice(j, j + q.length))}</mark>` +
		esc(s.slice(j + q.length))
	);
}
const MaxHits = 100;
let countTimer = null;
let typeTimer = null;
function drawResults() {
	clearTimeout(typeTimer);
	const q = $("search").value;
	const list = hits(q);
	const none = `Nothing matches "${q.trim()}".`;
	const count =
		list.length > MaxHits
			? `The newest ${MaxHits} of ${list.length} results`
			: `${list.length} result${list.length === 1 ? "" : "s"}`;
	setHTML(
		$("results"),
		!q.trim()
			? `<p class="empty-state">Search your requests, the computer's replies and file names.</p>`
			: list.length === 0
				? `<p class="empty-state">${esc(none)}</p>`
				: `<p class="count">${count}</p><ol>${list
						.slice(0, MaxHits)
						.map(
							(h) =>
								`<li><button type="button" class="hit" data-jump="${esc(h.e.id)}"><span class="hit-top"><b>${h.who}</b><span>${shortDay(h.e.at)}</span></span><span class="hit-text">${snippet(h.text, q.trim())}</span></button></li>`,
						)
						.join("")}</ol>`,
	);
	clearTimeout(countTimer);
	if (q.trim()) countTimer = setTimeout(() => say(list.length > 0 ? count : none), 700);
}
let searchFrom = null;
function openSearch() {
	searchFrom = focused();
	$("head-main").hidden = true;
	$("search-row").hidden = false;
	arrive($("results"));
	drawResults();
	backing();
	$("search").focus();
}
function closeSearch() {
	$("head-main").hidden = false;
	$("search-row").hidden = true;
	leave($("results"), slide(), true);
	$("search").value = "";
	document.querySelector('[data-clear="search"]').hidden = true;
	clearTimeout(countTimer);
	clearTimeout(typeTimer);
	backing();
	restore(searchFrom, $("open-search"));
}
function jump(id) {
	const item = byEid.get(String(id));
	if (item && item.i < shownFrom) reveal(item.i);
	flushNow();
	const el = thread.querySelector(`[data-eid="${CSS.escape(String(id))}"]`);
	if (!el) return;
	pinned = false;
	// An ask's buttons have to clear the toolbar, even when it's taller than the screen.
	el.scrollIntoView({ block: el.matches(".ask") ? "end" : "center" });
	const target = el.querySelector(".bubble") || el;
	target.classList.remove("flash");
	void target.offsetWidth;
	target.classList.add("flash");
	focusSoft(el.matches(".ask") ? el.querySelector(".allow") : target);
}

// Requests pane, unfolded

let currentReq = null;
let sideLimit = 60;
const sideIO = new IntersectionObserver(
	(list) => {
		if (list.some((x) => x.isIntersecting)) {
			sideLimit += 60;
			drawSide();
		}
	},
	{ root: $("side-list"), rootMargin: "0px 0px 400px 0px" },
);
const sideState = (t, ask) => {
	if (ask) return "wait";
	if (active(t)) return "go";
	if (t.done?.stopped) return "stopped";
	if (t.done && !t.done.ok) return "bad";
	return t.done ? "ok" : "stopped";
};
function sideRow(t) {
	const ask = active(t) && waitingAsk(t);
	const state = sideState(t, ask);
	const meta = ask ? "Asking you now" : active(t) ? "Working now" : shortDay(t.at);
	const label = t.you.text || (t.you.files || []).map((f) => f.name).join(", ");
	const here = t.id === (currentReq ?? cur?.id);
	return `<li><button type="button" class="req${here ? " current" : ""}" data-req="${esc(t.id)}"${here ? ' aria-current="true"' : ""}>${mark(state)}<span class="req-body"><span class="req-text">${Said[state] ? `<span class="sr">${Said[state]}</span>` : ""}${esc(label)}</span><span class="req-meta">${meta}</span></span></button></li>`;
}
function drawSide() {
	if (!booted) return;
	const list = $("side-list");
	const q = $("side-search").value.trim().toLowerCase();
	const turns = items.filter((t) => t.type === "turn" && t.you).toReversed();
	const all = q
		? turns.filter(
				(t) => has(t.you, youText, q) || t.out.some((o) => has(o, outText, q)),
			)
		: turns;
	const rows = all.slice(0, sideLimit);
	refocus(
		list,
		() => {
			setHTML(
				list,

				rows.length > 0
					? rows.map(sideRow).join("") +
							(all.length > rows.length
								? `<li class="side-more"><button type="button" class="pill" data-sidemore>Show Older Requests</button></li>`
								: "")
					: loaded || q
						? `<li class="side-empty">${q ? `Nothing matches "${esc(q)}".` : "Your requests show up here."}</li>`
						: "",
			);
		},
		() => $("side-search"),
	);
	sideIO.disconnect();
	const m = list.querySelector("[data-sidemore]");
	if (m) sideIO.observe(m);
}

// Files view

function drawFiles() {
	const all = [];
	for (const t of items) {
		if (t.type !== "turn") continue;
		for (const f of t.you?.files || []) all.push({ ...f, at: t.you.at, who: "You" });
		for (const o of t.out) if (o.kind === "file") all.push({ ...o, who: "computer" });
	}
	all.reverse();
	const photos = all.filter(isImage);
	const files = all.filter((f) => !isImage(f));
	const body = $("files-body");
	refocus(
		body,
		() => {
			setHTML(
				body,
				!(all.length > 0 || loaded)
					? ""
					: all.length === 0
						? `<p class="empty-state">Nothing yet. Photos and files you send to the computer, and ones it sends you, show up here.</p>`
						: (photos.length > 0
								? `<h3>Photos</h3><div class="grid">${photos.map((f) => `<button type="button" class="tile" data-open="${esc(f.url)}" aria-label="${esc(f.name)}, from ${f.who === "You" ? "you" : "the computer"}"><img src="${thumb(f.url, 180)}" alt="" loading="lazy" decoding="async"><span aria-hidden="true">${f.who}</span></button>`).join("")}</div>`
								: "") +
							(files.length > 0
								? `<h3>Files</h3><ul class="flist">${files.map((f, i) => `<li><button type="button" class="file" data-open="${esc(f.url)}">${fileIcon(["flower", "cookie", "pentagon", "clover"][i % 4])}<span><span class="fn">${esc(f.name)}</span><br><span class="fs"><span class="who-tag">${f.who === "You" ? "From you" : "From the computer"}</span> · ${bytes(f.size || 0)} · ${shortDay(f.at)}</span></span></button></li>`).join("")}</ul>`
								: ""),
			);
		},
		() => $("close-files"),
	);
}
let filesFrom = null;
function openFiles() {
	filesFrom = focused();
	drawFiles();
	arrive($("files-view"));
	backing();
	$("close-files").focus();
}
function closeFiles() {
	if (!shown($("files-view"))) return;
	leave($("files-view"), slide(), true);
	backing();
	restore(filesFrom, $("open-files"));
}

// Composer

const text = $("text");
const growText = () => {
	text.style.height = "auto";
	text.style.height = `${text.scrollHeight}px`;
};
const canSend = () => {
	$("send").disabled = !(text.value.trim() || pending.length > 0) || uploading > 0;
};
function drawPending() {
	const p = $("pending");
	p.hidden = !(pending.length > 0 || uploading);
	refocus(
		p,
		() => {
			setHTML(
				p,
				pending
					.map(
						(f, i) =>
							`<div class="att">${isImage(f) ? `<img src="${thumb(f.url, 48)}" alt="" width="48" height="48" decoding="async">` : `<span class="fi">${icon("doc")}</span>`}<span>${esc(f.name)}</span><button type="button" data-unattach="${i}" aria-label="Remove ${esc(f.name)}">${icon("close")}</button></div>`,
					)
					.join("") +
					(uploading
						? `<div class="att loading"><span class="loader">${loader()}</span>Sending to the computer</div>`
						: ""),
			);
		},
		() => p.querySelector("[data-unattach]") || text,
	);
	canSend();
}
function send(t, files) {
	if (!(t || files?.length)) return;
	digestEl.hidden = true;
	lab.send(t, files?.length ? files : undefined);
}
function menu(open) {
	$("attach-menu").hidden = !open;
	$("attach").setAttribute("aria-expanded", String(open));
	backing();
	if (open) $("attach-menu").querySelector("button").focus();
}
async function attach(kind) {
	menu(false);
	$("attach").focus();
	uploading++;
	drawPending();
	let failed = null;
	try {
		const got = await lab.attach(kind);
		pending.push(...got);
		if (got.length > 0) say(`Attached ${got.map((f) => f.name).join(", ")}.`);
	} catch (err) {
		failed = err.message || "Couldn't send that to the computer.";
	}
	uploading--;
	drawPending();
	// After the sending row is gone, so the snackbar sits on the composer.
	if (failed) toast(failed, true);
}

// The snackbar sits just above the toolbar, or the composer when nothing
// is running. Its words reach screen readers through the status lines.
// Its offset is kept on top of the bottom inset, so it rides up with the
// keyboard while that slides. Tabletop puts it just above the hinge.
let toastTimer = null;
const px = (name) =>
	Number.parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0;
function toast(msg, failed) {
	const t = $("toast");
	const kb = root.hasAttribute("data-keyboard");
	if (root.classList.contains("table") && !kb)
		t.style.bottom = `${Math.round(innerHeight - px("--hinge-t") + 8)}px`;
	else {
		// A sheet in the top half leaves only the strip above the keyboard.
		const over = sheetKind
			? root.classList.contains("table")
				? null
				: $("sheet")
			: !$("now").hidden
				? $("now")
				: $("composer");
		t.style.bottom = over
			? `calc(var(--lab-inset-bottom, 0px) + ${Math.round(innerHeight - px("--lab-inset-bottom") - over.getBoundingClientRect().top + 8)}px)`
			: "calc(var(--lab-inset-bottom, 0px) + 8px)";
	}
	t.textContent = msg;
	t.hidden = false;
	say(msg, failed);
	clearTimeout(toastTimer);
	toastTimer = setTimeout(
		() => {
			t.hidden = true;
		},
		failed ? 7000 : 4500,
	);
}

function deselect() {
	const was = selected;
	selected = null;
	moreOpen = false;
	const t = was && findYou(was);
	if (t) draw(t);
	backing();
}

// Back and Escape close whatever is on top.
function top() {
	if (sheetKind) return closeSheet;
	if (!$("attach-menu").hidden)
		return () => {
			menu(false);
			$("attach").focus();
		};
	if (shown($("files-view"))) return closeFiles;
	if (!$("search-row").hidden) return closeSearch;
	if (glanceOpen) return () => toggleGlance(false);
	if (selected) return deselect;
	return null;
}
function backing() {
	app.inert = Boolean(sheetKind);
	thread.inert = overlay();
	for (const el of [sheet, $("files-view"), $("results")]) if (el.hidden) settle(el);
	fold();
	const fn = top();
	lab.onBack(
		fn
			? () => {
					top()?.();
				}
			: null,
	);
}
document.addEventListener("keydown", (ev) => {
	if (ev.key !== "Escape") return;
	const fn = top();
	if (fn) {
		ev.preventDefault();
		fn();
	}
});

function findYou(cid) {
	for (const t of items) if (t.type === "turn" && t.you?.cid === cid) return t;
	return null;
}

// Events

// Each group returns true once it has handled the click. Their order decides
// which data attribute wins on a button that carries more than one.
function clickTurn(d) {
	if (d.open) {
		lab.open(d.open);
		return true;
	}
	if (d.answer) {
		lab.answer(d.answer, d.allow === "1", d.always === "1");
		return true;
	}
	if (d.askagain) {
		const t = byRef.get(d.askagain);
		const a = t?.asks.find((x) => x.ref === d.askagain);
		const what = (a?.plain || a?.title || "do that").replace(/^Allow: |\?$/g, "");
		send(
			`You asked earlier if you could ${what.charAt(0).toLowerCase()}${what.slice(1)}, and I didn't answer in time. Ask me again.`,
		);
		return true;
	}
	if (d.restore) {
		const t = items.find((x) => x.id === d.restore);
		if (t?.snap) openRestore(t);
		return true;
	}
	if (d.restoreok) {
		const t = items.find((x) => x.id === d.restoreok);
		closeSheet();
		if (t?.snap)
			send(
				`Put back what you changed or deleted in the task I asked for at ${clock(t.snap.at)}${t.you?.text ? ` ("${t.you.text.slice(0, 80)}")` : ""}. Get deleted things back from the Trash first, then use the Time Machine snapshot ${t.snap.name} for anything else. Don't touch anything I changed myself since then, and tell me what you put back and what you couldn't.`,
			);
		return true;
	}
	if (d.digest) {
		digestEl.hidden = true;
		if (d.digest === "show" && digestFirst !== null) jump(digestFirst);
		else text.focus();
		return true;
	}
	return false;
}

function clickMenu(d) {
	if (d.menu) {
		wipeArmed = false;
		if (d.menu === "memory") load("memory", "Memory", "/memory", drawMemory);
		else if (d.menu === "schedules")
			load("schedules", "Schedules", "/schedules", drawSchedules);
		else if (d.menu === "allowed")
			load("allowed", "Always Allowed", "/allowed", drawRules);
		else if (d.menu === "check") openCheck();
		else if (d.menu === "rename") openRename();
		else if (d.menu === "settings") openSettings();
		return true;
	}
	if (d.forget) {
		const [key, i] = d.forget.split(":");
		const next = { about: [...memo.about], notes: [...memo.notes] };
		const [gone] = next[key].splice(Number(i), 1);
		saveMemory(
			next,
			`Forgot "${gone.length > 40 ? `${gone.slice(0, 39)}...` : gone}".`,
		);
		return true;
	}
	if (d.mempause !== undefined) {
		saveMemory(
			{ paused: !memo.paused },
			memo.paused ? "Memory is back on." : "Memory is paused.",
		);
		return true;
	}
	if (d.memwipe !== undefined) {
		if (wipeArmed) {
			wipeArmed = false;
			saveMemory({ about: [], notes: [] }, "Memory is empty now.");
		} else {
			wipeArmed = true;
			drawMemory(memo);
			sheet.querySelector("[data-memwipe]").focus();
		}
		return true;
	}
	return false;
}

async function pauseSchedule(i) {
	const list = plan.map((s, k) => (k === i ? { ...s, paused: !s.paused } : s));
	const r = await saveSchedules(
		list,
		list[i].paused ? `Paused "${list[i].label}".` : `"${list[i].label}" is back on.`,
	);
	if (r && sheetKind === "schedules") drawSchedules(r);
}
async function deleteSchedule(i) {
	const gone = plan[i];
	const r = await saveSchedules(
		plan.filter((_, k) => k !== i),
		`Deleted "${gone.label}".`,
	);
	if (r && sheetKind === "schedules") drawSchedules(r);
}
const markMissing = (empty, msg) => {
	empty.setAttribute("aria-invalid", "true");
	empty.addEventListener("input", () => empty.removeAttribute("aria-invalid"), {
		once: true,
	});
	empty.focus();
	toast(msg, true);
};
async function saveSchedule(i) {
	const label = $("sch-label").value.trim();
	const body = $("sch-text").value.trim();
	const time = $("sch-time").value;
	if (!(label && body && time)) {
		markMissing(
			$(label ? (body ? "sch-time" : "sch-text") : "sch-label"),
			"A schedule needs a name, a message and a time.",
		);
		return;
	}
	const days = [...sheet.querySelectorAll(".days input:checked")].map((x) => x.value);
	// The run times are the computer's to work out, so they aren't sent back.
	const { next: _next, last: _last, ...was } = plan[i];
	const edited = { ...was, label, text: body, time, quiet: $("sch-quiet").checked };
	// Left undefined, the days drop out of the JSON, which means every day.
	if (!was.date) edited.days = days.length > 0 && days.length < 7 ? days : undefined;
	const r = await saveSchedules(
		plan.map((s, k) => (k === i ? edited : s)),
		`Saved "${label}".`,
	);
	if (r) load("schedules", "Schedules", "/schedules", drawSchedules);
}
async function revokeRule(i) {
	try {
		drawRules(await call("POST", "/allowed", { remove: i }));
		toast("It will ask before running that again.");
	} catch (err) {
		toast(err.message || "Couldn't reach the computer, so nothing changed.", true);
	}
}
function clickSchedules(d) {
	if (d.schpause) pauseSchedule(Number(d.schpause));
	else if (d.schdel) deleteSchedule(Number(d.schdel));
	else if (d.schedit) editSchedule(Number(d.schedit));
	else if (d.schsave) saveSchedule(Number(d.schsave));
	else if (d.revoke) revokeRule(Number(d.revoke));
	else if (d.checkfix) lab.fix(d.checkfix);
	else if (d.send) send(d.send);
	else return false;
	return true;
}

const copyText = (s) =>
	navigator.clipboard?.writeText(s).catch(() => {
		// Nothing on screen waits for the copy, so a refusal changes nothing.
	});
function clickMessage(d, b) {
	if (d.sc) {
		if (longFired) {
			longFired = false;
			return true;
		}
		const s = shortcuts.find((x) => x.id === d.sc);
		if (s) send(s.text);
		return true;
	}
	if (d.run) {
		const t = items.find((x) => x.id === d.run);
		if (t) {
			t.open = !(t.open ?? openByDefault(t));
			draw(t);
		}
		return true;
	}
	if (d.raw) {
		const t = byRef.get(d.raw);
		if (t) {
			if (t.raw.has(d.raw)) t.raw.delete(d.raw);
			else t.raw.add(d.raw);
			draw(t);
		}
		return true;
	}
	if (d.copyraw) {
		const t = byRef.get(d.copyraw);
		const s = t?.steps.find((x) => x.ref === d.copyraw);
		if (s) {
			copyText(s.detail || "");
			toast("Copied the command.");
		}
		return true;
	}
	if (d.cid !== undefined && b.classList.contains("bubble")) {
		const was = selected;
		selected = selected === d.cid ? null : d.cid;
		moreOpen = false;
		for (const cid of [was, selected]) {
			const t = cid && findYou(cid);
			if (t) draw(t);
		}
		backing();
		return true;
	}
	return clickMine(d);
}
function clickMine(d) {
	if (d.more !== undefined) {
		moreOpen = !moreOpen;
		const t = findYou(selected);
		if (t) draw(t);
		return true;
	}
	if (d.save) {
		const t = findYou(d.save);
		if (t) openNewShortcut(t.you.text);
		return true;
	}
	if (d.again) {
		const t = findYou(d.again);
		if (t) {
			deselect();
			send(t.you.text);
			text.focus();
		}
		return true;
	}
	if (d.copy) {
		const t = findYou(d.copy);
		if (t) {
			copyText(t.you.text);
			deselect();
			t.el?.querySelector(".bubble")?.focus({ preventScroll: true });
			toast("Copied.");
		}
		return true;
	}
	return false;
}
function clickLists(d) {
	if (d.jump) {
		closeSearch();
		jump(d.jump);
		return true;
	}
	if (d.req) {
		currentReq = d.req;
		const t = items.find((x) => x.id === d.req);
		if (t) {
			closeFiles();
			jump(t.you.id);
		}
		drawSide();
		return true;
	}
	if (d.sidemore !== undefined) {
		sideLimit += 60;
		drawSide();
		return true;
	}
	if (d.attach) {
		attach(d.attach);
		return true;
	}
	if (d.unattach) {
		pending.splice(Number(d.unattach), 1);
		drawPending();
		return true;
	}
	if (d.remove) {
		const i = Number(d.remove);
		draft.splice(i, 1);
		openManage();
		(
			sheet.querySelector(`[data-remove="${Math.min(i, draft.length - 1)}"]`) ||
			$("sheet-title")
		).focus();
		return true;
	}
	return false;
}

async function saveDraftList() {
	for (const s of draft)
		s.label =
			s.label.trim() || shortcuts.find((x) => x.id === s.id)?.label || "Shortcut";
	if (await saveList(draft)) closeSheet();
}
function clickWidget(d) {
	if (longFired) {
		longFired = false;
		return;
	}
	const w = Widgets[d.widget];
	if (w?.tap) guard(`the ${d.widget} widget`, w.tap);
	else toggleGlance(!glanceOpen);
}
function clickTopBar(d) {
	if (d.tbmove) {
		const [i, by] = d.tbmove.split(":").map(Number);
		editBar(
			(bar) => {
				if (!(bar[i] && bar[i + by])) return;
				const [w] = bar.splice(i, 1);
				bar.splice(i + by, 0, w);
			},
			`[data-tbmove="${i + by}:${by}"]`,
		);
	} else if (d.tbremove) {
		const i = Number(d.tbremove);
		editBar((bar) => bar.splice(i, 1), `[data-tbremove="${Math.max(0, i - 1)}"]`);
	} else if (d.tbsize) {
		const [i, size] = d.tbsize.split(":");
		editBar((bar) => {
			if (bar[Number(i)]) bar[Number(i)].size = size;
		}, `[data-tbsize="${d.tbsize}"]`);
	} else if (d.tbadd) {
		const def = Widgets[d.tbadd];
		editBar(
			(bar) => bar.push({ id: d.tbadd, size: def.sizes[0] }),
			`[data-tbremove="${settings.topBar.length}"]`,
		);
	} else if (d.tbreset !== undefined)
		editBar((bar) =>
			bar.splice(0, bar.length, ...structuredClone(DefaultSettings.topBar)),
		);
	else return false;
	return true;
}
function clickBar(d) {
	if (d.close !== undefined) closeSheet();
	else if (d.savelist !== undefined) saveDraftList();
	else if (d.rename !== undefined) openRename();
	else if (d.widget) clickWidget(d);
	else if (d.hidemore !== undefined) toggleGlance(false);
	else if (d.topbar !== undefined) openTopBar();
	else return clickTopBar(d);
	return true;
}

async function pickSetting(key, val) {
	await saveSettings({ [key]: JSON.parse(val) });
	if (sheetKind === "settings") openSettings();
	else if (sheetKind === "models" && modelList) drawModels();
	else return;
	sheet.querySelector(`[data-setkey="${key}"][aria-checked="true"]`)?.focus();
}
function pickOtherModel() {
	const v = $("model-other").value.trim();
	if (v) {
		pickModel(v);
		return;
	}
	$("model-other").focus();
	toast("Type the name of the model first.", true);
}
async function saveName() {
	try {
		const r = await call("POST", "/name", { name: $("rename-to").value });
		closeSheet();
		toast(`It's called ${r.name} now.`);
	} catch (err) {
		toast(
			err.message || "Couldn't reach the computer, so the name wasn't changed.",
			true,
		);
	}
}
async function saveNewShortcut() {
	const label = $("sc-label").value.trim();
	const body = $("sc-text").value.trim();
	if (!(label && body)) {
		markMissing(
			$(label ? "sc-text" : "sc-label"),
			"A shortcut needs a name and a message.",
		);
		return;
	}
	if (await saveList([...shortcuts, { id: "", label, text: body }])) {
		closeSheet();
		deselect();
		toast(`Saved "${label}" as a shortcut.`);
	}
}
function clickSettings(d) {
	if (d.setkey) pickSetting(d.setkey, d.setval);
	else if (d.setopen) guard("a setting", () => Settings[Number(d.setopen)].open());
	else if (d.model) pickModel(d.model);
	else if (d.modelother !== undefined) pickOtherModel();
	else if (d.welcome !== undefined) {
		saveSettings({ welcomeDone: true });
		text.focus();
	} else if (d.savename !== undefined) saveName();
	else if (d.savenew !== undefined) saveNewShortcut();
	else return false;
	return true;
}

function clickById(id) {
	switch (id) {
		case "open-search":
			return openSearch();
		case "close-search":
			return closeSearch();
		case "open-files":
			return openFiles();
		case "open-menu":
			return openMenu();
		case "close-files":
			return closeFiles();
		case "fold-head":
			return saveSettings({ topBarHidden: !settings.topBarHidden });
		case "now-stop":
			return lab.stop();
		case "now-jump": {
			const a = cur && waitingAsk(cur);
			if (a) jump(a.id);
			return;
		}
		case "banner-fix":
			return lab.fix(link.fix);
		case "banner-retry":
			return lab.retry();
		case "attach":
			return menu($("attach-menu").hidden);
		case "manage":
			return openManage();
		case "model-chip":
			return openModels();
		case "older":
			return more();
		case "handle":
			if (!dragged) closeSheet();
			dragged = false;
			return;
	}
}

document.addEventListener("click", (ev) => {
	const b = ev.target.closest("button, a");
	if (!b) return;
	const d = b.dataset;
	if (b.matches("a[data-ext]")) {
		ev.preventDefault();
		lab.open(b.href);
		return;
	}
	if (
		clickTurn(d) ||
		clickMenu(d) ||
		clickSchedules(d) ||
		clickMessage(d, b) ||
		clickLists(d) ||
		clickBar(d) ||
		clickSettings(d)
	)
		return;
	clickById(b.id);
});

// Long-press a shortcut to manage them.
let press = null;
let longFired = false;
$("chips").addEventListener("pointerdown", (ev) => {
	if (!ev.target.closest("[data-sc]")) return;
	longFired = false;
	press = setTimeout(() => {
		longFired = true;
		openManage();
	}, 500);
});
for (const t of ["pointerup", "pointercancel", "pointerleave"])
	$("chips").addEventListener(t, () => clearTimeout(press));
// Long-press a widget to edit the top bar, the way a home screen does.
glance.addEventListener("pointerdown", (ev) => {
	if (!ev.target.closest("[data-widget]")) return;
	longFired = false;
	press = setTimeout(() => {
		longFired = true;
		openTopBar();
	}, 500);
});
for (const t of ["pointerup", "pointercancel", "pointerleave"])
	glance.addEventListener(t, () => clearTimeout(press));
glance.addEventListener("contextmenu", (ev) => {
	if (ev.target.closest("[data-widget]")) ev.preventDefault();
});
$("chips").addEventListener("contextmenu", (ev) => {
	if (ev.target.closest("[data-sc]")) ev.preventDefault();
});

$("scrim").addEventListener("click", closeSheet);
document.addEventListener("pointerdown", (ev) => {
	if (!($("attach-menu").hidden || ev.target.closest(".attach-wrap"))) menu(false);
});
$("search").addEventListener("input", () => {
	clearTimeout(typeTimer);
	typeTimer = setTimeout(drawResults, 120);
});
$("search-row").addEventListener("submit", (ev) => {
	ev.preventDefault();
	$("search").blur();
});
$("side-search").addEventListener("input", () => {
	sideLimit = 60;
	drawSide();
});
for (const b of document.querySelectorAll("[data-clear]")) {
	const field = $(b.dataset.clear);
	field.addEventListener("input", () => {
		b.hidden = !field.value;
	});
	b.addEventListener("click", () => {
		field.value = "";
		b.hidden = true;
		field.dispatchEvent(new Event("input"));
		field.focus();
	});
}
// Back from the conversation closes the screen, so an unsent message is
// kept on the phone and put back next time.
const keep = (v) => {
	try {
		if (v) localStorage.setItem("lab-draft", v);
		else localStorage.removeItem("lab-draft");
	} catch {
		// Without storage the draft just isn't kept, and typing carries on.
	}
};
text.addEventListener("input", () => {
	growText();
	canSend();
	keep(text.value);
});
if (lab.platform === "android") text.enterKeyHint = "enter";
text.addEventListener("keydown", (ev) => {
	if (
		ev.key === "Enter" &&
		!ev.shiftKey &&
		(lab.platform !== "android" || settings.enterSends)
	) {
		ev.preventDefault();
		$("form").requestSubmit();
	}
});
$("form").addEventListener("submit", (ev) => {
	ev.preventDefault();
	if ($("send").disabled) return;
	send(text.value.trim(), pending);
	text.value = "";
	keep("");
	pending = [];
	growText();
	drawPending();
	toBottom();
});
addEventListener("resize", () => {
	measure();
	fold();
	growText();
	if (pinned) toBottom();
});
// Ages in the glance go stale while the computer is away.
setInterval(() => {
	if (link.state !== "online" || glanceOpen) drawGlance();
}, 30_000);

// Roboto Flex arriving changes the probe's width.
const remeasure = () => {
	measure();
	fold();
};
document.fonts?.ready.then(remeasure);

try {
	text.value = localStorage.getItem("lab-draft") || "";
} catch {
	// Without storage there's no draft to put back.
}
thread.append(log);
log.append(older, digestEl, queue);
const away = lastSeen();
lab.subscribe((e) =>
	guard(`a ${e.kind} event`, () => {
		take(e);
		if (e.kind === "loaded") {
			flushNow();
			drawDigest(away);
			markSeen();
		}
	}),
);
booted = true;
applySettings();
refreshSchedules();
setInterval(refreshSchedules, 10 * 60_000);
threadH = thread.clientHeight;
measure();
flush();
drawChips();
drawGlance();
drawNow();
drawLink(link.state);
drawSide();
drawPending();
growText();
toBottom();
requestAnimationFrame(() => lab.ready());
