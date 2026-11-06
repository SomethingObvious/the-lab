import Foundation
import ImageIO
import Network
import Security
import UIKit
import UniformTypeIdentifiers

private let keep = 2000
private let pairAgain = "Ask the agent on the computer to show the pairing code, then point this phone's camera at it."
private let io = DispatchQueue(label: "lab.io")
// Its own queue, so writing an event never waits behind a design download.
private let disk = DispatchQueue(label: "lab.disk")

private func session(request: TimeInterval, total: TimeInterval = 7 * 86400) -> URLSession {
	let c = URLSessionConfiguration.ephemeral
	c.timeoutIntervalForRequest = request
	c.timeoutIntervalForResource = total
	c.waitsForConnectivity = false
	c.urlCache = nil
	return URLSession(configuration: c)
}

private let client = session(request: 60)
// The server pings every 25 s, so this much silence means the link is dead, and
// the sooner that's noticed the sooner it moves to another route.
private let streaming = session(request: 40)
private let quick = session(request: 8, total: 8)
// The server answers /stop only once the turn has ended, which can take 15 s.
private let stopping = session(request: 25, total: 25)
// Listing the agent's models can take the server 20 s, on top of a relay dial.
private let slow = session(request: 40, total: 40)

// A kept-alive connection is tied to the old tunnel session, and each URLSession keeps its own.
private func freshConnections() {
	for s in [client, streaming, quick, stopping, slow] { s.flush {} }
}

private func folder(_ base: FileManager.SearchPathDirectory, _ path: String) -> URL {
	let url = FileManager.default.urls(for: base, in: .userDomainMask)[0].appendingPathComponent(path)
	try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
	return url
}

// The token and the tunnel's secret stay on this phone and out of its backups.
enum Secrets {
	private static func query(_ name: String) -> [String: Any] {
		[kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "the-lab", kSecAttrAccount as String: name]
	}

	static func get(_ name: String) -> String? {
		var q = query(name)
		q[kSecReturnData as String] = true
		var out: CFTypeRef?
		guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
		return String(decoding: d, as: UTF8.self)
	}

	static func set(_ name: String, _ value: String?) {
		SecItemDelete(query(name) as CFDictionary)
		guard let value else { return }
		var q = query(name)
		q[kSecValueData as String] = Data(value.utf8)
		q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		SecItemAdd(q as CFDictionary, nil)
	}
}

// What the whole phone shares: which computers it's paired with, which one is
// on screen and whoever is listening to that one. All state is touched on the
// main thread only.
enum Hub {
	private static let mainId = "main"
	private static let prefs = UserDefaults(suiteName: "lab")!
	static var computers: [String: Computer] = [:]
	static var order: [String] = []
	static var on: Computer!
	static var paired: Bool { all.contains { $0.paired } }
	static var all: [Computer] { order.compactMap { computers[$0] } }
	static var pairedComputers: [Computer] { all.filter { $0.paired } }
	static var foreground = false
	// Text shared in, held until the design is up and ready to take it.
	static var composing: [J] = []
	static var pushToken: String?

	private static var listeners: [UUID: (J) -> Void] = [:]
	static var onDesign: (() -> Void)?
	// The history was thrown away and fetched again, so the page has to start over.
	static var onReset: (() -> Void)?
	// A different computer is on screen now, so the page has to start over with its design.
	static var onSwitch: (() -> Void)?
	private static var shape: String?
	private static var ready = false

	static func setUp() {
		if ready { return }
		ready = true
		add(Computer(slot: 0))
		for slot in prefs.array(forKey: "computers") as? [Int] ?? [] where slot > 0 { add(Computer(slot: slot)) }
		let saved = computers[prefs.string(forKey: "active") ?? mainId]
		on = saved?.paired == true ? saved : pairedComputers.first ?? computers[mainId]
		Net.shared.onChange = { path in
			let now = path.status == .satisfied
				? [NWInterface.InterfaceType.wifi, .wiredEthernet, .cellular, .other].filter(path.usesInterfaceType).map { "\($0)" }.joined(separator: ",")
				: nil
			DispatchQueue.main.async {
				guard let now else {
					shape = nil
					for c in all { c.networkGone() }
					return
				}
				// A new network can bring a direct route, or take the old one
				// away, so the link starts over on it straight away.
				let moved = shape != nil && shape != now
				shape = now
				for c in all { c.networkChanged(moved: moved) }
			}
		}
	}

	private static func add(_ c: Computer) {
		computers[c.id] = c
		order.append(c.id)
	}

	static func listen(_ l: @escaping (J) -> Void) -> () -> Void {
		let id = UUID()
		listeners[id] = l
		return { listeners[id] = nil }
	}

	static func emit(_ e: J) {
		for l in listeners.values { l(e) }
	}

	static func start() { for c in all { c.start() } }
	static func reconnectNow() { for c in all { c.reconnectNow() } }

	// After a freeze, when no session or port can be trusted.
	static func redial() {
		for c in all {
			c.tunnel.freshPort()
			c.tunnel.drop()
			c.reconnectNow()
		}
	}

	static func computer(_ id: String?) -> Computer { id.flatMap { computers[$0] } ?? on }
	static func computer(room: String?) -> Computer { all.first { $0.tunnel.spec?.room == room } ?? on }

