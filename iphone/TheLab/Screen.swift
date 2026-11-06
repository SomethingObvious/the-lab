import AVFoundation
import PhotosUI
import QuickLook
import Speech
import UIKit
import UniformTypeIdentifiers
import WebKit

private let maxFiles = 20

private func resource(_ name: String) -> Data? {
	Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "web").flatMap { try? Data(contentsOf: $0) }
}

// The page's own address: its design, the app's safe screen and the computer's
// files. Each computer has a host of its own, so their storage stays apart.
private final class PageFiles: NSObject, WKURLSchemeHandler {
	let computer: Computer
	// Only touched on the main thread, where WebKit starts and stops tasks.
	private var running = Set<ObjectIdentifier>()

	init(_ c: Computer) { computer = c }

	func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {
		running.remove(ObjectIdentifier(task))
	}

	// WebKit raises if a stopped task is touched, so the check and the call happen
	// together on the thread that stops them. A lock would deadlock, as these calls
	// wait for the main thread themselves.
	private func ifRunning(_ task: WKURLSchemeTask, _ use: () -> Void) -> Bool {
		DispatchQueue.main.sync {
			guard running.contains(ObjectIdentifier(task)) else { return false }
			use()
			return true
		}
	}

	private func end(_ task: WKURLSchemeTask) {
		_ = ifRunning(task) {
			task.didFinish()
			running.remove(ObjectIdentifier(task))
		}
	}

	func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
		running.insert(ObjectIdentifier(task))
		DispatchQueue.global(qos: .userInitiated).async { [self] in
			let url = task.request.url
			let path = url?.path.removingPercentEncoding ?? url?.path ?? ""
			guard let file = find(path) else { return fail(task, 404) }
			serve(task, file, range: task.request.value(forHTTPHeaderField: "Range"))
		}
	}

	private func find(_ path: String) -> URL? {
		if path.hasPrefix("/app/") {
			let root = computer.designDir.standardizedFileURL
			let f = root.appendingPathComponent(String(path.dropFirst(5))).standardizedFileURL
			return f.path.hasPrefix(root.path + "/") && FileManager.default.fileExists(atPath: f.path) ? f : nil
		}
		if path.hasPrefix("/shell/") {
			guard let name = plainName(String(path.dropFirst(7))) else { return nil }
			return Bundle.main.url(forResource: name, withExtension: nil, subdirectory: "web")
		}
		if path.hasPrefix("/files/") {
			let rest = String(path.dropFirst(7))
			// lab.fileUrl(url, { w }) asks for /files/w360/name.
			if rest.first == "w", let slash = rest.firstIndex(of: "/"), let w = Int(rest[rest.index(after: rest.startIndex)..<slash]) {
				return computer.thumb(String(rest[rest.index(after: slash)...]), w: min(max(w, 48), 2048))
			}
			return computer.fetchFile(rest)
		}
		return nil
	}

	private func fail(_ task: WKURLSchemeTask, _ code: Int) {
		guard let url = task.request.url,
			let r = HTTPURLResponse(url: url, statusCode: code, httpVersion: "HTTP/1.1", headerFields: nil)
		else { return }
		_ = ifRunning(task) { task.didReceive(r) }
		end(task)
	}

	// Video needs ranges, or WebKit never plays it.
	private func serve(_ task: WKURLSchemeTask, _ file: URL, range: String?) {
		guard let h = try? FileHandle(forReadingFrom: file), let size = try? h.seekToEnd(), let url = task.request.url else { return fail(task, 404) }
		defer { try? h.close() }
		let total = Int(size)
		var from = 0
		var to = total - 1
		var partial = false
		if let m = range?.range(of: #"bytes=\d*-\d*"#, options: .regularExpression) {
			let sides = range![m].dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
			if let a = Int(sides[0]) { from = a; partial = true }
			if sides.count > 1, let b = Int(sides[1]) {
				if sides[0].isEmpty { from = max(total - b, 0) } else { to = min(b, total - 1) }
				partial = true
			}
			if from > to { return fail(task, 416) }
		}
		var headers = [
			"Content-Type": mime(file.lastPathComponent), "Content-Length": String(max(to - from + 1, 0)),
			"Accept-Ranges": "bytes", "Cache-Control": "no-cache",
		]
		if partial { headers["Content-Range"] = "bytes \(from)-\(to)/\(total)" }
		guard let r = HTTPURLResponse(url: url, statusCode: partial ? 206 : 200, httpVersion: "HTTP/1.1", headerFields: headers),
			ifRunning(task, { task.didReceive(r) })
		else { return }
		try? h.seek(toOffset: UInt64(from))
		var left = to - from + 1
		while left > 0 {
			guard let d = try? h.read(upToCount: min(left, 512 * 1024)), !d.isEmpty, ifRunning(task, { task.didReceive(d) }) else { break }
			left -= d.count
		}
		end(task)
	}
}

