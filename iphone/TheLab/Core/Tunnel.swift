import CryptoKit
import Foundation
import Network

// The phone's end of computer/tunnel.ts, and it has to stay in step with it and
// with phone/.../Tunnel.kt. URLSession talks plain HTTP to a port on this
// phone's loopback, and each connection to that port is carried, sealed, to the
// computer: straight over the local network when one of its addresses answers,
// through the relay otherwise. Nothing outside this phone and the computer can
// read it.
//
// It finds the computer from its saved addresses only. Asking the whole Wi-Fi
// by broadcast, as Android does, needs a multicast entitlement Apple has to
// grant, and the addresses the computer sends cover a router's new one.
final class Tunnel {
	final class Spec {
		let relay: String?
		let room: String
		let key: Data
		let pass: Data
		let lan: [String]

		init(relay: String?, room: String, key: Data, pass: Data, lan: [String]) {
			self.relay = relay
			self.room = room
			self.key = key
			self.pass = pass
			self.lan = lan
		}

		func json() -> J {
			["relay": relay ?? NSNull(), "room": room, "key": b64(key), "pass": b64(pass), "lan": lan]
		}

		func withRelay(_ next: String) -> Spec? {
			var j = json()
			j["relay"] = next
			return Spec.parse(j)
		}

		func same(as o: Spec) -> Bool { room == o.room && key == o.key && pass == o.pass }

		static func parse(_ j: J) -> Spec? {
			guard let room = j["room"] as? String,
				let key = unb64(j["key"] as? String ?? ""), key.count == 65,
				let pass = unb64(j["pass"] as? String ?? ""), pass.count == 32
			else { return nil }
			let raw = (j["relay"] as? String) ?? ""
			let relay = raw.isEmpty || raw == "null" ? nil : raw
			if let r = relay, !goodRelay(r) { return nil }
			let lan = (j["lan"] as? [String]) ?? []
			guard lan.allSatisfy(goodAddress) else { return nil }
			return Spec(relay: relay, room: room, key: key, pass: pass, lan: lan)
		}
	}

	private final class Locked<T> {
		private let lock = NSLock()
		private var stored: T
		init(_ v: T) { stored = v }
		var value: T {
			get { lock.lock(); defer { lock.unlock() }; return stored }
			set { lock.lock(); defer { lock.unlock() }; stored = newValue }
		}
	}

	// Why the last attempt failed, for the link line: "away" (the computer
	// isn't on the relay), "relay" (the relay can't be reached), "key" (the
	// answer didn't come from the paired computer) or "none" (no route at all).
	private let whyNow = Locked("")
	var why: String { whyNow.value }
	private let routeNow = Locked<String?>(nil)
	var route: String? { routeNow.value }
	private let specNow = Locked<Spec?>(nil)
	var spec: Spec? {
		get { specNow.value }
		set {
			specNow.value = newValue
			lan = []
			oldRelay.value = false
			drop()
		}
	}
	// The newest addresses the computer sent, ahead of the ones from pairing.
	private let lanNow = Locked<[String]>([])
	var lan: [String] {
		get { lanNow.value }
		set { lanNow.value = newValue }
	}
	// A test on a Mac has no phone network to ask.
	var direct: () -> Bool = { Net.shared.local }

	// Making a session can take 10 seconds, so it has its own lock, and the
	// main thread only ever takes the quick one for the port.
	private let dialing = NSRecursiveLock()
	private let lock = NSLock()
	private var server: Listener?
	private let session = Locked<Session?>(nil)
	// Requests that queue up behind a dial that failed get its answer for a
	// couple of seconds, rather than each dialing again in turn.
	private let failed = Locked<(at: Date, error: Error)?>(nil)
	private var waiting: URLSessionWebSocketTask?
	// A relay from before the waiting socket says "away" and closes it.
	private let oldRelay = Locked(false)
	var isWaiting: Bool { lock.lock(); defer { lock.unlock() }; return waiting != nil }

	func base() -> String? {
		lock.lock()
		defer { lock.unlock() }
		if let s = server, s.open { return "http://127.0.0.1:\(s.port)" }
		guard let s = Listener(backlog: 50, onAccept: { [weak self] sock in
			Thread.detachNewThread { self?.carry(sock) ?? sock.close() }
		}) else { return nil }
		server = s
		return "http://127.0.0.1:\(s.port)"
	}