	static func computersEvent() -> J {
		let items: [J] = pairedComputers.map {
			["id": $0.id, "name": $0.name, "state": $0.state, "working": $0.working, "waiting": $0.waiting]
		}
		return ["kind": "computers", "active": on.id, "items": items]
	}

	static func changed() { emit(computersEvent()) }

	static func switchTo(_ id: String) {
		guard let c = computers[id], c.paired, c !== on else { return }
		on = c
		prefs.set(id, forKey: "active")
		composing.removeAll()
		Notifier.clearReplies(c)
		onSwitch?()
	}

	// The computer this pairing is for, if the phone knows it already.
	static func known(url: String?, tunnel: Tunnel.Spec?) -> Computer? {
		all.first { $0.pairedWith(url, tunnel) }
	}

	// A computer it knows gets its new details, and any other is added beside
	// the ones it has, or takes the first place if that's free.
	static func pair(url: String?, tunnel: Tunnel.Spec?, token: String) {
		let free = computers[mainId]?.paired == false ? computers[mainId] : nil
		let c: Computer
		if let k = known(url: url, tunnel: tunnel) ?? free {
			c = k
		} else {
			c = Computer(slot: (all.map(\.slot).max() ?? 0) + 1)
			add(c)
			saveList()
		}
		c.onLoaded {
			c.pair(url, tunnel, token)
			c.start()
			if c === on { onSwitch?() } else { switchTo(c.id) }
			changed()
		}
	}

	static func forget(_ c: Computer) {
		c.wipe()
		if c.slot != 0 {
			computers[c.id] = nil
			order.removeAll { $0 == c.id }
			saveList()
		}
		if c === on || !on.paired {
			on = pairedComputers.first ?? computers[mainId]
			prefs.set(on.id, forKey: "active")
			composing.removeAll()
			onSwitch?()
		}
		changed()
	}

	private static func saveList() {
		prefs.set(all.filter { $0.slot != 0 }.map(\.slot), forKey: "computers")
	}

	// A QR code scanned on the computer hands over a one-time code, which the
	// computer swaps for the token here so the token never sits in a history.
	static func claim(base: String?, tunnel: Tunnel.Spec?, code: String, done: @escaping (String?) -> Void) {
		// Only the claim goes to the new computer. Everything else stays with
		// the ones it's paired with until the token comes back.
		let to = tunnel != nil ? Tunnel().once(tunnel!) : base
		guard let to, let url = URL(string: to + "/pair/claim") else { return done("That pairing link is missing its address.") }
		var req = URLRequest(url: url)
		req.httpMethod = "POST"
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.httpBody = jsonData(["code": code])
		// Its own client, so ending it closes the one-off session as soon as it's answered.
		let once = session(request: 15, total: 15)
		once.dataTask(with: req) { data, response, error in
			let status = (response as? HTTPURLResponse)?.statusCode ?? 0
			let j = data.flatMap { parseJSON(String(decoding: $0, as: UTF8.self)) }
			once.invalidateAndCancel()
			DispatchQueue.main.async {
				if error != nil {
					return done(tunnel != nil
						? "Couldn't reach the computer. Check it's awake and online, then scan the code again."
						: "Couldn't reach the computer. Check Tailscale is on, then scan the code again.")
				}
				if status == 200, let token = j?["token"] as? String {
					pair(url: tunnel != nil ? nil : base, tunnel: tunnel, token: token)
					done(nil)
				} else {
					done(j?["error"] as? String ?? "The computer turned the code down. Scan a new one.")
				}
			}
		}.resume()
	}

	static func registerPush() { for c in pairedComputers { c.registerPush() } }
}

// Server-sent events off a URLSession task, with each event handed over on the
// main thread.
private final class EventStream: NSObject, URLSessionDataDelegate {
	var onOpen: ((HTTPURLResponse) -> Void)?
	var onEvent: ((String?, String) -> Void)?
	var onEnd: ((Error?, Int?) -> Void)?
	private var task: URLSessionDataTask?
	private var buffer = Data()
	private var type: String?
	private var data = ""
	private var code: Int?

	func start(_ req: URLRequest) {
		let t = streaming.dataTask(with: req)
		t.delegate = self
		task = t
		t.resume()
	}

	func cancel() {
		onEnd = nil
		onEvent = nil
		onOpen = nil
		task?.cancel()
	}

	func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
		guard let r = response as? HTTPURLResponse, r.statusCode == 200 else {
			code = (response as? HTTPURLResponse)?.statusCode
			return completionHandler(.cancel)
		}
		DispatchQueue.main.async { self.onOpen?(r) }
		completionHandler(.allow)
	}

	func urlSession(_ s: URLSession, dataTask: URLSessionDataTask, didReceive more: Data) {
		buffer.append(more)
		while let nl = buffer.firstIndex(of: 10) {
			var line = String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self)
			buffer.removeSubrange(buffer.startIndex...nl)
			if line.hasSuffix("\r") { line.removeLast() }
			if line.isEmpty {
				if !data.isEmpty {
					let (t, d) = (type, data)
					DispatchQueue.main.async { self.onEvent?(t, d) }
				}
				type = nil
				data = ""
			} else if line.hasPrefix("data:") {
				if !data.isEmpty { data += "\n" }
				data += line.dropFirst(5).drop { $0 == " " }
			} else if line.hasPrefix("event:") {
				type = String(line.dropFirst(6).drop { $0 == " " })
			}
		}
	}

	func urlSession(_ s: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
		let c = code
		DispatchQueue.main.async { self.onEnd?(error, c) }
	}
}