// A file on the phone, shown by the system's own viewer.
private final class Preview: NSObject, QLPreviewControllerDataSource {
	let file: URL
	init(_ f: URL) { file = f }
	func numberOfPreviewItems(in c: QLPreviewController) -> Int { 1 }
	func previewController(_ c: QLPreviewController, previewItemAt i: Int) -> QLPreviewItem { file as NSURL }
}

final class Screen: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, PHPickerViewControllerDelegate, UIDocumentPickerDelegate {
	static weak var current: Screen?

	private var web: WKWebView?
	private var webBottom: NSLayoutConstraint?
	private var subscribed = 0
	private var unlisten: (() -> Void)?
	private var rescueReason: String?
	private var ready = false
	private var picking: String?
	private var listening: String?
	private let voice = AVSpeechSynthesizer()
	private var hearing: Hearing?
	private var preview: Preview?
	// Only <lab-ask> knows it, so only it can answer an Allow card.
	private var askKey = ""
	private var insets: J = ["kind": "insets"]
	private var keyboard: CGFloat = 0
	private var watchdog: DispatchWorkItem?
	private var slow = false
	// Renderer deaths before the page was ready, so a design that keeps killing it reaches the safe screen.
	private var deaths = 0
	private var autoRescue = false
	private var pageError: String?
	private var visible = false
	private var stale = false
	private var showingApp = false
	private var wantsBack = false
	private var statusStyle: UIStatusBarStyle = .default
	private let prefs = UserDefaults(suiteName: "lab")!

	override var preferredStatusBarStyle: UIStatusBarStyle { statusStyle }

	private var patience: TimeInterval { slow ? 20 : 8 }

	override func viewDidLoad() {
		super.viewDidLoad()
		Screen.current = self
		paintStart()
		Hub.onDesign = { [weak self] in
			guard let self else { return }
			self.slow = false
			self.deaths = 0
			if self.autoRescue {
				self.autoRescue = false
				self.rescueReason = nil
			}
			if self.rescueReason == nil { self.freshen() }
		}
		Hub.onReset = { [weak self] in self?.freshen() }
		// Another computer's design, on its own address, in a fresh WebView.
		Hub.onSwitch = { [weak self] in
			guard let self else { return }
			self.rescueReason = nil
			self.autoRescue = false
			self.slow = false
			self.deaths = 0
			self.ready = false
			self.build()
		}
		NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoved(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
		let edge = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(swipedBack(_:)))
		edge.edges = .left
		view.addGestureRecognizer(edge)
		#if DEBUG
		watchForTests()
		#endif
		Hub.start()
		build()
	}

	private func freshen() {
		if visible { load() } else { stale = true }
	}

	func becameActive() {
		visible = true
		Notifier.clearReplies(Hub.on)
		if web == nil {
			stale = false
			build()
		} else if stale {
			stale = false
			load()
		} else if showingApp, !ready {
			startWatchdog()
		}
	}

	func wentAway() {
		visible = false
		watchdog?.cancel()
	}

	func arrive(_ url: URL) {
		guard url.scheme == "thelab", url.host == "pair" else { return }
		let q = Dictionary(
			(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") },
			uniquingKeysWith: { a, _ in a })
		pairFrom(q)
	}

	#if DEBUG
	// check.mjs drives a debug build through files in its Documents folder, as
	// opening a link can stop on a system prompt that nothing can tap in CI.
	private func watchForTests() {
		let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
		let file = docs.appendingPathComponent("command.json")
		prefs.set(true, forKey: "askedNotify")
		Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
			guard let self, let d = try? Data(contentsOf: file), let c = parseJSON(String(decoding: d, as: UTF8.self)) else { return }
			try? FileManager.default.removeItem(at: file)
			let answer = docs.appendingPathComponent("answer-\(c["id"] as? Int ?? 0).json")
			self.runForTest(c) { try? jsonData($0).write(to: answer, options: .atomic) }
		}
	}

