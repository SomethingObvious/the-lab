// The Lab's window on this Mac. It shows the same app/ as the phone, in the
// WKWebView macOS already has, and signs in with the token from the lab
// folder named in Info.plist, so the token never goes on a command line.
// Cookies stay in memory, since a cookie file outside the lab folder is one
// the agent could read. setup.ts puts askScript, the Allow card's script in
// base64, at the top of this file when it builds it.

import Cocoa
import Security
import WebKit

final class Shell: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
	WKScriptMessageHandler, WKScriptMessageHandlerWithReply
{
	let lab: URL
	let check: String?
	var window: NSWindow!
	var web: WKWebView!
	var origin = ""
	var port = 0
	var token = ""
	// The stand-in page showing while the app can't, or nil.
	var page: String?
	var probing = false
	var popups: [NSWindow] = []
	// Only the script injected into this window knows it, so a message that
	// carries it came from <lab-ask> and not from the design.
	let key: String = {
		var b = [UInt8](repeating: 0, count: 16)
		guard SecRandomCopyBytes(kSecRandomDefault, b.count, &b) == errSecSuccess else { fatalError("No secure random bytes") }
		return b.map { String(format: "%02x", $0) }.joined()
	}()
	let session = URLSession(configuration: .ephemeral)
	// What encodeURIComponent leaves alone.
	static let plain = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")

	init(lab: URL, check: String?) {
		self.lab = lab
		self.check = check
	}

	func applicationDidFinishLaunching(_: Notification) {
		menus()
		let config = WKWebViewConfiguration()
		config.websiteDataStore = .nonPersistent()
		// A page can only open a window when he clicked something.
		config.preferences.javaScriptCanOpenWindowsAutomatically = false
		config.userContentController.addUserScript(
			WKUserScript(
				source: "globalThis.labShell = 'desktop'; globalThis.labOs = 'mac';",
				injectionTime: .atDocumentStart,
				forMainFrameOnly: true))
		// Built into the binary, so the agent can't swap it, and kept off the
		// stand-in pages, which aren't on the computer's address.
		let ask = String(decoding: Data(base64Encoded: askScript) ?? Data(), as: UTF8.self)
		config.userContentController.addUserScript(
			WKUserScript(
				source: "if (location.hostname === '127.0.0.1') {\n\(ask.replacingOccurrences(of: "__LAB_ASK_KEY__", with: key))\n}",
				injectionTime: .atDocumentStart,
				forMainFrameOnly: true))
		config.userContentController.add(self, name: "lab")
		config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "labAsk")
		web = WKWebView(frame: .zero, configuration: config)
		web.navigationDelegate = self
		web.uiDelegate = self
		// Without this the page flashes white before it draws, in dark mode too.
		web.setValue(false, forKey: "drawsBackground")
		// The page draws its own title bar under the traffic lights, which stay.
		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
			styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
			backing: .buffered,
			defer: false)
		window.title = "The Lab"
		window.titleVisibility = .hidden
		window.titlebarAppearsTransparent = true
		window.minSize = NSSize(width: 360, height: 480)
		window.contentView = web
		window.delegate = self
		window.isReleasedWhenClosed = false
		if check == nil {
			window.center()
			window.setFrameAutosaveName("The Lab")
			window.makeKeyAndOrderFront(nil)
			NSApp.activate(ignoringOtherApps: true)
		} else {
			window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
			window.orderBack(nil)
		}
		go()
	}

	func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
		true
	}

	// A closed popup is let go, and its page with it, so nothing keeps playing.
	func windowWillClose(_ n: Notification) {
		guard let closing = n.object as? NSWindow else { return }
		if closing === window { return NSApp.terminate(nil) }
		closing.contentView = nil
		popups.removeAll { $0 === closing }
	}

	func windowDidResize(_: Notification) { tell() }
	func windowDidBecomeKey(_: Notification) { tell() }
	func windowDidResignKey(_: Notification) { tell() }

	// Tells the page whether the window is zoomed and in front, so its title
	// bar can match.
	func tell() {
		web?.evaluateJavaScript(
			"globalThis.labHost && labHost({kind: 'window', maximized: \(window.isZoomed), active: \(window.isKeyWindow)})")
	}

	func fromApp(_ m: WKScriptMessage) -> Bool {
		let o = m.frameInfo.securityOrigin
		return m.webView === web && m.frameInfo.isMainFrame && o.protocol == "http" && o.host == "127.0.0.1"
			&& o.port == port && port != 0
	}

	// What the page's title bar asks for. The agent can change the page, so a
	// reveal only shows a file the phone or the agent sent, and opens nothing.
	// A stand-in page only has the drag and Undo.
	func userContentController(_: WKUserContentController, didReceive m: WKScriptMessage) {
		let app = fromApp(m)
		guard app || (page != nil && m.webView === web && m.frameInfo.request.url?.scheme != "http"),
			let body = m.body as? [String: Any]
		else { return }
		switch body["window"] as? String {
		case "minimize": window.miniaturize(nil)
		case "maximize": window.zoom(nil)
		case "close": window.performClose(nil)
		case "drag": if let e = NSApp.currentEvent { window.performDrag(with: e) }
		default: break
		}
		if !app {
			if body["undo"] as? Bool == true, page?.hasPrefix("missing") == true { undo() }
			return
		}
		if let path = body["reveal"] as? String { reveal(path) }
	}

	func reveal(_ path: String) {
		guard path.hasPrefix("/files/"), let name = String(path.dropFirst(7)).removingPercentEncoding,
			!name.contains("/"), !name.hasPrefix(".")
		else { return }
		let file = lab.appendingPathComponent("files").appendingPathComponent(name)
		if FileManager.default.fileExists(atPath: file.path) {
			NSWorkspace.shared.activateFileViewerSelecting([file])
		}
	}

	// <lab-ask> asking for a question or passing on his answer. Anything
	// without this window's key gets an empty reply, which it ignores.
	func userContentController(
		_: WKUserContentController, didReceive m: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void
	) {
		guard fromApp(m), let text = m.body as? String,
			let o = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any],
			o["key"] as? String == key, let nonce = o["nonce"] as? String,
			let ref = o["ref"] as? String, !ref.isEmpty,
			let escaped = ref.addingPercentEncoding(withAllowedCharacters: Shell.plain)
		else { return replyHandler(nil, nil) }
		let reply = { (fields: [String: Any]) in
			var all = fields
			all["nonce"] = nonce
			let data = (try? JSONSerialization.data(withJSONObject: all)) ?? Data("{}".utf8)
			replyHandler(String(decoding: data, as: UTF8.self), nil)
		}
		switch o["op"] as? String {
		case "askInfo":
			computer("GET", "/asks/\(escaped)", nil) { status, data in
				let ask = status == 200 ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) } : nil
				reply(["op": "askInfo", "status": status, "ask": ask ?? NSNull()])
			}
		case "askAnswer":
			guard let allow = o["allow"] as? Bool, let always = o["always"] as? Bool,
				let body = try? JSONSerialization.data(withJSONObject: ["ref": ref, "allow": allow, "always": always])
			else { return replyHandler(nil, nil) }
			let send = {
				self.computer("POST", "/answer", body) { status, _ in reply(["op": "askAnswer", "status": status]) }
			}
			if !allow { return send() }
			// WebKit can't tell whether something covers the card, so an Allow
			// is asked again where the page can't reach.
			computer("GET", "/asks/\(escaped)", nil) { status, data in
				guard status == 200, let data,
					let ask = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
				else { return reply(["op": "askAnswer", "status": status]) }
				let alert = NSAlert()
				alert.messageText = ask["title"] as? String ?? "Allow this?"
				let detail = ask["detail"] as? String ?? ""
				alert.informativeText = detail.count > 600 ? "\(detail.prefix(600))…" : detail
				alert.addButton(withTitle: always ? "Always Allow" : "Allow")
				alert.addButton(withTitle: "Cancel")
				alert.beginSheetModal(for: self.window) { r in
					if r == .alertFirstButtonReturn { send() } else { reply(["op": "askAnswer", "status": 499]) }
				}
			}
		default:
			replyHandler(nil, nil)
		}
	}

	// A request to the computer with the token, which the page never sees.
	// The status is 0 when it didn't answer.
	func computer(
		_ method: String, _ path: String, _ body: Data?, timeout: TimeInterval = 15,
		done: @escaping (Int, Data?) -> Void
	) {
		guard let url = URL(string: origin + path) else { return done(0, nil) }
		var req = URLRequest(url: url)
		req.httpMethod = method
		req.timeoutInterval = timeout
		req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
		if let body {
			req.httpBody = body
			req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		}
		session.dataTask(with: req) { data, res, _ in
			let status = (res as? HTTPURLResponse)?.statusCode ?? 0
			DispatchQueue.main.async { done(status, data) }
		}.resume()
	}

	// Signs in with the same cookie pairing would set, so the token never
	// goes in a URL.
	func go() {
		let text = (try? String(contentsOf: lab.appendingPathComponent("config.json"), encoding: .utf8)) ?? ""
		let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
		guard let t = json?["token"] as? String, let p = json?["port"] as? Int,
			let value = t.addingPercentEncoding(withAllowedCharacters: Shell.plain),
			let url = URL(string: "http://127.0.0.1:\(p)/"),
			let cookie = HTTPCookie(properties: [
				.name: "lab", .value: value, .domain: "127.0.0.1", .path: "/",
				.expires: Date(timeIntervalSinceNow: 31_536_000),
				.sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict.rawValue,
				HTTPCookiePropertyKey("HttpOnly"): "TRUE",
			]),
			// The page must never be able to read the token from document.cookie.
			cookie.isHTTPOnly
		else { return down() }
		origin = "http://127.0.0.1:\(p)"
		port = p
		token = t
		page = nil
		web.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
			self.web.load(URLRequest(url: url))
		}
	}

	// The server restarts after an update and isn't running before sign-in
	// finishes, so the window waits for it rather than showing an error page.
	func down() {
		show("down", "<p>The Lab isn't answering on this Mac yet.<br>This window connects by itself once it's back.</p>")
	}

	func missing(_ tried: Bool) {
		show(
			tried ? "missing again" : "missing",
			"<p>The app's design is missing on this Mac, so there's nothing to show.</p>"
				+ (tried
					? "<p>There's no earlier design to go back to. Open the safe screen on the phone and ask the agent to put the app back.</p>"
					: "<p>Undo the last design change to put the one before it back, or tap Undo Last Design Change on the phone's safe screen.</p><p><button class=pill>Undo Last Design Change</button></p>")
				+ "<p>This window opens the app by itself once it's back.</p>")
	}

	// A stand-in page. The traffic lights stay, and the strip under them
	// moves the window the way the app's title bar does.
	func show(_ which: String, _ body: String) {
		if page == which { return }
		page = which
		web.loadHTMLString(
			"<!doctype html><meta charset=utf-8><style>body{margin:0;height:100vh;display:grid;place-items:center;font:15px system-ui;color:#888;text-align:center}main{max-width:34em;padding:0 24px}.bar{position:fixed;top:0;left:0;right:0;height:28px}.pill{font:inherit;font-weight:600;color:inherit;background:#8882;border:1px solid #8886;border-radius:20px;padding:8px 16px}</style><div class=bar></div><main>\(body)</main><script>const lab=webkit.messageHandlers.lab;document.querySelector('.bar').addEventListener('mousedown',()=>lab.postMessage({window:'drag'}));document.addEventListener('click',e=>{const b=e.target.closest('button');if(b){b.disabled=true;lab.postMessage({undo:true})}})</script>",
			baseURL: nil)
		if !probing {
			probing = true
			DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.probe() }
		}
	}

	// Asks for / itself, so a window showing the missing design opens the app
	// once it's back, and one showing the server down learns which it is.
	func probe() {
		guard page != nil else {
			probing = false
			return
		}
		let again = { DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.probe() } }
		if origin.isEmpty {
			go()
			return again()
		}
		computer("GET", "/", nil, timeout: 2) { status, _ in
			if self.page != nil {
				if status == 200 {
					self.go()
				} else if status == 404 {
					self.missing(self.page == "missing again")
				} else {
					self.down()
				}
			}
			again()
		}
	}

	func undo() {
		computer("POST", "/design/undo", Data("{}".utf8)) { status, _ in
			if status == 200 { self.go() } else { self.missing(true) }
		}
	}

	func ours(_ url: URL?) -> Bool {
		guard let s = url?.absoluteString, !origin.isEmpty else { return false }
		return s.hasPrefix("\(origin)/")
	}

	func webView(
		_: WKWebView, decidePolicyFor action: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
	) {
		let url = action.request.url
		if ours(url) || url?.scheme == "about" || url?.scheme == "data" {
			return decisionHandler(.allow)
		}
		decisionHandler(.cancel)
		open(url)
	}

	func webView(
		_ view: WKWebView, decidePolicyFor r: WKNavigationResponse,
		decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
	) {
		// The server answers 404 for / when the design's index.html is gone,
		// which waiting won't fix.
		if view === web, r.isForMainFrame, (r.response as? HTTPURLResponse)?.statusCode == 404,
			r.response.url?.absoluteString == "\(origin)/"
		{
			missing(false)
			return decisionHandler(.cancel)
		}
		// A file WebKit can't show, like a .docx or a .zip, is shown in the
		// Finder instead, and its empty window goes away.
		if view !== web, !r.canShowMIMEType {
			decisionHandler(.cancel)
			if let url = r.response.url, ours(url) { reveal(url.path) }
			DispatchQueue.main.async { view.window?.close() }
			return
		}
		decisionHandler(.allow)
	}

	// Only the main window falls back to the stand-in page, and not when it
	// turned the load away itself for the missing design. A popup that fails
	// stays as it is.
	func webView(_ view: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError e: Error) {
		if view === web, page == nil, (e as NSError).code != NSURLErrorCancelled { down() }
	}

	func webView(_ view: WKWebView, didFinish _: WKNavigation!) {
		if view === web { tell() }
		guard let check, view === web, ours(web.url) else { return }
		DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.report(check) }
	}

	func webViewWebContentProcessDidTerminate(_ view: WKWebView) {
		if view === web { go() } else { view.window?.close() }
	}

	// Its own pages (a photo, the pairing code) open in a plain window that
	// shares the sign-in. Anything else goes to the browser. WebKit only asks
	// on a click, as the main window turns off opening windows automatically.
	// The popup gets its own configuration, so it has neither <lab-ask> nor
	// the message handlers, and WebKit gets nil back.
	func webView(
		_: WKWebView, createWebViewWith _: WKWebViewConfiguration,
		for action: WKNavigationAction, windowFeatures _: WKWindowFeatures
	) -> WKWebView? {
		guard let url = action.request.url, ours(url) else {
			open(action.request.url)
			return nil
		}
		let config = WKWebViewConfiguration()
		config.websiteDataStore = web.configuration.websiteDataStore
		config.preferences.javaScriptCanOpenWindowsAutomatically = false
		let view = WKWebView(frame: .zero, configuration: config)
		view.navigationDelegate = self
		view.uiDelegate = self
		let popup = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 640, height: 720),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false)
		popup.contentView = view
		popup.isReleasedWhenClosed = false
		popup.delegate = self
		popup.cascadeTopLeft(from: window.frame.origin)
		popup.makeKeyAndOrderFront(nil)
		popups.append(popup)
		view.load(URLRequest(url: url))
		return nil
	}

	func webViewDidClose(_ view: WKWebView) {
		view.window?.close()
	}

	// The attach button's file picker. WKWebView has none of its own on macOS.
	func webView(
		_: WKWebView, runOpenPanelWith params: WKOpenPanelParameters,
		initiatedByFrame _: WKFrameInfo, completionHandler done: @escaping ([URL]?) -> Void
	) {
		let panel = NSOpenPanel()
		panel.allowsMultipleSelection = params.allowsMultipleSelection
		panel.canChooseDirectories = false
		panel.beginSheetModal(for: window) { r in done(r == .OK ? panel.urls : nil) }
	}

	func open(_ url: URL?) {
		guard let url, ["https", "http", "mailto"].contains(url.scheme ?? "") else { return }
		NSWorkspace.shared.open(url)
	}

	func report(_ file: String) {
		let asked = "[globalThis.lab && lab.platform, customElements.get('lab-ask') ? 'yes' : 'no']"
		web.evaluateJavaScript(asked) { found, _ in
			let parts = found as? [Any] ?? []
			self.web.takeSnapshot(with: nil) { image, _ in
				if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
					try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: file))
				}
				let text =
					"platform \"\(parts.first as? String ?? "none")\"\nask \"\(parts.last as? String ?? "no")\"\n"
				try? text.write(toFile: "\(file).txt", atomically: true, encoding: .utf8)
				NSApp.terminate(nil)
			}
		}
	}

	// Copy, paste and quit only work through the menu bar, so it needs one.
	func menus() {
		let bar = NSMenu()
		let app = NSMenu()
		app.addItem(withTitle: "Hide The Lab", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
		app.addItem(.separator())
		app.addItem(withTitle: "Quit The Lab", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
		let edit = NSMenu(title: "Edit")
		edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
		edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
		edit.addItem(.separator())
		edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
		edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
		edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
		edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
		let win = NSMenu(title: "Window")
		win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
		win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
		for m in [app, edit, win] {
			let item = NSMenuItem()
			item.submenu = m
			bar.addItem(item)
		}
		NSApp.mainMenu = bar
		NSApp.windowsMenu = win
	}
}

let args = CommandLine.arguments
let check = args.count == 3 && args[1] == "--check" ? args[2] : nil
let named = Bundle.main.object(forInfoDictionaryKey: "LabDir") as? String
let lab = URL(fileURLWithPath: named ?? "\(NSHomeDirectory())/.thelab")
let shell = Shell(lab: lab, check: check)
let app = NSApplication.shared
app.setActivationPolicy(check == nil ? .regular : .accessory)
app.delegate = shell
app.run()