	// A suspended app's listening socket can be dead without saying so, so the
	// next base() opens a new one.
	func freshPort() {
		lock.lock()
		defer { lock.unlock() }
		server?.close()
		server = nil
	}

	// One request to a computer that isn't paired yet, over its own session,
	// so a claim that fails never reaches the computer that is.
	func once(_ sp: Spec) -> String? {
		var me: Listener?
		let holder = Locked<Listener?>(nil)
		me = Listener(backlog: 1) { sock in
			holder.value?.close()
			Thread.detachNewThread {
				do {
					let (s, _) = try self.open(sp, sp.lan)
					s.carry(sock)
					s.dead()
				} catch {
					sock.close()
				}
			}
		}
		holder.value = me
		guard let l = me else { return nil }
		DispatchQueue.global().asyncAfter(deadline: .now() + 30) { l.close() }
		return "http://127.0.0.1:\(l.port)"
	}

	// Ends the session, so the next connection picks its route again.
	func drop() {
		let old = session.value
		session.value = nil
		routeNow.value = nil
		failed.value = nil
		old?.dead()
	}

	// For a new network, when the old route may be fine for a little longer.
	// New connections pick a route again, and whatever is under way, like an
	// upload, gets to finish if it can rather than failing at once.
	func retire() {
		let old = session.value
		session.value = nil
		routeNow.value = nil
		failed.value = nil
		old?.retire()
	}

	// Held open on the relay while the computer is away. The relay says "here"
	// the moment the computer connects, so the phone doesn't sit out its next
	// retry.
	func await(_ onBack: @escaping () -> Void) {
		guard let sp = spec, let relay = sp.relay, let url = URL(string: "\(wsUrl(relay))/r/\(sp.room)?wait=1") else { return }
		lock.lock()
		defer { lock.unlock() }
		if waiting != nil || oldRelay.value { return }
		let task = Tunnel.ws.webSocketTask(with: url)
		waiting = task
		task.resume()
		func gone() {
			lock.lock()
			if waiting === task { waiting = nil }
			lock.unlock()
			task.cancel()
		}
		func listen() {
			task.receive { [weak self] r in
				guard let self else { return }
				switch r {
				case .failure:
					gone()
				case .success(.string("away")):
					self.oldRelay.value = true
					gone()
				case .success(.string("here")):
					gone()
					if self.spec === sp { onBack() }
				case .success:
					listen()
				}
			}
		}
		listen()
		// Its pings keep a mobile network from forgetting it and notice when it's gone.
		func ping() {
			DispatchQueue.global().asyncAfter(deadline: .now() + 240) { [weak self] in
				guard let self, self.isWaiting else { return }
				task.sendPing { e in
					if e == nil { ping() } else { gone() }
				}
			}
		}
		ping()
	}

	func stopWaiting() {
		lock.lock()
		defer { lock.unlock() }
		waiting?.cancel()
		waiting = nil
	}

	private func wsUrl(_ relay: String) -> String {
		var r = relay
		while r.hasSuffix("/") { r.removeLast() }
		return r.hasPrefix("http") ? "ws" + r.dropFirst(4) : r
	}

	private func carry(_ sock: Sock) {
		do {
			try current().carry(sock)
		} catch {
			sock.close()
		}
	}

	private func current() throws -> Session {
		dialing.lock()
		defer { dialing.unlock() }
		guard let sp = spec else { throw Failure.other("not paired") }
		if let s = session.value, s.alive, s.spec === sp { return s }
		if let f = failed.value, Date().timeIntervalSince(f.at) < 2 { throw f.error }
		let opened: (Session, String)
		do {
			let saved = lan
			opened = try open(sp, saved.isEmpty ? sp.lan : saved)
		} catch {
			switch error {
			case Failure.away: whyNow.value = "away"
			case Failure.wrongKey: whyNow.value = "key"
			case Failure.noRoute: whyNow.value = "none"
			default: whyNow.value = "relay"
			}
			failed.value = (Date(), error)
			throw error
		}
		// He paired again while this was dialing, so it's for the old computer.
		if spec !== sp {
			opened.0.dead()
			throw Failure.other("the pairing changed while connecting")
		}
		session.value?.dead()
		session.value = opened.0
		routeNow.value = opened.1
		whyNow.value = ""
		labLog("tunnel: \(opened.1)")
		return opened.0
	}