	private func runForTest(_ c: J, _ done: @escaping (J) -> Void) {
		switch c["op"] as? String {
		case "pair":
			Hub.pair(url: nil, tunnel: (c["spec"] as? J).flatMap(Tunnel.Spec.parse), token: c["token"] as? String ?? "")
			done([:])
		case "switch":
			Hub.switchTo(c["to"] as? String ?? "")
			done([:])
		case "relayOnly":
			Hub.computer(c["to"] as? String).tunnel.direct = { false }
			Hub.computer(c["to"] as? String).tunnel.drop()
			Hub.computer(c["to"] as? String).reconnectNow()
			done([:])
		case "keyboard":
			let height = c["height"] as? CGFloat ?? 0
			let frame = CGRect(x: 0, y: view.bounds.maxY - height, width: view.bounds.width, height: height)
			NotificationCenter.default.post(name: UIResponder.keyboardWillChangeFrameNotification, object: nil, userInfo: [UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: frame)])
			done([:])
		case "state":
			done(["on": Hub.on.id, "url": web?.url?.absoluteString ?? "", "ready": ready, "link": Hub.on.state, "route": Hub.on.tunnel.route ?? "", "why": Hub.on.tunnel.why])
		case "eval":
			guard let web else { return done(["error": "no page"]) }
			// The nicer Swift form links libswiftWebKit, which isn't in the iOS 18.5
			// simulator, so the app dies before it starts.
			web.__callAsyncJavaScript(c["js"] as? String ?? "", arguments: [:], inFrame: nil, in: .page) { v, e in
				if let e { return done(["error": "\(e)"]) }
				done(["value": v as? String ?? ""])
			}
		default:
			done(["error": "no such command"])
		}
	}
	#endif

	// A pairing link only counts once he has said yes to the address in it.
	private func pairFrom(_ q: [String: String]) {
		guard let code = q["c"] else { return }
		var tunnel: Tunnel.Spec?
		if let room = q["o"] {
			let lan = (q["l"] ?? "").split(separator: ",").map(String.init)
			tunnel = Tunnel.Spec.parse(["relay": q["r"] ?? "", "room": room, "key": q["k"] ?? "", "pass": q["p"] ?? "", "lan": lan])
			if tunnel == nil { return toast("That pairing link is damaged. Show a new code on the computer.") }
		}
		var base = q["u"]
		while base?.hasSuffix("/") == true { base?.removeLast() }
		if tunnel == nil, URL(string: base ?? "")?.scheme != "https" { return toast("That pairing link isn't from The Lab.") }
		let where_: String
		if let t = tunnel {
			where_ = t.relay.flatMap { URL(string: $0)?.host } ?? "your Wi-Fi"
		} else {
			where_ = URL(string: base ?? "")?.host ?? "that address"
		}
		let known = Hub.known(url: base, tunnel: tunnel) != nil
		let message = tunnel != nil
			? "The Lab will talk to the computer that showed this code, straight over Wi-Fi when it can and through \(where_) otherwise. Only say yes if you just scanned the code on your own computer."
			: "The Lab will talk to \(where_) from now on. Only say yes if you just scanned the code on your own computer."
		let a = UIAlertController(title: known || !Hub.paired ? "Pair With This Computer?" : "Add Another Computer?", message: message, preferredStyle: .alert)
		a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
		a.addAction(UIAlertAction(title: "Pair", style: .default) { [weak self] _ in
			Hub.claim(base: base, tunnel: tunnel, code: code) { err in
				self?.toast(err ?? "Paired with the computer.")
				if err == nil {
					self?.rescueReason = nil
					self?.load()
				}
			}
		})
		show(a)
	}

	private func show(_ c: UIViewController) {
		var top: UIViewController = self
		while let p = top.presentedViewController { top = p }
		top.present(c, animated: true)
	}

	func toast(_ text: String) {
		let l = PaddedLabel()
		l.text = text
		l.numberOfLines = 0
		l.textAlignment = .center
		l.font = .preferredFont(forTextStyle: .subheadline)
		l.textColor = .white
		l.backgroundColor = UIColor(white: 0.1, alpha: 0.92)
		l.layer.cornerRadius = 14
		l.clipsToBounds = true
		l.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(l)
		NSLayoutConstraint.activate([
			l.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 20),
			l.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -20),
			l.centerXAnchor.constraint(equalTo: view.centerXAnchor),
			l.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -90),
		])
		DispatchQueue.main.asyncAfter(deadline: .now() + 4) { l.removeFromSuperview() }
		UIAccessibility.post(notification: .announcement, argument: text)
	}

	// In the app rather than on the page, so it's there and can be trusted
	// whatever the agent has made of this computer's design.
	private func chooseComputer() {
		let a = UIAlertController(title: "Your Computers", message: nil, preferredStyle: .actionSheet)
		for c in Hub.pairedComputers {
			let state = c.waiting ? "Needs your OK" : c.working ? "Working" : c.state == "online" ? "Ready" : "Can't reach it right now"
			a.addAction(UIAlertAction(title: "\(c.name)\(c === Hub.on ? " (this one)" : ""): \(state)", style: .default) { _ in Hub.switchTo(c.id) })
		}
		a.addAction(UIAlertAction(title: "Add Another", style: .default) { [weak self] _ in
			let info = UIAlertController(title: "Add a Computer", message: "Set up The Lab on the other computer, or ask its agent to show the pairing code, then point this phone's camera at the code. The computers you already have stay as they are.", preferredStyle: .alert)
			info.addAction(UIAlertAction(title: "OK", style: .default))
			self?.show(info)
		})
		if Hub.on.paired {
			a.addAction(UIAlertAction(title: "Forget This One", style: .destructive) { [weak self] _ in self?.confirmForget() })
		}
		a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
		a.popoverPresentationController?.sourceView = view
		a.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
		show(a)
	}

	private func confirmForget() {
		let c = Hub.on!
		let a = UIAlertController(title: "Forget \(c.name)?", message: "This phone's copy of its history and any unsent messages go. Nothing changes on the computer, and you can pair it again later.", preferredStyle: .alert)
		a.addAction(UIAlertAction(title: "Cancel", style: .cancel))
		a.addAction(UIAlertAction(title: "Forget", style: .destructive) { _ in Hub.forget(c) })
		show(a)
	}

	// The computer's checks, then this phone's own.
	private func check(_ id: String) {
		Hub.on.request("GET", "/check", nil) { [weak self] text, err in
			guard let self else { return }
			var items = text.flatMap(parseJSON)?["items"] as? [J]
				?? [["ok": false, "title": "Can't reach the computer", "detail": err ?? (Hub.on.tunnel.spec != nil ? "Check the computer is awake and online." : "Check the computer is awake and Tailscale is on.")]]
			Notifier.enabled { on in
				if !on {
					items.append(["ok": false, "title": "Notifications are off for The Lab", "detail": "You won't hear when it needs your OK.", "fix": "notifications"])
				} else if Hub.pushToken == nil {
					items.append(["ok": false, "title": "Notifications only arrive while The Lab is open", "detail": "An iPhone freezes apps in the background, so hearing from the computer while The Lab is shut needs this build to be signed for Apple's push service. SETUP.md has the steps."])
				} else {
					items.append(["ok": true, "title": "This phone shows The Lab's notifications"])
				}
				switch Hub.on.tunnel.route {
				case "direct": items.append(["ok": true, "title": "Connected straight to the computer over this network"])
				case "relay": items.append(["ok": true, "title": "Connected to the computer through the relay"])
				default: break
				}
				self.answer(id, jsonString(["items": items]))
			}
		}
	}

	private func fix(_ what: String) {
		switch what {
		case "notifications":
			if let u = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(u) }
		case "tailscale":
			if let u = URL(string: "https://apps.apple.com/app/tailscale/id1470499037") { UIApplication.shared.open(u) }
		default:
			break
		}
	}

	private func drop() {
		unlisten?()
		unlisten = nil
		subscribed += 1
		web?.configuration.userContentController.removeAllScriptMessageHandlers()
		web?.removeFromSuperview()
		web = nil
	}

	private func build() {
		drop()
		let computer = Hub.on!
		let config = WKWebViewConfiguration()
		config.setURLSchemeHandler(PageFiles(computer), forURLScheme: "lab")
		config.allowsInlineMediaPlayback = true
		config.mediaTypesRequiringUserActionForPlayback = []
		config.preferences.javaScriptCanOpenWindowsAutomatically = false
		// A fresh key for each WebView, and ask.js before anything else, so it holds the
		// built-ins it needs and answers through labAsk rather than the page's own channel.
		askKey = (0..<16).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
		let ask = String(decoding: resource("ask.js") ?? Data(), as: UTF8.self).replacingOccurrences(of: "__LAB_ASK_KEY__", with: askKey)
		let bridge = String(decoding: resource("bridge.js") ?? Data(), as: UTF8.self)
		for source in [ask, Screen.shim, bridge] {
			config.userContentController.addUserScript(WKUserScript(source: "if (location.protocol === 'lab:') {\n\(source)\n}", injectionTime: .atDocumentStart, forMainFrameOnly: true))
		}
		config.userContentController.add(WeakHandler(self), name: "labNative")
		config.userContentController.addScriptMessageHandler(WeakAsk(self), contentWorld: .page, name: "labAsk")
		let w = WKWebView(frame: view.bounds, configuration: config)
		w.isOpaque = false
		w.backgroundColor = .clear
		w.scrollView.backgroundColor = .clear
		w.scrollView.contentInsetAdjustmentBehavior = .never
		w.scrollView.isScrollEnabled = false
		w.scrollView.bounces = false
		w.allowsLinkPreview = false
		w.navigationDelegate = self
		w.uiDelegate = self
		#if DEBUG
		if #available(iOS 16.4, *) { w.isInspectable = true }
		#endif
		w.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(w)
		let bottom = w.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -keyboard)
		NSLayoutConstraint.activate([
			w.topAnchor.constraint(equalTo: view.topAnchor), w.leadingAnchor.constraint(equalTo: view.leadingAnchor),
			w.trailingAnchor.constraint(equalTo: view.trailingAnchor), bottom,
		])
		webBottom = bottom
		web = w
		sendInsets()
		load()
	}

	// What bridge.js and ask.js expect of the Android shell's message channel, so
	// the same two files run here.
	private static let shim = """
	if (!globalThis.labNative) {
		const channel = new EventTarget();
		const handler = webkit.messageHandlers.labNative;
		channel.postMessage = (text) => handler.postMessage(text);
		Object.defineProperty(globalThis, "labNative", { value: channel });
		globalThis.labPlatform = "ios";
		if (!crypto.randomUUID) {
			crypto.randomUUID = () => {
				const b = crypto.getRandomValues(new Uint8Array(16));
				b[6] = (b[6] & 15) | 64;
				b[8] = (b[8] & 63) | 128;
				const h = [...b].map((v) => v.toString(16).padStart(2, "0")).join("");
				return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
			};
		}
	}
	"""

	private func hasDesign() -> Bool {
		FileManager.default.fileExists(atPath: Hub.on.designDir.appendingPathComponent("index.html").path)
	}

	private func startWatchdog() {
		watchdog?.cancel()
		let item = DispatchWorkItem { [weak self] in
			guard let self, !self.ready, self.rescueReason == nil else { return }
			// A busy phone can be slow to start the page, so a quiet first miss
			// gets a longer second go before the design is blamed and put back.
			if !self.slow, self.pageError == nil {
				self.slow = true
				self.load()
				return
			}
			self.broken(self.pageError ?? "The page didn't call lab.ready() within 8 seconds, then 20 more.")
			self.load()
		}
		watchdog = item
		DispatchQueue.main.asyncAfter(deadline: .now() + patience, execute: item)
	}

	private func load() {
		guard let w = web else { return }
		ready = false
		pageError = nil
		wantsBack = false
		watchdog?.cancel()
		showingApp = rescueReason == nil && hasDesign() && Hub.on.paired
		let path = showingApp ? "/app/index.html" : "/shell/rescue.html"
		guard let url = URL(string: Hub.on.origin + path) else { return }
		w.load(URLRequest(url: url))
	}

	private func rescue(_ reason: String) {
		rescueReason = reason
		load()
	}

	// Leaves the loading to the caller, since a WebView whose renderer died can't load anything.
	private func broken(_ why: String) {
		slow = false
		deaths = 0
		autoRescue = true
		// A version that has opened before is more likely a slow or busy phone
		// than a broken design, so it isn't undone.
		if let v = Hub.on.designVersion, v == Hub.on.designOpened {
			rescueReason = "The design didn't finish opening this time, so this is the safe screen. It has opened fine before, so it stays as it is. Tap Back to My Design to try it again."
			return
		}
		Hub.on.reportBroken(why)
		rescueReason = "The design didn't finish loading, so this is the safe screen. The computer is putting the version before it back."
	}

	private func send(_ e: J) { post(jsonString(e)) }

	private func post(_ text: String) {
		web?.evaluateJavaScript("labNative.dispatchEvent(new MessageEvent('message', { data: \(jsonString(text)) }))", completionHandler: nil)
	}

	func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
		guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "lab",
			message.frameInfo.securityOrigin.host == Hub.on.host, let raw = message.body as? String, let m = parseJSON(raw)
		else { return }
		handle(m)
	}

	private func handle(_ m: J) {
		let id = m["id"] as? String ?? ""
		switch m["op"] as? String {
		case "subscribe": subscribe()
		case "send": sendMessage(m)
		case "saveShortcuts": Hub.on.saveShortcuts(m["items"] as? [Any] ?? []) { [weak self] ok in self?.answer(id, ok) }
		case "attach": pick(id, m["kind"] as? String ?? "")
		case "stop": Hub.on.stop { [weak self] ok in if !ok { self?.send(["kind": "stopFailed"]) } }
		case "call":
			let method = (m["method"] as? String ?? "GET").uppercased()
			guard method == "GET" || method == "POST" else { return answer(id, nil, "Only GET and POST go to the computer.") }
			let path = m["path"] as? String ?? ""
			if closedToPage(path) { return answer(id, nil, "The page can't use that route. Questions are answered on their own card, and pairing happens on the phone.") }
			let body = (m["body"] as? String).flatMap { $0.isEmpty ? nil : $0 }
			Hub.on.request(method, path, body) { [weak self] text, err in self?.answer(id, text, err) }
		case "check": check(id)
		case "undo":
			Hub.on.undoDesign { [weak self] ok in
				self?.send(["kind": "undone", "ok": ok])
				if ok { self?.rescueReason = nil }
			}
		case "leaveRescue":
			rescueReason = nil
			autoRescue = false
			slow = false
			load()
		case "pageError":
			let text = String((m["message"] as? String ?? "").prefix(500))
			if !ready, pageError == nil { pageError = text }
			Hub.on.reportError(text, m["where"] as? String ?? "")
		case "rescue": rescue(m["reason"] as? String ?? "Opened the safe screen.")
		case "ready":
			ready = true
			slow = false
			deaths = 0
			watchdog?.cancel()
			if showingApp { Hub.on.openedFine() }
			applyTheme(m)
		case "theme": applyTheme(m)
		case "back": wantsBack = m["on"] as? Bool == true
		case "open": open(m["url"] as? String ?? "")
		case "listen": listen(id)
		case "speak": speak(m["text"] as? String ?? "")
		case "hush": voice.stopSpeaking(at: .immediate)
		case "fix": fix(m["fix"] as? String ?? "")
		case "retry": Hub.reconnectNow()
		case "chooseComputer": chooseComputer()
		default: break
		}
	}

	private func subscribe() {
		subscribed += 1
		let me = subscribed
		unlisten?()
		unlisten = nil
		let c = Hub.on!
		// The header and chips draw from this straight away, and the history
		// follows once it's off the disk.
		var batch: [J] = [c.link, c.status, c.outboxEvent(), insets, Hub.computersEvent()]
		batch += Array(c.live.values)
		let design = hasDesign()
		let reason = rescueReason ?? (!design && c.paired ? "Your design hasn't arrived from the computer yet. It loads as soon as the computer is reachable." : nil)
		if let reason { batch.append(["kind": "rescue", "reason": reason, "hasDesign": design && rescueReason != nil]) }
		post(jsonString(["batch": batch]))
		c.onLoaded { [weak self] in
			guard let self, self.subscribed == me else { return }
			self.post(jsonString(["batch": c.events + [["kind": "loaded"]]]))
			self.unlisten = Hub.listen { [weak self] e in self?.send(e) }
		}
	}

	private func sendMessage(_ m: J) {
		let text = (m["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
		let cid = m["cid"] as? String ?? ""
		let files = (m["files"] as? [Any]).flatMap { $0.isEmpty ? nil : $0 }
		if text.count > 50_000 {
			send(Hub.on.sendFailed(cid, text, "That message is over 50,000 characters, so it didn't send. Try sending it in parts."))
		} else if (files?.count ?? 0) > maxFiles {
			send(Hub.on.sendFailed(cid, text, "That message has more than \(maxFiles) files, so it didn't send. Send them in smaller batches."))
		} else if !text.isEmpty || files != nil, cid.count == 36 {
			Hub.on.send(text, cid: cid, files: files)
		} else if !text.isEmpty {
			send(Hub.on.sendFailed(cid, text, "That message didn't send. Try again."))
		}
		// Asked here, when replies and approvals start to matter, rather than on first launch.
		if !prefs.bool(forKey: "askedNotify") {
			prefs.set(true, forKey: "askedNotify")
			Notifier.ask()
		}
	}

	// From <lab-ask>, which alone holds this WebView's key. Anything else is
	// dropped without a reply. The reply never carries the key.
	// The reply goes through the promise postMessage returned, which the page can't
	// read or rewrite the way it could anything sent to its own channel.
	fileprivate func asked(_ message: WKScriptMessage, _ replyHandler: @escaping (Any?, String?) -> Void) {
		guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "lab",
			message.frameInfo.securityOrigin.host == Hub.on.host,
			let raw = message.body as? String, let m = parseJSON(raw),
			let key = m["key"] as? String, !askKey.isEmpty, Data(key.utf8) == Data(askKey.utf8),
			let nonce = m["nonce"] as? String, let given = m["ref"] as? String,
			let ref = plainName(given), ref.count <= 200, let op = m["op"] as? String
		else { return replyHandler(nil, nil) }
		let computer = Hub.on!
		let reply = { (fields: J) in
			var all = fields
			all["op"] = op
			all["nonce"] = nonce
			replyHandler(jsonString(all), nil)
		}
		if op == "askInfo" {
			computer.askInfo(ref) { code, text in
				reply(["status": code, "ask": code == 200 ? text.flatMap(parseJSON) ?? NSNull() : NSNull()])
			}
			return
		}
		guard op == "askAnswer", isBool(m["allow"]), isBool(m["always"]), let allow = m["allow"] as? Bool, let always = m["always"] as? Bool
		else { return replyHandler(nil, nil) }
		let send = {
			computer.answer(ref, allow: allow, always: always) { code in reply(["status": max(code, 0)]) }
		}
		if !allow { return send() }
		// WebKit can't tell whether something covers the card, so an Allow is asked
		// again where the page can't reach.
		computer.askInfo(ref) { [weak self] code, text in
			guard code == 200, let ask = text.flatMap(parseJSON) else { return reply(["status": code]) }
			guard let self, self.presentedViewController == nil else { return reply(["status": 499]) }
			let detail = ask["detail"] as? String ?? ""
			let alert = UIAlertController(
				title: ask["title"] as? String ?? "Allow this?",
				message: detail.count > 600 ? "\(detail.prefix(600))…" : detail,
				preferredStyle: .alert)
			alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in reply(["status": 499]) })
			alert.addAction(UIAlertAction(title: always ? "Always Allow" : "Allow", style: .default) { _ in send() })
			self.present(alert, animated: true)
		}
	}

	override func viewSafeAreaInsetsDidChange() {
		super.viewSafeAreaInsetsDidChange()
		sendInsets()
	}

	// The page paints behind the bars and gets their sizes as CSS pixels. With
	// the keyboard up the WebView ends where it starts, so nothing is left to pad.
	private func sendInsets() {
		let s = view.safeAreaInsets
		insets = ["kind": "insets", "top": s.top, "left": s.left, "right": s.right, "bottom": keyboard > 0 ? 0 : s.bottom, "keyboard": keyboard > 0]
		send(insets)
	}

	@objc private func keyboardMoved(_ n: Notification) {
		guard let end = n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect else { return }
		let frame = view.convert(end, from: nil)
		keyboard = max(view.bounds.maxY - frame.minY, 0)
		webBottom?.constant = -keyboard
		let time = n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
		UIView.animate(withDuration: time) { self.view.layoutIfNeeded() }
		sendInsets()
	}

	@objc private func swipedBack(_ g: UIScreenEdgePanGestureRecognizer) {
		if g.state == .ended, wantsBack, g.translation(in: view).x > 60 { send(["kind": "back"]) }
	}

	// Only what's been checked, since the page is the agent's design.
	private func applyTheme(_ m: J) {
		guard let t = cleanTheme(m) else { return }
		bars(t)
		prefs.set(jsonString(t), forKey: traitCollection.userInterfaceStyle == .dark ? "look-dark" : "look-light")
	}

	private func bars(_ t: J) {
		statusStyle = (t["topDark"] as? Bool ?? t["dark"] as? Bool ?? false) ? .lightContent : .darkContent
		setNeedsStatusBarAppearanceUpdate()
	}

	// Until the page draws, the window shows last time's background, so a
	// restyled design doesn't open on the stock colours.
	private func paintStart() {
		view.backgroundColor = .systemBackground
		let key = traitCollection.userInterfaceStyle == .dark ? "look-dark" : "look-light"
		guard let raw = prefs.string(forKey: key), let t = parseJSON(raw).flatMap(cleanTheme), let bg = t["bg"] as? String,
			let n = Int(bg.dropFirst(), radix: 16)
		else { return }
		view.backgroundColor = UIColor(red: CGFloat(n >> 16 & 255) / 255, green: CGFloat(n >> 8 & 255) / 255, blue: CGFloat(n & 255) / 255, alpha: 1)
		bars(t)
	}

	// Answers a promise the page is waiting on.
	private func answer(_ id: String, _ value: Any?, _ error: String? = nil) {
		var r: J = ["reply": id]
		if let error { r["error"] = error } else { r["value"] = value ?? NSNull() }
		send(r)
	}

	// A sheet of the app's own, so the mic never runs without him seeing it, whatever the page does.
	private func listen(_ id: String) {
		if let was = listening { answer(was, "") }
		listening = id
		hearing?.stop()
		let h = Hearing()
		hearing = h
		h.start(on: self) { [weak self] text, problem in
			guard let self, self.listening == id else { return }
			self.listening = nil
			self.hearing = nil
			if let problem { self.answer(id, nil, problem) } else { self.answer(id, text) }
		}
	}

	private func speak(_ text: String) {
		let said = String(text.prefix(4000))
		if said.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return }
		voice.stopSpeaking(at: .immediate)
		// Dictation leaves the session recording, which has no way to be heard.
		if listening == nil {
			let session = AVAudioSession.sharedInstance()
			try? session.setCategory(.playback, mode: .spokenAudio, options: .mixWithOthers)
			try? session.setActive(true)
		}
		voice.speak(AVSpeechUtterance(string: said))
	}

	private func pick(_ id: String, _ kind: String) {
		if let was = picking { answer(was, []) }
		picking = id
		if kind == "photos" {
			var c = PHPickerConfiguration()
			c.filter = .images
			c.selectionLimit = 10
			let p = PHPickerViewController(configuration: c)
			p.delegate = self
			show(p)
		} else {
			let p = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
			p.allowsMultipleSelection = true
			p.delegate = self
			show(p)
		}
	}

	func picker(_ c: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
		c.dismiss(animated: true)
		if results.isEmpty { return picked([]) }
		let group = DispatchGroup()
		let lock = NSLock()
		var files: [URL] = []
		let holding = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try? FileManager.default.createDirectory(at: holding, withIntermediateDirectories: true)
		for r in results {
			group.enter()
			r.itemProvider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, _ in
				defer { group.leave() }
				guard let url else { return }
				// The system takes its copy away when this returns.
				let keep = holding.appendingPathComponent(url.lastPathComponent)
				if (try? FileManager.default.copyItem(at: url, to: keep)) != nil {
					lock.lock()
					files.append(keep)
					lock.unlock()
				}
			}
		}
		group.notify(queue: .main) { [weak self] in self?.picked(files) }
	}

	func documentPicker(_ c: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { picked(urls) }
	func documentPickerWasCancelled(_ c: UIDocumentPickerViewController) { picked([]) }

	private func picked(_ files: [URL]) {
		guard let id = picking else { return }
		picking = nil
		if files.isEmpty { return answer(id, []) }
		let c = Hub.on!
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			var out: [J] = []
			var problem: String?
			do {
				for f in files.prefix(maxFiles) { out.append(try c.upload(f, name: f.lastPathComponent)) }
				if files.count > maxFiles { problem = "Only the first \(maxFiles) files were attached. Send the rest in another message." }
			} catch {
				problem = (error as? Trouble)?.text ?? "Couldn't attach that."
			}
			DispatchQueue.main.async {
				guard let self else { return }
				if out.isEmpty, let problem { return self.answer(id, nil, problem) }
				self.answer(id, out)
				if let problem { self.toast(problem) }
			}
		}
	}

	private func open(_ url: String) {
		guard let u = URL(string: url) else { return }
		if u.scheme == "http" || u.scheme == "https" { return openExternal(u) }
		let name = u.lastPathComponent.removingPercentEncoding ?? u.lastPathComponent
		let c = Hub.on!
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			let f = c.fetchFile(name)
			DispatchQueue.main.async {
				guard let self else { return }
				guard let f else { return self.send(["kind": "openFailed", "url": url]) }
				let p = Preview(f)
				self.preview = p
				let q = QLPreviewController()
				q.dataSource = p
				self.show(q)
			}
		}
	}

	private func openExternal(_ u: URL) {
		if u.scheme == "http" || u.scheme == "https" { UIApplication.shared.open(u) }
	}

	// Not from load(), as a busy phone took 38 seconds just to start WebKit's process
	// and a design that was never given a chance got reported as broken.
	func webView(_ w: WKWebView, didCommit navigation: WKNavigation!) {
		if showingApp, visible, !ready { startWatchdog() }
	}

	func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		guard let u = a.request.url else { return decisionHandler(.cancel) }
		if u.scheme == "lab", u.host == Hub.on.host { return decisionHandler(.allow) }
		if a.targetFrame?.isMainFrame == false, u.scheme == "about" { return decisionHandler(.allow) }
		openExternal(u)
		decisionHandler(.cancel)
	}

	func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
		if let u = a.request.url { openExternal(u) }
		return nil
	}

	// The page's renderer died (out of memory, or a crash), so start over with a
	// fresh one. A hidden page's death is iOS reclaiming memory, not the design.
	func webViewWebContentProcessDidTerminate(_ w: WKWebView) {
		if visible, !ready, showingApp {
			deaths += 1
			if deaths >= 2 { broken("The page's renderer stopped twice before the page was ready.") }
		}
		if visible { build() } else { drop() }
	}
}