private let iso: ISO8601DateFormatter = {
	let f = ISO8601DateFormatter()
	f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
	return f
}()

private let isoPlain = ISO8601DateFormatter()

private let httpDate: DateFormatter = {
	let f = DateFormatter()
	f.locale = Locale(identifier: "en_US_POSIX")
	f.timeZone = TimeZone(identifier: "GMT")
	f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
	return f
}()

// One paired computer: its stream, cached history, outbox and downloaded
// design. Each runs at once, whichever is on screen.
final class Computer {
	let slot: Int
	let id: String
	let tunnel = Tunnel()
	// Each gets its own address in the WebView, so one computer's page can't read what another's saved.
	var host: String { id }
	var origin: String { "lab://\(host)" }
	private let prefs: UserDefaults
	private let dir: URL
	private let filesCache: URL
	private let thumbsCache: URL

	var events: [J] = []
	private var outbox: [J] = []
	private(set) var link: J = ["kind": "link", "state": "connecting"]
	private(set) var status: J = ["kind": "status", "working": false, "label": ""]
	// The newest event of every kind the server sends without an id, kept across
	// restarts so the page can show them while the computer is away.
	private(set) var live: [String: J] = [:]
	private(set) var lastDone: J?
	// The computer's clock less this phone's, from the stream's Date header, so
	// an event's time can be read on this phone's clock.
	private var skew: TimeInterval = 0

	private var source: EventStream?
	private var failures = 0
	private var designFailures = 0
	private var retry: DispatchWorkItem?
	// Tries for a straight route while on the relay, less and less often.
	private var tryDirect: DispatchWorkItem?
	private var directWait: TimeInterval = Computer.firstDirectTry
	private var suspected = Date.distantPast
	private var flushing = false
	private var syncing = false
	private var started = false
	private var loaded = false
	private var connectWhenLoaded = false
	private var whenLoaded: [() -> Void] = []
	// Taken from events.jsonl on load, so the cursor never runs ahead of what's on disk.
	private var lastId: Int64 = 0
	private var token: String?
	private var saidFull = Date.distantPast

	private static let firstDirectTry: TimeInterval = 5
	private static let lastDirectTry: TimeInterval = 15 * 60

	var state: String { link["state"] as? String ?? "" }
	var mac: J? { live["mac"] }
	var name: String {
		if let n = mac?["name"] as? String, !n.isEmpty { return n }
		return slot == 0 ? "Your computer" : "Computer \(slot + 1)"
	}
	var working: Bool { state == "online" && status["working"] as? Bool == true }
	var waiting: Bool { working && status["label"] as? String == "Waiting for you" }
	// Through the tunnel once it's paired that way, or Tailscale's address otherwise.
	var url: String? { tunnel.spec != nil ? tunnel.base() : prefs.string(forKey: "url") }
	var paired: Bool { (tunnel.spec != nil || prefs.string(forKey: "url") != nil) && token != nil }

	var designVersion: String? {
		get { prefs.string(forKey: "design") }
		set { prefs.set(newValue, forKey: "design") }
	}
	// The newest design that got as far as lab.ready(), the only kind a slow start can't be blamed on.
	var designOpened: String? { prefs.string(forKey: "designOpened") }
	func openedFine() {
		if let v = designVersion, v != designOpened { prefs.set(v, forKey: "designOpened") }
	}

	var designDir: URL { dir.appendingPathComponent("design/current") }
	private var eventsFile: URL { dir.appendingPathComponent("events.jsonl") }
	private var outboxFile: URL { dir.appendingPathComponent("outbox.json") }

	init(slot: Int) {
		self.slot = slot
		id = slot == 0 ? "main" : "c\(slot)"
		prefs = UserDefaults(suiteName: "lab-\(id)")!
		dir = folder(.applicationSupportDirectory, "computers/\(id)")
		filesCache = folder(.cachesDirectory, "files/\(id)")
		thumbsCache = folder(.cachesDirectory, "thumbs/\(id)")
		token = Secrets.get("\(id).token")
		for (k, v) in prefs.dictionaryRepresentation() where k.hasPrefix("live:") {
			if let t = v as? String, let e = parseJSON(t), let kind = e["kind"] as? String { live[kind] = e }
		}
		if let t = Secrets.get("\(id).tunnel"), let j = parseJSON(t) { tunnel.spec = Tunnel.Spec.parse(j) }
		if let r = live["reach"] { reached(r) }
		if let d = try? Data(contentsOf: outboxFile), let a = (try? JSONSerialization.jsonObject(with: d)) as? [J] { outbox = a }
		if !paired { link = unpaired("This phone isn't paired with a computer yet. \(pairAgain)") }
		loadEvents()
	}

	private func unpaired(_ detail: String) -> J { ["kind": "link", "state": "unpaired", "detail": detail] }

	private func later(_ wait: TimeInterval, _ item: DispatchWorkItem) {
		DispatchQueue.main.asyncAfter(deadline: .now() + wait, execute: item)
	}

	// The old route may still work for a moment, so what's under way gets to
	// finish while the stream moves to whichever route answers on this network.
	func networkChanged(moved: Bool) {
		guard paired else { return }
		directWait = Computer.firstDirectTry
		if moved {
			tunnel.retire()
			freshConnections()
		}
		if moved || state != "online" { reconnectNow() }
	}