	// Direct gets a head start and then the relay joins in, so a Wi-Fi the
	// computer isn't on costs a moment rather than every address timing out. A
	// wrong key on either means the paired computer wasn't the one that answered.
	private func open(_ sp: Spec, _ addresses: [String]) throws -> (Session, String) {
		if !direct() { return try throughRelay(sp) }
		let done = Queue<Result<(Session, String), Error>>()
		let guardLock = NSLock()
		var taken = false
		func race(_ dial: @escaping () throws -> (Session, String)) {
			Thread.detachNewThread {
				let r = Result { try dial() }
				guardLock.lock()
				let late = taken
				if !late { done.put(r) }
				guardLock.unlock()
				// The other route won, so nothing will ever use this one.
				if late, case let .success(s) = r { s.0.dead() }
			}
		}
		func leftovers() {
			guardLock.lock()
			taken = true
			guardLock.unlock()
			while let r = done.poll(ms: 0) {
				if case let .success(s) = r { s.0.dead() }
			}
		}
		race { try self.straight(sp, addresses) }
		var racing = 1
		var relayIn = sp.relay == nil
		var errors: [Error] = []
		while true {
			let r = done.poll(ms: relayIn ? 30_000 : Tunnel.headStart)
			if r == nil, relayIn {
				leftovers()
				throw Failure.other("no route answered")
			}
			if let r {
				switch r {
				case let .success(s):
					leftovers()
					return s
				case let .failure(e):
					errors.append(e)
				}
				racing -= 1
			}
			if !relayIn {
				relayIn = true
				racing += 1
				race { try self.throughRelay(sp) }
			} else if racing == 0 {
				throw worst(errors)
			}
		}
	}

	private func worst(_ errors: [Error]) -> Error {
		func has(_ f: Failure) -> Bool {
			errors.contains { ($0 as? Failure)?.same(as: f) == true }
		}
		if has(.away) { return Failure.away }
		if has(.wrongKey) { return Failure.wrongKey }
		return errors.first { ($0 as? Failure)?.same(as: .noRoute) != true } ?? Failure.noRoute
	}

	private func throughRelay(_ sp: Spec) throws -> (Session, String) {
		guard let relay = sp.relay, let url = URL(string: "\(wsUrl(relay))/r/\(sp.room)") else { throw Failure.noRoute }
		return (try Session.start(WsLink(url), sp, ms: 10_000), "relay")
	}

	private func straight(_ sp: Spec, _ addresses: [String]) throws -> (Session, String) {
		var wrongKey = false
		for a in addresses.prefix(4) {
			do {
				return (try Session.start(try TcpLink(a), sp, ms: 2000), "direct")
			} catch Failure.wrongKey {
				wrongKey = true
				labLog("tunnel: \(a) answered with the wrong key")
			} catch {
				labLog("tunnel: \(a) didn't answer (\(error))")
			}
		}
		throw wrongKey ? Failure.wrongKey : Failure.noRoute
	}

	// Moves off the relay when the computer has become reachable straight over
	// this network, which needs no change of network to happen. Blocking.
	func upgrade() -> Bool {
		guard let sp = spec, route == "relay", direct() else { return false }
		let saved = lan
		guard let s = try? straight(sp, saved.isEmpty ? sp.lan : saved).0 else { return false }
		dialing.lock()
		defer { dialing.unlock() }
		if spec !== sp {
			s.dead()
			return false
		}
		let old = session.value
		session.value = s
		routeNow.value = "direct"
		failed.value = nil
		old?.retire()
		labLog("tunnel: moved to direct")
		return true
	}

	enum Failure: Error {
		case away, wrongKey, noRoute
		case other(String)

		func same(as o: Failure) -> Bool {
			switch (self, o) {
			case (.away, .away), (.wrongKey, .wrongKey), (.noRoute, .noRoute): return true
			default: return false
			}
		}
	}

	static let headStart = 1200
	private static let hello: UInt8 = 1
	private static let welcome: UInt8 = 2
	private static let tOpen: UInt8 = 1
	private static let tData: UInt8 = 2
	private static let tEnd: UInt8 = 3
	private static let tAck: UInt8 = 4
	private static let chunk = 32 * 1024
	private static let window: Int64 = 1024 * 1024
	private static let ackEvery = 64 * 1024
	private static let maxPacket = 256 * 1024
	private static let retireAfter: TimeInterval = 60
	private static let label = Data("the lab tunnel 1".utf8)
	// No pings of its own. The event stream's ping crosses this socket every 25 s,
	// and Hub drops the session once that goes quiet.
	private static let ws: URLSession = {
		let c = URLSessionConfiguration.ephemeral
		// The dial has its own limit, and this one also applies to a socket's silence.
		c.timeoutIntervalForRequest = 86400
		c.timeoutIntervalForResource = 86400 * 365
		return URLSession(configuration: c)
	}()