private final class PaddedLabel: UILabel {
	override func drawText(in rect: CGRect) { super.drawText(in: rect.insetBy(dx: 14, dy: 10)) }
	override var intrinsicContentSize: CGSize {
		let s = super.intrinsicContentSize
		return CGSize(width: s.width + 28, height: s.height + 20)
	}
}

// WebKit holds its handlers strongly, which would keep the screen alive for good.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
	weak var target: WKScriptMessageHandler?
	init(_ t: WKScriptMessageHandler) { target = t }
	func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
		target?.userContentController(c, didReceive: m)
	}
}

private final class WeakAsk: NSObject, WKScriptMessageHandlerWithReply {
	weak var target: Screen?
	init(_ t: Screen) { target = t }
	func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
		guard let target else { return replyHandler(nil, nil) }
		target.asked(m, replyHandler)
	}
}

// iOS has no system speech screen as Android does, so this is the visible part
// of it: a sheet that's up for exactly as long as the mic is on.
private final class Hearing {
	private let engine = AVAudioEngine()
	private let request = SFSpeechAudioBufferRecognitionRequest()
	private var task: SFSpeechRecognitionTask?
	private var sheet: UIAlertController?
	private var heard = ""
	private var done: ((String, String?) -> Void)?

	func start(on screen: UIViewController, done: @escaping (String, String?) -> Void) {
		self.done = done
		SFSpeechRecognizer.requestAuthorization { speech in
			AVAudioSession.sharedInstance().requestRecordPermission { mic in
				DispatchQueue.main.async {
					guard speech == .authorized else {
						return self.finish("Speech recognition is off for The Lab. Switch it on in Settings, then The Lab.")
					}
					guard mic else {
						return self.finish("The microphone is off for The Lab. Switch it on in Settings, then The Lab.")
					}
					self.begin(on: screen)
				}
			}
		}
	}