	// Nothing gets through until a network is back, and Net redials then.
	func networkGone() {
		guard paired else { return }
		retry?.cancel()
		retry = nil
		tryDirect?.cancel()
		source?.cancel()
		source = nil
		tunnel.drop()
		tunnel.stopWaiting()
		setLink("offline", "This phone is offline. It reconnects by itself when it's back online.")
	}

	private func scheduleDirect(_ wait: TimeInterval) {
		tryDirect?.cancel()
		let item = DispatchWorkItem { [weak self] in self?.moveToDirect() }
		tryDirect = item
		later(wait, item)
	}

	// The stream comes back over the new route and picks up where it left off.
	private func moveToDirect() {
		guard state == "online", tunnel.route == "relay", tunnel.direct() else { return }
		DispatchQueue.global().async { [self] in
			let moved = tunnel.upgrade()
			DispatchQueue.main.async { [self] in
				if moved {
					freshConnections()
					connect()
				} else {
					directWait = min(directWait * 2, Computer.lastDirectTry)
					scheduleDirect(directWait)
				}
			}
		}
	}

	// Everything of this computer's goes, on the phone only.
	func wipe() {
		retry?.cancel()
		retry = nil
		tryDirect?.cancel()
		source?.cancel()
		source = nil
		started = false
		tunnel.stopWaiting()
		tunnel.spec = nil
		Notifier.clearAll(self)
		forgetHistory()
		designVersion = nil
		live.removeAll()
		outbox.removeAll()
		saveOutbox()
		status = ["kind": "status", "working": false, "label": ""]
		lastDone = nil
		token = nil
		Secrets.set("\(id).token", nil)
		Secrets.set("\(id).tunnel", nil)
		prefs.removePersistentDomain(forName: "lab-\(id)")
		let fm = FileManager.default
		try? fm.removeItem(at: dir.appendingPathComponent("design"))
		for f in [filesCache, thumbsCache] {
			try? fm.removeItem(at: f)
			try? fm.createDirectory(at: f, withIntermediateDirectories: true)
		}
		link = unpaired("This phone isn't paired with a computer yet. \(pairAgain)")
	}

	// Reading and parsing 2,000 events takes long enough to drop frames, so it
	// happens off the main thread and anything that needs them waits.
	private func loadEvents() {
		io.async { [self] in
			var read: [J] = []
			if let text = try? String(contentsOf: eventsFile, encoding: .utf8) {
				let lines = text.split(separator: "\n").map(String.init)
				read = readHistory(Array(lines.suffix(keep)))
				if lines.count > keep * 2 {
					// Through a copy, so a full disk can't leave the history cut short.
					let body = read.map(jsonString).joined(separator: "\n") + "\n"
					try? body.write(to: eventsFile, atomically: true, encoding: .utf8)
				}
			}
			DispatchQueue.main.async { [self] in
				events.insert(contentsOf: read, at: 0)
				lastId = newestId(read)
				loaded = true
				for r in whenLoaded { r() }
				whenLoaded.removeAll()
				if connectWhenLoaded { connect() }
			}
		}
	}

	func onLoaded(_ r: @escaping () -> Void) {
		if loaded { r() } else { whenLoaded.append(r) }
	}

	// Only the one on screen has a page listening.
	private func emit(_ e: J) {
		if Hub.on === self { Hub.emit(e) }
	}

	func outboxEvent() -> J { ["kind": "outbox", "items": outbox] }

	func start() {
		if started { return }
		started = true
		if paired { connect() }
	}

	// The same computer as this one: its room, key and secret for the tunnel, or its address for Tailscale.
	func pairedWith(_ newUrl: String?, _ spec: Tunnel.Spec?) -> Bool {
		guard paired else { return false }
		if let spec { return tunnel.spec?.same(as: spec) == true }
		guard tunnel.spec == nil, var u = newUrl else { return false }
		while u.hasSuffix("/") { u.removeLast() }
		return u == prefs.string(forKey: "url")
	}

	func pair(_ newUrl: String?, _ spec: Tunnel.Spec?, _ newToken: String) {
		var u = newUrl
		while u?.hasSuffix("/") == true { u?.removeLast() }
		prefs.set(u, forKey: "url")
		Secrets.set("\(id).tunnel", spec.map { jsonString($0.json()) })
		Secrets.set("\(id).token", newToken)
		token = newToken
		tunnel.spec = spec
		// An older reach could otherwise swap the new pairing's relay back for the old one.
		live["reach"] = nil
		prefs.removeObject(forKey: "live:reach")
		reconnectNow()
	}

	private func forgetHistory() {
		events.removeAll()
		let f = eventsFile
		disk.async { try? FileManager.default.removeItem(at: f) }
		lastId = 0
	}

	// A full disk mustn't take the app down. Whatever couldn't be written is
	// still held in memory, the outbox included.
	private func onDisk(_ write: @escaping () throws -> Void) {
		disk.async { [self] in
			do {
				try write()
			} catch {
				DispatchQueue.main.async { [self] in
					if Date().timeIntervalSince(saidFull) < 60 { return }
					saidFull = Date()
					Screen.current?.toast("This phone's storage is full, so The Lab couldn't save. Unsent messages are kept while the app stays open. Free up some space to keep them safe.")
				}
			}
		}
	}

