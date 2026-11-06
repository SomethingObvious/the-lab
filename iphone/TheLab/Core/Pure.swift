import Foundation

typealias J = [String: Any]

func parseJSON(_ text: String) -> J? {
	guard let d = text.data(using: .utf8) else { return nil }
	return (try? JSONSerialization.jsonObject(with: d)) as? J
}

func jsonData(_ value: Any) -> Data {
	(try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])) ?? Data("{}".utf8)
}

func jsonString(_ value: Any) -> String {
	String(decoding: jsonData(value), as: UTF8.self)
}

func isBool(_ v: Any?) -> Bool {
	guard let n = v as? NSNumber else { return false }
	return CFGetTypeID(n) == CFBooleanGetTypeID()
}

enum SendOutcome { case sent, refused, retry }

// A 4xx other than these is the computer turning the message down, which
// sending it again won't change. Anything else is worth another try.
func sendOutcome(_ code: Int) -> SendOutcome {
	if (200...299).contains(code) { return .sent }
	if (400...499).contains(code), code != 401, code != 408, code != 429 { return .refused }
	return .retry
}

// Quick at first, for a blip, then every 30 s, then once a minute. While the
// relay is holding a socket to say when the computer is back, every 5 minutes
// is only a fallback. The spread keeps a phone and the computer from retrying
// in lockstep.
func backoff(failures: Int, waiting: Bool, spread: Double = Double.random(in: 0...1)) -> TimeInterval {
	let base: Double
	if failures < 5 { base = Double(1 << max(failures, 1)) }
	else if failures < 10 { base = 30 }
	else if waiting { base = 300 }
	else { base = 60 }
	return base * (0.8 + 0.4 * spread)
}

// A torn last line from a process killed mid-write is skipped.
func readHistory(_ lines: [String]) -> [J] {
	lines.compactMap { parseJSON($0) }
}

func newestId(_ events: [J]) -> Int64 {
	events.map { ($0["id"] as? NSNumber)?.int64Value ?? 0 }.max() ?? 0
}

// A file's own name, with nothing in it that could reach another folder, or nil.
func plainName(_ s: String) -> String? {
	guard !s.isEmpty, s.count <= 255, s != ".", s != ".." else { return nil }
	for u in s.unicodeScalars where u == "/" || u == "\\" || u.value < 32 { return nil }
	return s
}

// Only what the start paint and the status bar read, each one checked, since
// the page is the agent's design. Nil when the background isn't a colour.
func cleanTheme(_ m: J) -> J? {
	func colour(_ v: Any?) -> String? {
		guard let s = v as? String, s.count == 7, s.hasPrefix("#"), s.dropFirst().allSatisfy(\.isHexDigit) else { return nil }
		return s
	}
	guard let bg = colour(m["bg"]) else { return nil }
	var out: J = ["bg": bg]
	for k in ["dark", "topDark", "bottomDark"] where isBool(m[k]) { out[k] = m[k] }
	return out
}

// Answering questions and pairing are for the shell alone, never the page's
// own calls with the token. The page is the agent's design, so any spelling
// the server could read as one of those routes is turned down too.
func closedToPage(_ path: String) -> Bool {
	if path.contains("\\") || path.contains("#") || path.filter({ $0 == "?" }).count > 1 { return true }
	var p = String(path.prefix { $0 != "?" })
	// Escapes can be stacked, %2561 for a, so they're undone until none are left.
	var rounds = 0
	while p.contains("%") {
		rounds += 1
		if rounds > 4 { return true }
		guard let next = unescape(p) else { return true }
		p = next
	}
	for u in p.unicodeScalars where u.value < 32 || u == "\\" || u == "?" || u == "#" { return true }
	var parts: [String] = []
	for seg in p.split(separator: "/", omittingEmptySubsequences: false).map(String.init) {
		if seg.isEmpty || seg == "." { continue }
		if seg == ".." {
			if !parts.isEmpty { parts.removeLast() }
		} else {
			parts.append(seg.lowercased())
		}
	}
	let route = "/" + parts.joined(separator: "/")
	if route.hasPrefix("/push/") { return true }
	return route == "/answer" || route == "/asks" || route.hasPrefix("/asks/")
		|| route == "/pair" || route.hasPrefix("/pair/") || route == "/pair-phone"
}

// Percent escapes as UTF-8, or nil for a stray % that isn't one.
private func unescape(_ s: String) -> String? {
	var out = Data()
	let bytes = Array(s.utf8)
	var i = 0
	while i < bytes.count {
		if bytes[i] != UInt8(ascii: "%") {
			out.append(bytes[i])
			i += 1
			continue
		}
		if i + 2 >= bytes.count { return nil }
		guard let hi = hexValue(bytes[i + 1]), let lo = hexValue(bytes[i + 2]) else { return nil }
		out.append(hi * 16 + lo)
		i += 3
	}
	return String(decoding: out, as: UTF8.self)
}

private func hexValue(_ b: UInt8) -> UInt8? {
	switch b {
	case 48...57: return b - 48
	case 65...70: return b - 55
	case 97...102: return b - 87
	default: return nil
	}
}