	private func begin(on screen: UIViewController) {
		guard let r = SFSpeechRecognizer(), r.isAvailable else {
			return finish("Speech recognition isn't available on this phone right now.")
		}
		do {
			let session = AVAudioSession.sharedInstance()
			try session.setCategory(.record, mode: .measurement, options: .duckOthers)
			try session.setActive(true, options: .notifyOthersOnDeactivation)
			let input = engine.inputNode
			input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [request] b, _ in request.append(b) }
			engine.prepare()
			try engine.start()
		} catch {
			return finish("The microphone couldn't start. Try again in a moment.")
		}
		request.shouldReportPartialResults = true
		let a = UIAlertController(title: "Listening", message: "Say your message.", preferredStyle: .alert)
		a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in
			self.heard = ""
			self.finish(nil)
		})
		a.addAction(UIAlertAction(title: "Done", style: .default) { _ in self.finish(nil) })
		sheet = a
		var top = screen
		while let p = top.presentedViewController { top = p }
		top.present(a, animated: true)
		task = r.recognitionTask(with: request) { [weak self] result, error in
			DispatchQueue.main.async {
				guard let self else { return }
				if let t = result?.bestTranscription.formattedString {
					self.heard = t
					self.sheet?.message = t
				}
				if error != nil || result?.isFinal == true { self.finish(nil) }
			}
		}
	}

	func stop() {
		done = nil
		finish(nil)
	}

	private func finish(_ problem: String?) {
		if engine.isRunning {
			engine.stop()
			engine.inputNode.removeTap(onBus: 0)
		}
		request.endAudio()
		task?.cancel()
		task = nil
		try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
		if sheet?.presentingViewController != nil { sheet?.dismiss(animated: true) }
		sheet = nil
		let d = done
		done = nil
		d?(heard, problem)
	}
}