	// An event's time on this phone's clock, or nil if it has none.
	func phoneTime(_ at: Any?) -> Date? {
		guard let s = at as? String, let d = iso.date(from: s) ?? isoPlain.date(from: s) else { return nil }
		return d.addingTimeInterval(-skew)
	}

	private func setLink(_ state: String, _ detail: String = "", fix: String? = nil) {
		var next: J = ["kind": "link", "state": state, "detail": detail]
		if let fix { next["fix"] = fix }
		if jsonString(next) == jsonString(link) { return }
		link = next
		emit(link)
		Hub.changed()
	}

	private func authed(_ path: String, _ base: String) -> URLRequest? {
		guard let url = URL(string: base + path) else { return nil }
		var req = URLRequest(url: url)
		if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
		return req
	}

	private func connect() {
		guard loaded else {
			connectWhenLoaded = true
			return
		}
		source?.cancel()
		guard let base = url, var req = authed("/events", base) else { return onLost(nil, nil) }
		req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
		if lastId > 0 { req.setValue(String(lastId), forHTTPHeaderField: "Last-Event-ID") }
		if state != "online" { setLink("connecting", "Reaching the computer") }
		let s = EventStream()
		s.onOpen = { [weak self, weak s] r in
			guard let self, self.source === s,
				let date = (r.value(forHTTPHeaderField: "Date")).flatMap(httpDate.date(from:))
			else { return }
			self.skew = date.timeIntervalSinceNow
		}
		s.onEvent = { [weak self, weak s] type, data in
			guard let self, self.source === s else { return }
			self.onEvent(type, data)
		}
		s.onEnd = { [weak self, weak s] error, code in
			guard let self, self.source === s else { return }
			self.onLost(error, code)
		}
		source = s
		s.start(req)
	}

	func reconnectNow() {
		retry?.cancel()
		retry = nil
		failures = 0
		// A session that went quiet while the app was frozen would only fail after the read timeout.
		if state != "online", tunnel.spec != nil { tunnel.drop() }
		if paired { connect() }
	}

	private func onEvent(_ type: String?, _ data: String) {
		guard let e = parseJSON(data) else { return }
		if type == "loaded" { return Notifier.onLoaded(self) }
		if type == "hello" {
			// The computer's numbering went back, so every new event would look
			// already seen. Its own copy of the history takes over.
			if let last = (e["last"] as? NSNumber)?.int64Value, last < lastId {
				forgetHistory()
				if Hub.on === self { Hub.onReset?() }
				connect()
				return
			}
			failures = 0
			tunnel.stopWaiting()
			setLink("online", "Connected to the computer")
			tryDirect?.cancel()
			if tunnel.route == "relay" { scheduleDirect(directWait) }
			if let s = e["status"] as? J { setStatus(s) }
			if let m = e["mac"] as? J { setLive(m) }
			if let s = e["shortcuts"] as? [Any] { setLive(["kind": "shortcuts", "items": s]) }
			for l in e["live"] as? [J] ?? [] { setLive(l) }
			if e["design"] as? String != designVersion { syncDesign() }
			registerPush()
			flush()
			return
		}
		let kind = e["kind"] as? String ?? ""
		switch kind {
		case "status": setStatus(e)
		case "design": if e["version"] as? String != designVersion { syncDesign() }
		default:
			if e["id"] != nil { store(e) } else if !kind.isEmpty { setLive(e) }
		}
	}

	private func reached(_ e: J) {
		if let a = e["lan"] as? [String] {
			// The address he paired on goes last, as it worked once even if the computer can't see it.
			var seen = Set<String>()
			tunnel.lan = (a.filter { !$0.isEmpty } + (tunnel.spec?.lan ?? [])).filter { seen.insert($0).inserted }
			// The computer can have just come onto this Wi-Fi.
			if tunnel.route == "relay" {
				directWait = Computer.firstDirectTry
				scheduleDirect(directWait)
			}
		}
		// A relay set up after pairing, so the phone can reach the computer away from home without pairing again.
		guard let relay = e["relay"] as? String, !relay.isEmpty, relay != "null",
			let sp = tunnel.spec, relay != sp.relay, let next = sp.withRelay(relay)
		else { return }
		let lan = tunnel.lan
		tunnel.spec = next
		tunnel.lan = lan
		Secrets.set("\(id).tunnel", jsonString(next.json()))
	}

	private func setLive(_ e: J) {
		guard let kind = e["kind"] as? String else { return }
		if kind == "reach" { reached(e) }
		live[kind] = e
		prefs.set(jsonString(e), forKey: "live:\(kind)")
		emit(e)
		if kind == "mac" { Hub.emit(Hub.computersEvent()) }
	}

	private func setStatus(_ s: J) {
		status = s
		status["kind"] = "status"
		emit(status)
		Hub.changed()
	}

	private func store(_ e: J) {
		guard let id = (e["id"] as? NSNumber)?.int64Value, id > lastId else { return }
		lastId = id
		events.append(e)
		if e["kind"] as? String == "done" { lastDone = e }
		if events.count > keep * 12 / 10 { events.removeFirst(events.count - keep) }
		let line = Data((jsonString(e) + "\n").utf8)
		let f = eventsFile
		onDisk {
			if let h = try? FileHandle(forWritingTo: f) {
				defer { try? h.close() }
				try h.seekToEnd()
				try h.write(contentsOf: line)
			} else {
				try line.write(to: f)
			}
		}
		emit(e)
		Notifier.onEvent(self, e)
	}