	private final class Box {
		private let key: SymmetricKey
		private var n: UInt64 = 0
		init(_ k: Data) { key = SymmetricKey(data: k) }

		private func nonce() throws -> AES.GCM.Nonce {
			var iv = Data(count: 4)
			withUnsafeBytes(of: n.bigEndian) { iv.append(contentsOf: $0) }
			n += 1
			return try AES.GCM.Nonce(data: iv)
		}

		func seal(_ pt: Data) throws -> Data {
			let s = try AES.GCM.seal(pt, using: key, nonce: try nonce())
			return s.ciphertext + s.tag
		}

		func open(_ ct: Data) throws -> Data {
			guard ct.count >= 16 else { throw Failure.wrongKey }
			let all = Data(ct)
			let box = try AES.GCM.SealedBox(nonce: try nonce(), ciphertext: all.prefix(all.count - 16), tag: all.suffix(16))
			return try AES.GCM.open(box, using: key)
		}
	}

	// One link carries one session. Anything that arrives before the session
	// takes over waits in a queue for the handshake.
	private class Link {
		private let early = Queue<Any>()
		private let taker = Locked<Session?>(nil)
		func take(over s: Session) { taker.value = s }
		final func got(_ b: Data) {
			if let s = taker.value { s.take(b) } else { early.put(b) }
		}
		final func lost(_ why: String) {
			if let s = taker.value { s.dead() } else { early.put(why) }
		}
		func first(ms: Int) throws -> Data {
			switch early.poll(ms: ms) {
			case let b as Data: return b
			case let w as String where w == "away": throw Failure.away
			case let w as String: throw Failure.other(w)
			default: throw Failure.other("no answer")
			}
		}
		func send(_ b: Data) throws { fatalError("a link has to send") }
		func close() {}
	}

	private final class TcpLink: Link {
		private let sock: Sock

		init(_ address: String) throws {
			guard let colon = address.lastIndex(of: ":"), let port = UInt16(address[address.index(after: colon)...]) else {
				throw Failure.other("bad address \(address)")
			}
			sock = try Sock.connect(host: String(address[..<colon]), port: port, ms: 600)
			super.init()
			Thread.detachNewThread { [self] in
				do {
					while true {
						let head = try sock.readFully(4)
						let n = head.reduce(0) { $0 << 8 | Int($1) }
						if n < 0 || n > Tunnel.maxPacket { throw Failure.other("frame of \(n) bytes") }
						got(try sock.readFully(n))
					}
				} catch {
					lost("closed")
				}
			}
		}

		override func send(_ b: Data) throws {
			var n = UInt32(b.count).bigEndian
			var out = Data(bytes: &n, count: 4)
			out.append(b)
			try sock.write(out)
		}

		override func close() { sock.close() }
	}

	private final class WsLink: Link {
		private let task: URLSessionWebSocketTask
		private let open = Locked(true)

		init(_ url: URL) {
			task = Tunnel.ws.webSocketTask(with: url)
			task.maximumMessageSize = 4 * 1024 * 1024
			super.init()
			task.resume()
			pump()
		}

		private func pump() {
			task.receive { [self] r in
				switch r {
				case let .success(.data(d)):
					got(d)
					pump()
				case .success(.string("away")):
					lost("away")
					pump()
				case .success:
					pump()
				case let .failure(e):
					open.value = false
					lost(e.localizedDescription)
				}
			}
		}

		// Waits for each send, so a big upload goes at the speed of the socket.
		override func send(_ b: Data) throws {
			guard open.value else { throw Failure.other("relay link closed") }
			let sent = DispatchSemaphore(value: 0)
			let failure = Locked<Error?>(nil)
			task.send(.data(b)) { e in
				failure.value = e
				sent.signal()
			}
			if sent.wait(timeout: .now() + 30) == .timedOut { throw Failure.other("relay link stalled") }
			if let e = failure.value {
				open.value = false
				throw e
			}
		}

		override func close() {
			open.value = false
			task.cancel(with: .goingAway, reason: nil)
		}
	}

