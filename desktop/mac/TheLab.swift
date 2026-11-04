// The Lab's window on this Mac. It shows the same app/ as the phone, in the
// WKWebView macOS already has, and signs in with the token from the lab
// folder named in Info.plist, so the token never goes on a command line.
// Cookies stay in memory, since a cookie file outside the lab folder is one
// the agent could read.

import Cocoa
import WebKit

final class Shell: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
	let lab: URL
	let check: String?
	var window: NSWindow!
	var web: WKWebView!
	var origin = ""
	var offline = false
	var popups: [NSWindow] = []

	init(lab: URL, check: String?) {
		self.lab = lab
		self.check = check
	}

	func applicationDidFinishLaunching(_: Notification) {
		menus()
		let config = WKWebViewConfiguration()
		config.websiteDataStore = .nonPersistent()
		config.userContentController.addUserScript(
			WKUserScript(
				source: "globalThis.labShell = 'desktop';",
				injectionTime: .atDocumentStart,
				forMainFrameOnly: true))
		web = WKWebView(frame: .zero, configuration: config)
		web.navigationDelegate = self
		web.uiDelegate = self
		// Without this the page flashes white before it draws, in dark mode too.
		web.setValue(false, forKey: "drawsBackground")
		window = NSWindow(
			contentRect: NSRect(x: 0, y: 0, width: 960, height: 700),
			styleMask: [.titled, .closable, .miniaturizable, .resizable],
			backing: .buffered,
			defer: false)
		window.title = "The Lab"
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

	func windowWillClose(_ n: Notification) {
		if n.object as? NSWindow === window { NSApp.terminate(nil) }
	}

	func go() {
		let text = (try? String(contentsOf: lab.appendingPathComponent("config.json"), encoding: .utf8)) ?? ""
		let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any]
		guard let token = json?["token"] as? String, let port = json?["port"] as? Int,
			let escaped = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics),
			let url = URL(string: "http://127.0.0.1:\(port)/pair?t=\(escaped)")
		else { return down() }
		origin = "http://127.0.0.1:\(port)"
		offline = false
		web.load(URLRequest(url: url))
	}

	// The server restarts after an update and isn't running before sign-in
	// finishes, so the window waits for it rather than showing an error page.
	func down() {
		if offline { return }
		offline = true
		web.loadHTMLString(
			"<!doctype html><meta charset=utf-8><body style=\"font:15px system-ui;color:#888;display:grid;place-items:center;height:90vh;margin:0;text-align:center\"><p>The Lab isn't answering on this Mac yet.<br>This window connects by itself once it's back.</p>",
			baseURL: nil)
		probe()
	}

	func probe() {
		guard let url = URL(string: "\(origin.isEmpty ? "http://127.0.0.1:8417" : origin)/health") else { return }
		var req = URLRequest(url: url)
		req.timeoutInterval = 2
		URLSession.shared.dataTask(with: req) { _, res, _ in
			DispatchQueue.main.async {
				if (res as? HTTPURLResponse)?.statusCode == 200 {
					self.go()
				} else {
					DispatchQueue.main.asyncAfter(deadline: .now() + 3) { self.probe() }
				}
			}
		}.resume()
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

	func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError e: Error) {
		if (e as NSError).code != NSURLErrorCancelled { down() }
	}

	func webView(_ view: WKWebView, didFinish _: WKNavigation!) {
		guard let check, view === web, ours(web.url), !(web.url?.path.hasPrefix("/pair") ?? true) else { return }
		DispatchQueue.main.asyncAfter(deadline: .now() + 4) { self.report(check) }
	}

	func webViewWebContentProcessDidTerminate(_: WKWebView) {
		go()
	}

	// Its own pages (a photo, the pairing code) open in a window of their own
	// that shares the sign-in. Anything else goes to the browser.
	func webView(
		_: WKWebView, createWebViewWith config: WKWebViewConfiguration,
		for action: WKNavigationAction, windowFeatures _: WKWindowFeatures
	) -> WKWebView? {
		guard ours(action.request.url) else {
			open(action.request.url)
			return nil
		}
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
		popup.cascadeTopLeft(from: window.frame.origin)
		popup.makeKeyAndOrderFront(nil)
		popups.append(popup)
		NotificationCenter.default.addObserver(
			forName: NSWindow.willCloseNotification, object: popup, queue: .main
		) { [weak self] _ in self?.popups.removeAll { $0 === popup } }
		return view
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
		web.evaluateJavaScript("globalThis.lab && lab.platform") { platform, _ in
			self.web.takeSnapshot(with: nil) { image, _ in
				if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) {
					try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: file))
				}
				let text = "platform \"\(platform as? String ?? "none")\"\n"
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
