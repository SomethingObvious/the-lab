import Foundation
import XCTest

@testable import LabCore

final class PureTests: XCTestCase {
	func testRoutesClosedToThePage() {
		for p in ["/answer", "/ANSWER", "/asks/1", "/x/../answer", "/%61nswer", "/%2561nswer", "/pair/claim", "/pair-phone", "/push/register", "/a\\b", "/a#b", "/x%"] {
			XCTAssertTrue(closedToPage(p), p)
		}
		for p in ["/memory", "/models?x=1", "/check", "/answers"] { XCTAssertFalse(closedToPage(p), p) }
	}

	func testPlainName() {
		XCTAssertEqual(plainName("a b.png"), "a b.png")
		for bad in ["", ".", "..", "a/b", "a\\b", "a\nb"] { XCTAssertNil(plainName(bad), bad) }
	}

	func testSendOutcome() {
		XCTAssertEqual(sendOutcome(202), .sent)
		XCTAssertEqual(sendOutcome(413), .refused)
		for c in [401, 408, 429, 500, -1] { XCTAssertEqual(sendOutcome(c), .retry) }
	}

	func testBackoff() {
		XCTAssertEqual(backoff(failures: 1, waiting: false, spread: 0.5), 2)
		XCTAssertEqual(backoff(failures: 7, waiting: false, spread: 0.5), 30)
		XCTAssertEqual(backoff(failures: 12, waiting: false, spread: 0.5), 60)
		XCTAssertEqual(backoff(failures: 12, waiting: true, spread: 0.5), 300)
	}

	func testHistorySkipsATornLine() {
		let got = readHistory(["{\"id\":1}", "{\"id\":2", "{\"id\":3}"])
		XCTAssertEqual(got.count, 2)
		XCTAssertEqual(newestId(got), 3)
	}

	func testThemeOnlyKeepsWhatItChecked() {
		XCTAssertNil(cleanTheme(["bg": "red"]))
		XCTAssertEqual(cleanTheme(["bg": "#102030", "dark": true, "topDark": "no", "x": 1])?.count, 2)
	}

	func testSpecRefusesBadPairings() {
		let key = String(repeating: "A", count: 87)
		let pass = String(repeating: "A", count: 43)
		XCTAssertNotNil(Tunnel.Spec.parse(["room": "r", "key": key, "pass": pass, "relay": "https://x.workers.dev", "lan": ["10.0.0.2:8418"]]))
		XCTAssertNil(Tunnel.Spec.parse(["room": "r", "key": "AA", "pass": pass]))
		XCTAssertNil(Tunnel.Spec.parse(["room": "r", "key": key, "pass": pass, "relay": "ftp://x"]))
		XCTAssertNil(Tunnel.Spec.parse(["room": "r", "key": key, "pass": pass, "lan": ["10.0.0.2:99999"]]))
	}
}

// Talks to a real computer/tunnel.ts started by peer.mjs. The relay tests only
// run when LAB_TEST_RELAY names a relay that's up.
final class TunnelTests: XCTestCase {
	private var peer: Process?
	private var input: Pipe?

	private func start(relay: String = "") throws -> J {
		let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
		let p = Process()
		let out = Pipe()
		let inp = Pipe()
		p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
		p.arguments = ["node", here.appendingPathComponent("peer.mjs").path, relay]
		p.standardOutput = out
		p.standardInput = inp
		try p.run()
		peer = p
		input = inp
		var line = Data()
		while !line.contains(10) {
			let d = out.fileHandleForReading.availableData
			if d.isEmpty { break }
			line.append(d)
		}
		return try XCTUnwrap(parseJSON(String(decoding: line, as: UTF8.self)))
	}

	override func tearDown() {
		peer?.terminate()
	}