	private func onLost(_ error: Error?, _ code: Int?) {
		source = nil
		tryDirect?.cancel()
		let wasUp = state == "online"
		if code == nil, tunnel.spec != nil { tunnel.drop() }
		let online = Net.shared.online
		if code == 401 {
			setLink("unpaired", "The computer doesn't recognise this phone any more. \(pairAgain)")
			return
		}
		if !online {
			setLink("offline", "This phone is offline. It reconnects by itself when it's back online.")
		} else if wasUp, code == nil {
			// It usually finds another route in a moment, which isn't worth alarming him over.
			setLink("connecting", "Reconnecting")
		} else if tunnel.spec != nil {
			switch tunnel.why {
			case "away": setLink("offline", "The computer isn't connected right now. It may be asleep, switched off or offline.")
			case "relay": setLink("offline", "Can't reach the computer from here right now. It still works when this phone is on the same Wi-Fi as the computer.")
			case "key": setLink("offline", "The Lab couldn't confirm it was talking to your computer, so it didn't connect. If this keeps happening, pair the phone again with a new code.")
			case "none": setLink("offline", "Can't find the computer on this network. For now it only works when this phone is on the same Wi-Fi as the computer.")
			default: setLink("offline", "Can't reach the computer. It may be asleep, switched off or offline.")
			}
		} else if let c = code, (502...504).contains(c) {
			setLink("offline", "The computer is on, but The Lab's server isn't answering. It restarts itself, so give it a minute.")
		} else {
			setLink("offline", "Can't reach the computer. Check Tailscale is connected on this phone.", fix: "tailscale")
		}
		failures += 1
		// With no network, or no relay and the phone off the Wi-Fi, nothing can
		// get through until the network changes, and Net redials then.
		if !online || (tunnel.spec != nil && tunnel.spec?.relay == nil && !tunnel.direct()) { return }
		if tunnel.why == "away" {
			tunnel.await { [weak self] in
				DispatchQueue.main.async { self?.comeBack() }
			}
		}
		let wait = backoff(failures: failures, waiting: tunnel.isWaiting)
		let item = DispatchWorkItem { [weak self] in
			self?.retry = nil
			self?.connect()
		}
		retry = item
		later(wait, item)
		labLog("link lost (\(code.map(String.init) ?? "\(error.map { "\($0)" } ?? "closed")")), retry in \(wait)s")
	}

	// The relay said the computer just connected, so there's no waiting out the retry.
	private func comeBack() {
		guard paired, state != "online" else { return }
		retry?.cancel()
		retry = nil
		connect()
	}

	// A request that couldn't get through says the link is probably dead, and
	// the stream alone can take a minute to notice.
	private func suspect() {
		guard state == "online", Date().timeIntervalSince(suspected) >= 10 else { return }
		suspected = Date()
		tunnel.drop()
		reconnectNow()
	}

	// His words go to disk before anything else happens to them.
	func send(_ text: String, cid: String, files: [Any]?) {
		var m: J = ["cid": cid, "text": text, "at": iso.string(from: Date())]
		if let files, !files.isEmpty { m["files"] = files }
		outbox.append(m)
		saveOutbox()
		emit(outboxEvent())
		flush()
	}

	private func saveOutbox() {
		let d = jsonData(outbox)
		let f = outboxFile
		onDisk { try d.write(to: f, options: .atomic) }
	}

