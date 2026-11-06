// Works another app's window through the Accessibility API, for computer.ts.
// It reads one JSON request on stdin and writes one JSON reply on stdout. The
// Mac asks him once to allow it, under Privacy & Security.
import AppKit
import ApplicationServices

func fail(_ message: String) -> Never {
	reply(["ok": false, "error": message])
	exit(0)
}

func reply(_ fields: [String: Any]) {
	let data = (try? JSONSerialization.data(withJSONObject: fields)) ?? Data()
	FileHandle.standardOutput.write(data)
}

func attribute(_ e: AXUIElement, _ name: String) -> AnyObject? {
	var out: AnyObject?
	return AXUIElementCopyAttributeValue(e, name as CFString, &out) == .success ? out : nil
}

func text(_ e: AXUIElement, _ name: String) -> String {
	guard let v = attribute(e, name) else { return "" }
	if let s = v as? String { return s }
	if let n = v as? NSNumber { return n.stringValue }
	return ""
}

func children(_ e: AXUIElement) -> [AXUIElement] {
	(attribute(e, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func actions(_ e: AXUIElement) -> [String] {
	var out: CFArray?
	guard AXUIElementCopyActionNames(e, &out) == .success else { return [] }
	return (out as? [String]) ?? []
}

func mainWindow(_ pid: pid_t) -> AXUIElement {
	let app = AXUIElementCreateApplication(pid)
	if let w = attribute(app, kAXFocusedWindowAttribute), CFGetTypeID(w) == AXUIElementGetTypeID() {
		return w as! AXUIElement
	}
	if let all = attribute(app, kAXWindowsAttribute) as? [AXUIElement], let w = all.first { return w }
	fail("That app has no window to work with.")
}

func look(_ root: AXUIElement, limit: Int) -> [[String: Any]] {
	var out: [[String: Any]] = []
	func walk(_ e: AXUIElement, _ path: String, _ depth: Int) {
		if out.count >= limit || depth > 40 { return }
		let role = text(e, kAXRoleAttribute).replacingOccurrences(of: "AX", with: "").lowercased()
		let subrole = text(e, kAXSubroleAttribute)
		var name = text(e, kAXTitleAttribute)
		if name.isEmpty { name = text(e, kAXDescriptionAttribute) }
		let secret = subrole == "AXSecureTextField"
		let value = secret ? "" : text(e, kAXValueAttribute)
		var can: [String] = []
		if actions(e).contains(kAXPressAction) { can.append("press") }
		var settable = DarwinBoolean(false)
		if AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
			can.append("set")
		}
		if !name.isEmpty || !value.isEmpty || !can.isEmpty {
			var row: [String: Any] = ["id": path, "role": role, "name": name, "can": can]
			if !value.isEmpty { row["value"] = value }
			if secret { row["secret"] = true }
			if let on = attribute(e, kAXEnabledAttribute) as? Bool, !on { row["off"] = true }
			out.append(row)
		}
		for (i, c) in children(e).enumerated() { walk(c, "\(path).\(i)", depth + 1) }
	}
	walk(root, "0", 0)
	return out
}

func found(_ root: AXUIElement, _ id: String) -> AXUIElement {
	var e = root
	for part in id.split(separator: ".").dropFirst() {
		let kids = children(e)
		guard let i = Int(part), i < kids.count else { fail("Control \(id) isn't in the window any more. Look again.") }
		e = kids[i]
	}
	return e
}

let keyCodes: [String: CGKeyCode] = [
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
	"r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
	"o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, "enter": 36, "return": 36, "tab": 48,
	"space": 49, "backspace": 51, "delete": 117, "esc": 53, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126,
	"home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]

func pressKeys(_ combo: String, _ pid: pid_t) {
	var flags = CGEventFlags()
	let parts = combo.lowercased().split(separator: "+").map(String.init)
	for m in parts.dropLast() {
		switch m {
		case "cmd", "command", "ctrl", "control": flags.insert(m.hasPrefix("c") && m != "ctrl" && m != "control" ? .maskCommand : .maskControl)
		case "shift": flags.insert(.maskShift)
		case "alt", "option": flags.insert(.maskAlternate)
		default: fail("\(m) isn't a key this knows.")
		}
	}
	guard let last = parts.last, let code = keyCodes[last] else { fail("\(combo) isn't a key this knows.") }
	for down in [true, false] {
		let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
		event?.flags = flags
		event?.postToPid(pid)
	}
}

func typeText(_ s: String, _ pid: pid_t) {
	for scalar in s.unicodeScalars {
		if scalar == "\n" { pressKeys("enter", pid); continue }
		var unit = Array(String(scalar).utf16)
		for down in [true, false] {
			let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
			event?.keyboardSetUnicodeString(stringLength: unit.count, unicodeString: &unit)
			event?.postToPid(pid)
		}
	}
}

func notAPassword(_ pid: pid_t) {
	let app = AXUIElementCreateApplication(pid)
	if let f = attribute(app, kAXFocusedUIElementAttribute), CFGetTypeID(f) == AXUIElementGetTypeID(),
		text(f as! AXUIElement, kAXSubroleAttribute) == "AXSecureTextField" {
		fail("The focus is on a password field, so nothing was typed. He types those himself.")
	}
}

func click(_ e: AXUIElement) {
	var origin = CGPoint.zero
	var size = CGSize.zero
	guard let p = attribute(e, kAXPositionAttribute), let s = attribute(e, kAXSizeAttribute),
		AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size)
	else { fail("That control doesn't say where it is on screen.") }
	let at = CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
	for type in [CGEventType.leftMouseDown, .leftMouseUp] {
		CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: at, mouseButton: .left)?.post(tap: .cghidEventTap)
	}
}

func shot(_ pid: pid_t, _ file: String) {
	let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
	guard let w = info.first(where: { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }),
		let id = w[kCGWindowNumber as String] as? Int
	else { fail("That app has no window on screen to take a picture of.") }
	let run = Process()
	run.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
	run.arguments = ["-x", "-o", "-l", String(id), file]
	do { try run.run() } catch { fail("Couldn't take the picture: \(error.localizedDescription)") }
	run.waitUntilExit()
	if run.terminationStatus != 0 { fail("The Mac wouldn't take the picture. It needs Screen Recording allowed.") }
}

func apps() -> [[String: Any]] {
	NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.flatMap { app -> [[String: Any]] in
		let pid = app.processIdentifier
		let all = attribute(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement] ?? []
		return all.prefix(1).map { w in
			["app": app.localizedName ?? "", "pid": Int(pid), "title": text(w, kAXTitleAttribute), "window": String(pid)]
		}
	}
}

let input = FileHandle.standardInput.readDataToEndOfFile()
guard let q = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] else { fail("That request wasn't JSON.") }
if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
	fail("This needs one switch from him. Tell him: on the Mac, open System Settings, then Privacy & Security, then Accessibility, and turn on lab-ax (or The Lab Agent, if that is the one listed). It lets The Lab read and press the buttons in other apps. Every other way of doing the task is still fine to try first.")
}
if q["op"] as? String == "apps" {
	reply(["ok": true, "apps": apps()])
	exit(0)
}
guard let target = (q["window"] as? String).flatMap({ pid_t($0) }) else { fail("That isn't a window.") }
let root = mainWindow(target)
var fields: [String: Any] = ["ok": true]
var wantsLook = false
for step in q["steps"] as? [[String: Any]] ?? [] {
	let id = step["id"] as? String ?? ""
	switch step["do"] as? String ?? "" {
	case "look": wantsLook = true
	case "press":
		if AXUIElementPerformAction(found(root, id), kAXPressAction as CFString) != .success {
			fail("That can't be pressed without the mouse. Use click.")
		}
	case "set":
		let e = found(root, id)
		if text(e, kAXSubroleAttribute) == "AXSecureTextField" {
			fail("That's a password field, so nothing was typed. He types those himself.")
		}
		if AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, (step["text"] as? String ?? "") as CFString) != .success {
			fail("That can't be filled in directly. Use focus and type.")
		}
	case "focus": AXUIElementSetAttributeValue(found(root, id), kAXFocusedAttribute as CFString, kCFBooleanTrue)
	case "click": click(found(root, id))
	case "type":
		notAPassword(target)
		typeText(step["text"] as? String ?? "", target)
	case "keys": pressKeys(step["keys"] as? String ?? "", target)
	case "shot": shot(target, step["file"] as? String ?? "")
	default: fail("\(step["do"] ?? "") isn't something this can do.")
	}
}
if wantsLook {
	Thread.sleep(forTimeInterval: 0.15)
	fields["elements"] = look(mainWindow(target), limit: q["limit"] as? Int ?? 300)
}
reply(fields)