	private func call(_ t: Tunnel, _ path: String, body: Data? = nil) throws -> Data {
		var req = URLRequest(url: URL(string: try XCTUnwrap(t.base()) + path)!)
		req.timeoutInterval = 30
		if let body {
			req.httpMethod = "POST"
			req.httpBody = body
		}
		let got = expectation(description: path)
		var data: Data?
		var failure: Error?
		URLSession(configuration: .ephemeral).dataTask(with: req) { d, _, e in
			data = d
			failure = e
			got.fulfill()
		}.resume()
		wait(for: [got], timeout: 60)
		if let failure { throw failure }
		return try XCTUnwrap(data)
	}

	private func roundTrip(_ t: Tunnel, route: String) throws {
		XCTAssertEqual(String(decoding: try call(t, "/health"), as: UTF8.self), "ok")
		XCTAssertEqual(t.route, route)
		let big = try call(t, "/big")
		XCTAssertEqual(big.count, 3 * 1024 * 1024)
		XCTAssertTrue(big.allSatisfy { $0 == 55 })
		let up = Data(count: 3 * 1024 * 1024)
		XCTAssertEqual(String(decoding: try call(t, "/up", body: up), as: UTF8.self), "got \(up.count)")
	}

	func testDirect() throws {
		let t = Tunnel()
		t.direct = { true }
		t.spec = try XCTUnwrap(Tunnel.Spec.parse(try start()))
		try roundTrip(t, route: "direct")
	}

	func testWrongPassIsTurnedAway() throws {
		var j = try start()
		j["pass"] = String(repeating: "B", count: 43)
		let t = Tunnel()
		t.direct = { true }
		t.spec = try XCTUnwrap(Tunnel.Spec.parse(j))
		XCTAssertThrowsError(try call(t, "/health"))
		XCTAssertEqual(t.why, "key")
	}

	func testNoRouteSaysSo() throws {
		var j = try start()
		j["lan"] = ["127.0.0.1:1"]
		let t = Tunnel()
		t.direct = { true }
		t.spec = try XCTUnwrap(Tunnel.Spec.parse(j))
		XCTAssertThrowsError(try call(t, "/health"))
		XCTAssertEqual(t.why, "none")
	}

	func testClaimGoesOverItsOwnSession() throws {
		let sp = try XCTUnwrap(Tunnel.Spec.parse(try start()))
		let t = Tunnel()
		t.direct = { true }
		let base = try XCTUnwrap(t.once(sp))
		let got = expectation(description: "once")
		var text = ""
		URLSession(configuration: .ephemeral).dataTask(with: URL(string: base + "/health")!) { d, _, _ in
			text = String(decoding: d ?? Data(), as: UTF8.self)
			got.fulfill()
		}.resume()
		wait(for: [got], timeout: 30)
		XCTAssertEqual(text, "ok")
	}

	func testRelayAndBackToDirect() throws {
		guard let relay = ProcessInfo.processInfo.environment["LAB_TEST_RELAY"] else { throw XCTSkip("no relay") }
		let spec = try XCTUnwrap(Tunnel.Spec.parse(try start(relay: relay)))
		// The computer needs a moment to reach the relay.
		Thread.sleep(forTimeInterval: 2)
		let t = Tunnel()
		t.direct = { false }
		t.spec = spec
		try roundTrip(t, route: "relay")
		t.direct = { true }
		XCTAssertTrue(t.upgrade())
		XCTAssertEqual(t.route, "direct")
		XCTAssertEqual(String(decoding: try call(t, "/health"), as: UTF8.self), "ok")
	}

	func testAwayOnTheRelay() throws {
		guard let relay = ProcessInfo.processInfo.environment["LAB_TEST_RELAY"] else { throw XCTSkip("no relay") }
		let room = String(repeating: "r", count: 43)
		let key = try start(relay: relay)["key"]
		let j: J = ["room": room, "key": key as Any, "pass": String(repeating: "A", count: 43), "relay": relay, "lan": []]
		let t = Tunnel()
		t.direct = { false }
		t.spec = try XCTUnwrap(Tunnel.Spec.parse(j))
		XCTAssertThrowsError(try call(t, "/health"))
		XCTAssertEqual(t.why, "away")
	}
}