	// What the computer sent waits in inbox for the stream's own writer, so a
	// caller that stops reading holds up only its own stream. The peer's window
	// keeps inbox under a megabyte.
	private final class Stream {
		let sock: Sock
		let gate = NSCondition()
		var unacked: Int64 = 0
		// Nil marks the end.
		let inbox = Queue<Data?>()
		init(_ s: Sock) { sock = s }
	}

	private final class Session {
		private let link: Link
		let spec: Spec
		private let out: Box
		let inn: Box
		private let lock = NSLock()
		private let sending = NSLock()
		private var streams: [UInt32: Stream] = [:]
		private var next: UInt32 = 1
		private var isAlive = true

		init(_ link: Link, _ spec: Spec, p2c: Data, c2p: Data) {
			self.link = link
			self.spec = spec
			out = Box(p2c)
			inn = Box(c2p)
		}

		var alive: Bool { lock.lock(); defer { lock.unlock() }; return isAlive }
		private func stream(_ id: UInt32) -> Stream? { lock.lock(); defer { lock.unlock() }; return streams[id] }
		private var busy: Bool { lock.lock(); defer { lock.unlock() }; return !streams.isEmpty }

		func carry(_ sock: Sock) {
			lock.lock()
			let id = next
			next += 2
			let st = Stream(sock)
			streams[id] = st
			lock.unlock()
			// Acks go out once the bytes are written, so they also pace the computer.
			Thread.detachNewThread { [self] in
				var pending = 0
				var tell = false
				do {
					while let b = st.inbox.take() {
						try sock.write(b)
						pending += b.count
						if pending >= Tunnel.ackEvery {
							var n = UInt32(pending).bigEndian
							try send(id, Tunnel.tAck, Data(bytes: &n, count: 4))
							pending = 0
						}
					}
				} catch {
					tell = true
				}
				finish(id, tell)
			}
			do {
				try send(id, Tunnel.tOpen)
				var buf = [UInt8](repeating: 0, count: Tunnel.chunk)
				while alive {
					let n = sock.read(&buf)
					if n <= 0 { break }
					st.gate.lock()
					while st.unacked > Tunnel.window, alive, stream(id) === st {
						st.gate.wait(until: Date().addingTimeInterval(1))
					}
					st.unacked += Int64(n)
					st.gate.unlock()
					if stream(id) !== st { break }
					try send(id, Tunnel.tData, Data(buf[0..<n]))
				}
			} catch {}
			finish(id, true)
		}

		private func finish(_ id: UInt32, _ tell: Bool) {
			lock.lock()
			let st = streams.removeValue(forKey: id)
			lock.unlock()
			guard let st else { return }
			if tell, alive { try? send(id, Tunnel.tEnd) }
			st.sock.close()
			st.inbox.put(nil)
			st.gate.lock()
			st.gate.broadcast()
			st.gate.unlock()
		}

		// On the link's reader, one frame at a time.
		func take(_ packet: Data) {
			guard let pt = try? inn.open(packet) else { return dead() }
			guard pt.count >= 5 else { return }
			let b = [UInt8](pt)
			let id = UInt32(b[0]) << 24 | UInt32(b[1]) << 16 | UInt32(b[2]) << 8 | UInt32(b[3])
			guard let st = stream(id) else { return }
			switch b[4] {
			case Tunnel.tData:
				st.inbox.put(Data(b[5...]))
			case Tunnel.tAck where b.count == 9:
				let acked = UInt32(b[5]) << 24 | UInt32(b[6]) << 16 | UInt32(b[7]) << 8 | UInt32(b[8])
				st.gate.lock()
				st.unacked -= Int64(acked)
				st.gate.broadcast()
				st.gate.unlock()
			case Tunnel.tEnd:
				// After whatever is still waiting to be written.
				st.inbox.put(nil)
			default:
				break
			}
		}

		// Frames are numbered by the order they're sealed in, so sealing and
		// sending happen under one lock.
		func send(_ id: UInt32, _ type: UInt8, _ data: Data = Data()) throws {
			sending.lock()
			defer { sending.unlock() }
			guard alive else { throw Failure.other("tunnel closed") }
			var be = id.bigEndian
			var f = Data(bytes: &be, count: 4)
			f.append(type)
			f.append(data)
			try link.send(try out.seal(f))
		}