	private func flush() {
		guard !flushing, let m = outbox.first, state == "online" else { return }
		flushing = true
		var body: J = ["text": m["text"] ?? "", "cid": m["cid"] ?? ""]
		if let f = m["files"] { body["files"] = f }
		post("/send", body) { [self] code in
			flushing = false
			// The server drops a repeat cid, so a retry after a lost response is safe.
			let outcome = sendOutcome(code)
			if outcome == .retry {
				DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [self] in flush() }
				return
			}
			let head = (outbox.first?["cid"] as? String) == (m["cid"] as? String)
			if head { outbox.removeFirst() }
			saveOutbox()
			emit(outboxEvent())
			if head, outcome == .refused { refused(m) }
			if outbox.isEmpty { Notifier.sent(self) }
			flush()
		}
	}

	// The words go back to him, in the message box if the page is open and in a notification if not.
	private func refused(_ m: J) {
		let text = m["text"] as? String ?? ""
		emit(sendFailed(m["cid"] as? String ?? "", text, "The computer couldn't take that message. It's back in the message box so you can try again."))
		if !Hub.foreground || Hub.on !== self { Notifier.unsent(self, text) }
	}

	func sendFailed(_ cid: String, _ text: String, _ error: String) -> J {
		["kind": "sendFailed", "cid": cid, "text": text, "error": error]
	}

	func queued(_ cid: String) -> Bool { outbox.contains { $0["cid"] as? String == cid } }

	// done gets false only when the computer never heard it. A slow stop says
	// nothing about the link, so it never drops the tunnel.
	func stop(_ done: @escaping (Bool) -> Void = { _ in }) {
		post("/stop", [:], via: stopping, suspicious: false) { done((200...299).contains($0)) }
	}

	// done gets the status, and a 404 means it was already answered or has expired.
	func answer(_ ref: String, allow: Bool, always: Bool = false, _ done: @escaping (Int) -> Void = { _ in }) {
		post("/answer", ["ref": ref, "allow": allow, "always": always], via: quick, done: done)
	}

	// Any JSON route on the computer, for the page's memory, schedules and setup
	// sheets. done gets the body, or nil and an error in plain words.
	func request(_ method: String, _ path: String, _ body: String?, _ done: @escaping (String?, String?) -> Void) {
		if url == nil { return done(nil, "This phone isn't paired with a computer yet.") }
		if !path.hasPrefix("/") || path.contains("..") { return done(nil, "That isn't a route on the computer.") }
		fetch(method, path, body, via: path == "/models" || path == "/check" ? slow : quick) { code, text in
			if code == 0 { return done(nil, "Couldn't reach the computer. Try again once it's back.") }
			if (200...299).contains(code) { return done(text, nil) }
			done(nil, text.flatMap(parseJSON)?["error"] as? String ?? "The computer couldn't do that just now. Try again in a minute.")
		}
	}

	// The question behind an Allow card, for <lab-ask>.
	func askInfo(_ ref: String, _ done: @escaping (Int, String?) -> Void) {
		fetch("GET", "/asks/\(ref.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? ref)", nil, via: quick, done)
	}

	// done gets the status, or 0 and nil when the computer couldn't be reached.
	private func fetch(_ method: String, _ path: String, _ body: String?, via: URLSession, _ done: @escaping (Int, String?) -> Void) {
		guard let base = url, var req = authed(path, base) else { return done(0, nil) }
		req.httpMethod = method
		if method != "GET" {
			req.setValue("application/json", forHTTPHeaderField: "Content-Type")
			req.httpBody = Data((body ?? "{}").utf8)
		}
		via.dataTask(with: req) { [self] data, response, error in
			let code = (response as? HTTPURLResponse)?.statusCode ?? 0
			let text = data.map { String(decoding: $0, as: UTF8.self) }
			DispatchQueue.main.async { [self] in
				if error != nil || response == nil {
					suspect()
					return done(0, nil)
				}
				done(code, text)
			}
		}.resume()
	}

	func undoDesign(_ done: @escaping (Bool) -> Void) { post("/design/undo", [:]) { done($0 == 200) } }

	// Only for the version that's on the phone, so a report can't undo a newer one.
	func reportBroken(_ message: String) {
		guard let v = designVersion else { return }
		post("/app-error", ["message": message, "where": "opening the app", "version": v, "fatal": true]) { _ in }
	}

	func reportError(_ message: String, _ whereAt: String) {
		guard let v = designVersion else { return }
		post("/app-error", ["message": message, "where": whereAt, "version": v]) { _ in }
	}

	func saveShortcuts(_ items: [Any], _ done: @escaping (Bool) -> Void) {
		post("/shortcuts", ["items": items]) { done($0 == 200) }
	}

	// So the computer can reach this phone while The Lab is shut. Nothing happens
	// on a computer with no Apple key, and a build without push never has a token.
	func registerPush() {
		guard let t = Hub.pushToken, state == "online", prefs.string(forKey: "pushed") != t else { return }
		post("/push/register", ["token": t, "env": Notifier.pushEnvironment], suspicious: false) { [self] code in
			if code == 200 { prefs.set(t, forKey: "pushed") }
		}
	}

	private func post(_ path: String, _ body: J, via: URLSession = client, suspicious: Bool = true, done: @escaping (Int) -> Void) {
		guard let base = url, var req = authed(path, base) else { return done(-1) }
		req.httpMethod = "POST"
		req.setValue("application/json", forHTTPHeaderField: "Content-Type")
		req.httpBody = jsonData(body)
		via.dataTask(with: req) { [self] _, response, error in
			let code = (response as? HTTPURLResponse)?.statusCode
			DispatchQueue.main.async { [self] in
				guard error == nil, let code else {
					if suspicious { suspect() }
					return done(-1)
				}
				done(code)
			}
		}.resume()
	}

	// Blocking, off the main thread.
	private func wait(_ req: URLRequest, _ make: (URLRequest, @escaping (Data?, URLResponse?, Error?) -> Void) -> URLSessionTask) -> (Int, Data?, Error?) {
		let done = DispatchSemaphore(value: 0)
		var out: (Int, Data?, Error?) = (0, nil, nil)
		make(req) { d, r, e in
			out = ((r as? HTTPURLResponse)?.statusCode ?? 0, d, e)
			done.signal()
		}.resume()
		done.wait()
		return out
	}

	// Blocking. Copies the pick into the file cache first, so the page can show
	// it straight away without fetching it back from the computer.
	func upload(_ file: URL, name: String) throws -> J {
		let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
		if size > 100 * 1024 * 1024 { throw Trouble("\(name) is over the 100 MB limit.") }
		guard let base = url else { throw Trouble("This phone isn't paired with a computer yet.") }
		let q = name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "file"
		guard var req = authed("/upload?name=\(q)", base) else { throw Trouble("That file's name can't be sent.") }
		req.httpMethod = "POST"
		req.setValue(mime(name), forHTTPHeaderField: "Content-Type")
		func attempt() -> (Int, Data?, Error?) {
			wait(req) { r, done in client.uploadTask(with: r, fromFile: file, completionHandler: done) }
		}
		// A second go after a drop, on whatever link the first failure brought up.
		var r = attempt()
		if r.2 != nil {
			DispatchQueue.main.async { [self] in suspect() }
			Thread.sleep(forTimeInterval: 3)
			r = attempt()
			if r.2 != nil { throw Trouble("Couldn't reach the computer, so \(name) wasn't attached.") }
		}
		let j = r.1.flatMap { parseJSON(String(decoding: $0, as: UTF8.self)) }
		if r.0 != 200 { throw Trouble(j?["error"] as? String ?? "The computer didn't take \(name). Try again in a minute.") }
		guard let j else { throw Trouble("The computer didn't take \(name). Try again in a minute.") }
		if let u = j["url"] as? String, let clean = plainName((u.hasPrefix("/files/") ? String(u.dropFirst(7)) : u).removingPercentEncoding ?? "") {
			try? FileManager.default.copyItem(at: file, to: filesCache.appendingPathComponent(clean))
		}
		return j
	}

	// Pulls the whole app folder and swaps it in, so the page never sees a
	// half-written design.
	private func syncDesign() {
		guard !syncing, let base = url, let req = authed("/design", base) else { return }
		syncing = true
		io.async { [self] in
			let version = pullDesign(req)
			DispatchQueue.main.async { [self] in
				syncing = false
				if let version {
					designFailures = 0
					designVersion = version
					if Hub.on === self { Hub.onDesign?() }
				} else if state == "online" {
					// Otherwise a failed download waits for the next reconnect, with the safe screen up meanwhile.
					let wait = min(30.0 * pow(2, Double(min(designFailures, 5))), 600)
					designFailures += 1
					DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [self] in
						if state == "online" { syncDesign() }
					}
				}
			}
		}
	}

	private func pullDesign(_ req: URLRequest) -> String? {
		let fm = FileManager.default
		let r = wait(req) { q, done in client.dataTask(with: q, completionHandler: done) }
		guard r.0 == 200, let d = r.1, let body = parseJSON(String(decoding: d, as: UTF8.self)),
			let files = body["files"] as? [String: String], let version = body["version"] as? String
		else { return nil }
		let root = dir.appendingPathComponent("design")
		let next = root.appendingPathComponent("next")
		let current = root.appendingPathComponent("current")
		let old = root.appendingPathComponent("old")
		do {
			try? fm.removeItem(at: next)
			try fm.createDirectory(at: next, withIntermediateDirectories: true)
			let inside = next.standardizedFileURL.path + "/"
			for (name, b64) in files {
				let out = next.appendingPathComponent(name).standardizedFileURL
				guard out.path.hasPrefix(inside), let bytes = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
				try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
				try bytes.write(to: out)
			}
			try? fm.removeItem(at: old)
			if fm.fileExists(atPath: current.path) { try fm.moveItem(at: current, to: old) }
			try fm.moveItem(at: next, to: current)
			try? fm.removeItem(at: old)
			return version
		} catch {
			labLog("design sync failed: \(error)")
			return nil
		}
	}

	// Blocking, for the page's file requests and for opening files.
	func fetchFile(_ name: String) -> URL? {
		guard let clean = plainName(name) else { return nil }
		let out = filesCache.appendingPathComponent(clean)
		if FileManager.default.fileExists(atPath: out.path) { return out }
		let encoded = clean.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? clean
		guard let base = url, let req = authed("/files/\(encoded)", base) else { return nil }
		let r = wait(req) { q, done in client.dataTask(with: q, completionHandler: done) }
		guard r.0 == 200, let d = r.1 else { return nil }
		guard (try? d.write(to: out, options: .atomic)) != nil else { return nil }
		return out
	}

	// Blocking. A copy of an image whose short side is at least w pixels, so a
	// thread of photos doesn't decode every 12-megapixel original at full size.
	func thumb(_ name: String, w: Int) -> URL? {
		guard let src = fetchFile(name) else { return nil }
		if src.pathExtension.lowercased() == "gif" { return src }
		let out = thumbsCache.appendingPathComponent("\(w)-\(src.lastPathComponent).jpg")
		if FileManager.default.fileExists(atPath: out.path) { return out }
		guard let s = CGImageSourceCreateWithURL(src as CFURL, nil),
			let info = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
			let pw = info[kCGImagePropertyPixelWidth] as? Int, let ph = info[kCGImagePropertyPixelHeight] as? Int,
			Double(min(pw, ph)) > Double(w) * 1.5
		else { return src }
		// Its limit is on the long side, and the EXIF turn is applied.
		let long = Double(max(pw, ph)) * Double(w) / Double(min(pw, ph))
		let opts: [CFString: Any] = [
			kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
			kCGImageSourceThumbnailMaxPixelSize: Int(long),
		]
		guard let img = CGImageSourceCreateThumbnailAtIndex(s, 0, opts as CFDictionary),
			img.alphaInfo == .none || img.alphaInfo == .noneSkipLast || img.alphaInfo == .noneSkipFirst,
			let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
		else { return src }
		CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
		return CGImageDestinationFinalize(dest) ? out : src
	}
}

struct Trouble: Error {
	let text: String
	init(_ t: String) { text = t }
}

func mime(_ name: String) -> String {
	let ext = (name as NSString).pathExtension.lowercased()
	switch ext {
	case "js", "mjs": return "text/javascript"
	case "woff2": return "font/woff2"
	case "html": return "text/html"
	case "css": return "text/css"
	default: return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
	}
}
