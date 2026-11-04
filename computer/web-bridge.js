// window.lab for the app opened in a browser on the computer itself. The phone
// gets the same API from the Android shell, so a design works in both.
(() => {
	const listeners = new Set();
	// Kept in storage, so a reload or Try Again while the server is down
	// doesn't throw away what he sent.
	const outboxKey = "lab-outbox";
	const outbox = (() => {
		try {
			const saved = JSON.parse(localStorage.getItem(outboxKey) || "[]");
			return Array.isArray(saved)
				? saved.filter((m) => typeof m?.cid === "string" && typeof m.text === "string")
				: [];
		} catch {
			return [];
		}
	})();
	const outboxChanged = () => {
		try {
			localStorage.setItem(outboxKey, JSON.stringify(outbox));
		} catch {
			// Without storage the outbox only lasts as long as the page.
		}
		emit({ kind: "outbox", items: [...outbox] });
	};
	let link = { kind: "link", state: "connecting" };
	let status = null;
	// The newest event of each kind that has no id, given to a page as it subscribes.
	const live = new Map();
	// History that lands before the page subscribes is kept for it, as the phone does.
	const backlog = [];
	let lastId = null;

	const reported = new Set();
	const report = (problem, where) => {
		const message = String(problem || "").slice(0, 500);
		if (!message || reported.has(message) || reported.size >= 20) return;
		reported.add(message);
		post("/app-error", {
			message,
			where: String(where || "the page").slice(0, 80),
		}).catch(() => {
			// A report that can't reach the server has nowhere else to go.
		});
	};
	addEventListener("error", (e) =>
		report(
			e.error?.message || e.message,
			e.filename ? `${e.filename.split("/").pop()} line ${e.lineno}` : "the page",
		),
	);
	addEventListener("unhandledrejection", (e) =>
		report(e.reason?.message || e.reason, "a promise"),
	);
	const emit = (e) => {
		for (const fn of listeners) {
			try {
				fn(e);
			} catch (err) {
				console.error(err);
			}
		}
	};
	function post(path, body) {
		return fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
		});
	}
	// Sends each file to `path` in turn and returns what the server made of them.
	async function upload(path, files) {
		const out = [];
		try {
			for (const f of files) {
				const r = await fetch(`${path}?name=${encodeURIComponent(f.name)}`, {
					method: "POST",
					headers: { "content-type": f.type || "application/octet-stream" },
					body: f,
				});
				if (!r.ok)
					throw new Error(
						(await r.json().catch(() => ({}))).error || `Couldn't upload ${f.name}.`,
					);
				out.push(await r.json());
			}
		} catch (e) {
			throw e instanceof Error && e.message !== "Failed to fetch"
				? e
				: new Error("Couldn't reach the server, so nothing was sent.");
		}
		return out;
	}

	// The Lab's own window passes messages to its native side: WebView2 on
	// Windows, WebKit on a Mac. A browser tab has neither.
	const webview = globalThis.chrome?.webview;
	const webkit = globalThis.webkit?.messageHandlers?.lab;
	const host = (m) => (webview ?? webkit)?.postMessage(m);
	// Replies to <lab-ask> are its own, and never page events.
	const fromHost = (e) => {
		if (e?.op === "askInfo" || e?.op === "askAnswer") return;
		emit(e);
	};
	webview?.addEventListener("message", (e) => {
		if (typeof e.data !== "string") fromHost(e.data);
	});
	globalThis.labHost = fromHost;

	const connect = () => {
		const es = new EventSource(lastId === null ? "/events" : `/events?after=${lastId}`);
		es.addEventListener("hello", (m) => {
			const hello = JSON.parse(m.data);
			link = { kind: "link", state: "online" };
			emit(link);
			status = { kind: "status", ...hello.status };
			emit(status);
			for (const e of [
				hello.mac,
				{ kind: "shortcuts", items: hello.shortcuts ?? [] },
				...(hello.live ?? []),
			])
				if (e) {
					live.set(e.kind, e);
					emit(e);
				}
			flush();
		});
		es.addEventListener("loaded", () => {
			backlog.push({ kind: "loaded" });
			emit({ kind: "loaded" });
		});
		es.addEventListener("message", (m) => {
			const e = JSON.parse(m.data);
			if (e.id) lastId = e.id;
			if (e.kind === "status") status = e;
			if (e.kind === "design") return location.reload();
			if (!e.id && e.kind !== "status") live.set(e.kind, e);
			if (e.id) {
				backlog.push(e);
				if (backlog.length > 6000) backlog.splice(0, 1000);
			}
			emit(e);
		});
		es.addEventListener("error", () => {
			es.close();
			link = {
				kind: "link",
				state: "offline",
				detail: "The server on this computer is not answering.",
			};
			emit(link);
			setTimeout(connect, 3000);
		});
	};

	// The server drops a body over 256 KB without answering, which would look
	// like it being down, so a message that big is turned back here.
	const MaxBody = 256 * 1024;
	let flushing = false;
	let again = null;
	const flush = async () => {
		if (flushing) return;
		flushing = true;
		clearTimeout(again);
		try {
			while (outbox.length > 0) {
				const m = outbox[0];
				const body = JSON.stringify({ text: m.text, cid: m.cid, files: m.files });
				let error = null;
				if (new Blob([body]).size > MaxBody)
					error = "That message is too big to send. Try sending it in parts.";
				else {
					let r;
					try {
						r = await fetch("/send", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body,
						});
					} catch {
						r = null;
					}
					if (r?.status === 400)
						error =
							(await r.json().catch(() => ({}))).error ||
							"The computer couldn't take that message.";
					else if (!r?.ok) {
						again = setTimeout(flush, 3000);
						return;
					}
				}
				outbox.shift();
				outboxChanged();
				if (error) emit({ kind: "sendFailed", cid: m.cid, text: m.text, error });
			}
		} finally {
			flushing = false;
		}
	};

	globalThis.lab = {
		// The Lab's own window on Windows and macOS says so before the page runs.
		platform: globalThis.labShell === "desktop" ? "desktop" : "web",
		os: globalThis.labShell === "desktop" ? globalThis.labOs || "" : "",
		// Only the desktop window has these. It sends a "window" event whenever
		// it's maximized, restored, focused or left.
		window:
			globalThis.labShell === "desktop"
				? {
						minimize: () => host({ window: "minimize" }),
						maximize: () => host({ window: "maximize" }),
						close: () => host({ window: "close" }),
						// WebView2 moves the window from app-region: drag by itself, and a
						// Mac's WebKit has no such thing, so the page asks on a press.
						drag: () => host({ window: "drag" }),
						// The title bar's colour, for the strip Windows resizes from.
						tint: (color) => host({ bar: color }),
					}
				: null,
		// Shows a file the phone or the agent sent in Explorer or the Finder.
		reveal: (url) => host({ reveal: url }),
		upload: (files) => upload("/upload", files),
		toPhone: (files) => upload("/to-phone", files),
		subscribe(fn) {
			listeners.add(fn);
			fn(link);
			if (status) fn(status);
			for (const e of live.values()) fn(e);
			for (const e of backlog) fn(e);
			fn({ kind: "outbox", items: [...outbox] });
			return () => listeners.delete(fn);
		},
		send(text, files) {
			const cid = crypto.randomUUID();
			outbox.push({
				cid,
				text,
				at: new Date().toISOString(),
				...(files?.length ? { files } : {}),
			});
			outboxChanged();
			flush();
			return cid;
		},
		async stop() {
			const ok = await post("/stop").then(
				(r) => r.ok,
				() => false,
			);
			if (!ok) emit({ kind: "stopFailed" });
		},
		// Memory, schedules, always-allowed commands and the setup check.
		async call(method, path, body) {
			const r = await fetch(path, {
				method,
				...(body === undefined
					? {}
					: {
							headers: { "content-type": "application/json" },
							body: JSON.stringify(body),
						}),
			});
			const out = await r.json().catch(() => ({}));
			if (!r.ok) throw new Error(out.error || `The computer answered ${r.status}.`);
			return out;
		},
		check() {
			return this.call("GET", "/check");
		},
		undoDesign: () => post("/design/undo"),
		saveShortcuts: (items) =>
			post("/shortcuts", { items }).then(
				(r) => r.ok,
				() => false,
			),
		attach(kind) {
			return new Promise((done) => {
				const input = Object.assign(document.createElement("input"), {
					type: "file",
					multiple: true,
					accept: kind === "photos" ? "image/*" : "",
				});
				input.addEventListener("change", () => done(input.files));
				input.addEventListener("cancel", () => done([]));
				input.click();
			}).then((files) => upload("/upload", files));
		},
		fileUrl: (url) => url,
		open: (url) => window.open(url, "_blank", "noopener"),
		// The Android shell handles fix, safe mode, back and ready. A browser
		// has nothing to do for them.
		fix() {
			// Nothing to do in a browser.
		},
		retry() {
			location.reload();
		},
		safeMode() {
			// Nothing to do in a browser.
		},
		reportError: (message, where) => report(message, where),
		leaveSafeMode() {
			// Nothing to do in a browser.
		},
		onBack() {
			// Nothing to do in a browser.
		},
		ready() {
			// Nothing to do in a browser.
		},
	};
	// While someone is at this computer with The Lab in front, the phone stays quiet.
	const here = () => {
		if (document.visibilityState === "visible" && document.hasFocus())
			post("/presence").catch(() => {
				// The next check in 30 seconds tries again.
			});
	};
	setInterval(here, 30_000);
	addEventListener("focus", here);
	connect();
})();
