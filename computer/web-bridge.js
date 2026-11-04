// window.lab for the app opened in a browser on the computer itself. The phone
// gets the same API from the Android shell, so a design works in both.
(() => {
	const listeners = new Set();
	const outbox = [];
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

	const flush = async () => {
		while (outbox.length > 0) {
			const m = outbox[0];
			try {
				const r = await post("/send", { text: m.text, cid: m.cid, files: m.files });
				if (!r.ok && r.status !== 400) throw new Error(String(r.status));
			} catch {
				return setTimeout(flush, 3000);
			}
			outbox.shift();
			emit({ kind: "outbox", items: [...outbox] });
		}
	};

	globalThis.lab = {
		platform: "web",
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
			emit({ kind: "outbox", items: [...outbox] });
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
		// A 404 means the question was already answered, which isn't a failure.
		async answer(ref, allow, always) {
			const ok = await post("/answer", { ref, allow, always: Boolean(always) }).then(
				(r) => r.ok || r.status === 404,
				() => false,
			);
			if (!ok) emit({ kind: "answerFailed", ref });
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
			return new Promise((done, fail) => {
				const input = Object.assign(document.createElement("input"), {
					type: "file",
					multiple: true,
					accept: kind === "photos" ? "image/*" : "",
				});
				input.addEventListener("change", async () => {
					try {
						const out = [];
						for (const f of input.files) {
							const r = await fetch(`/upload?name=${encodeURIComponent(f.name)}`, {
								method: "POST",
								headers: { "content-type": f.type || "application/octet-stream" },
								body: f,
							});
							if (!r.ok)
								throw new Error(
									(await r.json().catch(() => ({}))).error ||
										`Couldn't upload ${f.name}.`,
								);
							out.push(await r.json());
						}
						done(out);
					} catch (e) {
						fail(
							e instanceof Error && e.message !== "Failed to fetch"
								? e
								: new Error("Couldn't reach the server, so nothing was attached."),
						);
					}
				});
				input.addEventListener("cancel", () => done([]));
				input.click();
			});
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