		func retire() {
			Thread.detachNewThread { [self] in
				let end = Date().addingTimeInterval(Tunnel.retireAfter)
				while alive, busy, Date() < end { Thread.sleep(forTimeInterval: 0.5) }
				dead()
			}
		}

		func dead() {
			lock.lock()
			let was = isAlive
			isAlive = false
			let ids = Array(streams.keys)
			lock.unlock()
			if !was { return }
			for id in ids { finish(id, false) }
			link.close()
		}

		static func start(_ link: Link, _ sp: Spec, ms: Int) throws -> Session {
			do {
				let e = P256.KeyAgreement.PrivateKey()
				let ep = e.publicKey.x963Representation
				var hello = Data([Tunnel.hello])
				hello.append(ep)
				try link.send(hello)
				let reply = Data(try link.first(ms: ms))
				guard reply.count == 1 + 65 + 3 + 16, reply[reply.startIndex] == Tunnel.welcome else { throw Failure.wrongKey }
				let bytes = [UInt8](reply)
				let ec = Data(bytes[1..<66])
				func agree(_ other: Data) throws -> Data {
					let pub = try P256.KeyAgreement.PublicKey(x963Representation: other)
					return try e.sharedSecretFromKeyAgreement(with: pub).withUnsafeBytes { Data($0) }
				}
				let ikm = try agree(sp.key) + agree(ec)
				let okm = HKDF<SHA256>.deriveKey(
					inputKeyMaterial: SymmetricKey(data: ikm), salt: sp.pass,
					info: Tunnel.label + ep + ec + sp.key, outputByteCount: 64
				).withUnsafeBytes { Data($0) }
				let s = Session(link, sp, p2c: okm.prefix(32), c2p: okm.suffix(32))
				guard let said = try? s.inn.open(Data(bytes[66...])), said == Data("lab".utf8) else { throw Failure.wrongKey }
				link.take(over: s)
				return s
			} catch let f as Failure {
				link.close()
				throw f
			} catch {
				link.close()
				throw Failure.wrongKey
			}
		}
	}
}

func labLog(_ text: String) {
	#if DEBUG
	NSLog("Lab: %@", text)
	#endif
}

private func b64(_ d: Data) -> String {
	d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}

private func unb64(_ s: String) -> Data? {
	var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
	while t.count % 4 != 0 { t += "=" }
	return Data(base64Encoded: t)
}

private func goodRelay(_ r: String) -> Bool {
	r.range(of: #"^https?://[A-Za-z0-9.-]+(:\d{1,5})?/?$"#, options: .regularExpression) != nil
}

private func goodAddress(_ a: String) -> Bool {
	guard a.range(of: #"^[0-9.]{7,15}:\d{1,5}$"#, options: .regularExpression) != nil,
		let colon = a.lastIndex(of: ":"), let port = Int(a[a.index(after: colon)...])
	else { return false }
	return (1...65535).contains(port)
}

final class Queue<T> {
	private let c = NSCondition()
	private var items: [T] = []

	func put(_ v: T) {
		c.lock()
		items.append(v)
		c.signal()
		c.unlock()
	}

	func take() -> T {
		c.lock()
		defer { c.unlock() }
		while items.isEmpty { c.wait() }
		return items.removeFirst()
	}

	func poll(ms: Int) -> T? {
		let end = Date().addingTimeInterval(Double(ms) / 1000)
		c.lock()
		defer { c.unlock() }
		while items.isEmpty {
			if ms <= 0 || !c.wait(until: end) { break }
		}
		return items.isEmpty ? nil : items.removeFirst()
	}
}

// A blocking TCP socket. Blocked reads end when another thread closes it.
final class Sock {
	private let fd: Int32
	private let lock = NSLock()
	private var closed = false

	init(fd: Int32) {
		self.fd = fd
		var on: Int32 = 1
		setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
		setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, socklen_t(MemoryLayout<Int32>.size))
	}

	deinit { close() }

	static func connect(host: String, port: UInt16, ms: Int32) throws -> Sock {
		var addr = sockaddr_in()
		addr.sin_family = sa_family_t(AF_INET)
		addr.sin_port = port.bigEndian
		guard inet_pton(AF_INET, host, &addr.sin_addr) == 1 else { throw Tunnel.Failure.other("bad host \(host)") }
		let fd = socket(AF_INET, SOCK_STREAM, 0)
		guard fd >= 0 else { throw Tunnel.Failure.other("no socket") }
		let s = Sock(fd: fd)
		let flags = fcntl(fd, F_GETFL)
		_ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
		let r = withUnsafePointer(to: &addr) {
			$0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
				Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
			}
		}
		if r != 0 {
			guard errno == EINPROGRESS else { throw Tunnel.Failure.other("failed to connect") }
			var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
			guard poll(&p, 1, ms) == 1 else { throw Tunnel.Failure.other("after \(ms)ms") }
			var problem: Int32 = 0
			var size = socklen_t(MemoryLayout<Int32>.size)
			getsockopt(fd, SOL_SOCKET, SO_ERROR, &problem, &size)
			guard problem == 0 else { throw Tunnel.Failure.other("failed to connect (\(problem))") }
		}
		_ = fcntl(fd, F_SETFL, flags)
		return s
	}

	// How many bytes came, 0 at the end and less than 0 when it failed.
	func read(_ buf: inout [UInt8]) -> Int {
		while true {
			let n = buf.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
			if n < 0, errno == EINTR { continue }
			return n
		}
	}

	func readFully(_ count: Int) throws -> Data {
		var out = Data(capacity: count)
		var buf = [UInt8](repeating: 0, count: min(max(count, 1), 64 * 1024))
		while out.count < count {
			let want = min(count - out.count, buf.count)
			let n = buf.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, want) }
			if n < 0, errno == EINTR { continue }
			if n <= 0 { throw Tunnel.Failure.other("closed") }
			out.append(contentsOf: buf[0..<n])
		}
		return out
	}

	func write(_ d: Data) throws {
		try d.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
			var at = 0
			while at < raw.count {
				let n = Darwin.write(fd, raw.baseAddress! + at, raw.count - at)
				if n < 0, errno == EINTR { continue }
				if n <= 0 { throw Tunnel.Failure.other("closed") }
				at += n
			}
		}
	}

	func close() {
		lock.lock()
		defer { lock.unlock() }
		if closed { return }
		closed = true
		shutdown(fd, SHUT_RDWR)
		Darwin.close(fd)
	}
}

final class Listener {
	private let fd: Int32
	let port: UInt16
	private let lock = NSLock()
	private var isOpen = true

	var open: Bool { lock.lock(); defer { lock.unlock() }; return isOpen }

	init?(backlog: Int32, onAccept: @escaping (Sock) -> Void) {
		let s = socket(AF_INET, SOCK_STREAM, 0)
		fd = s
		guard s >= 0 else { return nil }
		var addr = sockaddr_in()
		addr.sin_family = sa_family_t(AF_INET)
		addr.sin_addr.s_addr = UInt32(0x7f00_0001).bigEndian
		addr.sin_port = 0
		var size = socklen_t(MemoryLayout<sockaddr_in>.size)
		let ok = withUnsafeMutablePointer(to: &addr) { p in
			p.withMemoryRebound(to: sockaddr.self, capacity: 1) { a in
				bind(s, a, size) == 0 && listen(s, backlog) == 0 && getsockname(s, a, &size) == 0
			}
		}
		guard ok else {
			Darwin.close(s)
			return nil
		}
		port = UInt16(bigEndian: addr.sin_port)
		Thread.detachNewThread { [self] in
			while true {
				let c = accept(fd, nil, nil)
				if c < 0 {
					if errno == EINTR { continue }
					// A port nobody accepts on would hang every request, so the next base() opens a new one.
					close()
					return
				}
				onAccept(Sock(fd: c))
			}
		}
	}

	func close() {
		lock.lock()
		defer { lock.unlock() }
		if !isOpen { return }
		isOpen = false
		shutdown(fd, SHUT_RDWR)
		Darwin.close(fd)
	}
}

// What network the phone is on now.
final class Net {
	static let shared = Net()
	private let monitor = NWPathMonitor()
	var onChange: ((NWPath) -> Void)?

	private init() {
		monitor.pathUpdateHandler = { [weak self] p in self?.onChange?(p) }
		monitor.start(queue: DispatchQueue(label: "lab.net"))
	}

	var online: Bool { monitor.currentPath.status == .satisfied }

	// On mobile data a local address can only time out, so it isn't tried.
	// Tailscale shows as "other", and its addresses are worth trying too.
	var local: Bool {
		let p = monitor.currentPath
		return p.usesInterfaceType(.wifi) || p.usesInterfaceType(.wiredEthernet) || p.usesInterfaceType(.other)
	}
}
