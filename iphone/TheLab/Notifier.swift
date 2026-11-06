import Foundation
import UIKit
import UserNotifications

// Without Apple's push service a suspended app hears nothing, so notifications
// come from two places. The running app shows its own for a computer that isn't
// on screen, and the computer pushes a plain one for when The Lab isn't running.
// Pushes pass through Apple, so they never carry his words or the question.
enum Notifier {
	static let askCategory = "ask"
	static let replyCategory = "reply"
	static let allow = "allow"
	static let deny = "deny"
	static let reply = "reply"
	// The computer's own limit on how long a question waits.
	private static let askLimit: TimeInterval = 5 * 60
	private static let center = UNUserNotificationCenter.current()

	static func setUp() {
		// Allowing runs something on his computer, so it shouldn't work from a locked phone.
		center.setNotificationCategories([
			UNNotificationCategory(
				identifier: askCategory,
				actions: [
					UNNotificationAction(identifier: deny, title: "Deny", options: [.authenticationRequired, .destructive]),
					UNNotificationAction(identifier: allow, title: "Allow", options: [.authenticationRequired]),
				],
				intentIdentifiers: []),
			UNNotificationCategory(
				identifier: replyCategory,
				actions: [
					UNTextInputNotificationAction(identifier: reply, title: "Reply", options: [.authenticationRequired], textInputButtonTitle: "Send", textInputPlaceholder: "Message your computer"),
				],
				intentIdentifiers: []),
		])
	}

	// Asked when he first sends something, when replies and approvals start to matter.
	static func ask() {
		center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
			guard granted else { return }
			DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
		}
	}

	// A build for development talks to Apple's sandbox, and the provisioning
	// profile in the app says which it is. An App Store build has none.
	static var pushEnvironment: String {
		guard let p = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
			let text = (try? Data(contentsOf: p)).map({ String(decoding: $0, as: UTF8.self) })
		else { return "production" }
		return text.range(of: #"aps-environment</key>\s*<string>development"#, options: .regularExpression) != nil ? "sandbox" : "production"
	}

	static func enabled(_ done: @escaping (Bool) -> Void) {
		center.getNotificationSettings { s in
			DispatchQueue.main.async { done(s.authorizationStatus == .authorized || s.authorizationStatus == .provisional) }
		}
	}

	private static func named(_ c: Computer, _ text: String) -> String {
		Hub.pairedComputers.count > 1 ? "\(c.name): \(text)" : text
	}

	private static func show(_ id: String, _ c: Computer, title: String, body: String, category: String? = nil, extra: J = [:]) {
		let n = UNMutableNotificationContent()
		n.title = title
		n.body = body
		n.sound = .default
		n.threadIdentifier = c.id
		var info = extra
		info["computer"] = c.id
		n.userInfo = info
		if let category { n.categoryIdentifier = category }
		center.add(UNNotificationRequest(identifier: id, content: n, trigger: nil))
	}

	private static func askId(_ c: Computer, _ ref: String) -> String { "ask-\(c.id)-\(ref)" }
	private static func messageId(_ c: Computer) -> String { "reply-\(c.id)" }

	// After the replay. A question that came in while the link was down gets its
	// card now, unless it's already showing.
	static func onLoaded(_ c: Computer) {
		if Hub.foreground, Hub.on === c { return }
		guard !pushCovers, let i = c.events.lastIndex(where: { $0["kind"] as? String == "ask" }) else { return }
		let e = c.events[i]
		let answered = c.events[(i + 1)...].contains {
			let k = $0["kind"] as? String
			return k == "done" || (k == "answered" && $0["ref"] as? String == e["ref"] as? String)
		}
		if !answered { ask(c, e) }
	}

	// While The Lab is in the background, a phone with push leaves it all to the computer.
	private static var pushCovers: Bool { !Hub.foreground && Hub.pushToken != nil }

	static func onEvent(_ c: Computer, _ e: J) {
		let kind = e["kind"] as? String ?? ""
		if kind == "answered", let ref = e["ref"] as? String {
			center.removeDeliveredNotifications(withIdentifiers: [askId(c, ref)])
			return
		}
		if kind == "done" { clearAsks(c) }
		let at = c.phoneTime(e["at"]) ?? .distantPast
		if Date().timeIntervalSince(at) > 120 { return }
		// A scheduled run with nothing to say stays quiet.
		if e["silent"] as? Bool == true { return }
		// Someone at the computer with The Lab in front already sees it there.
		if (Hub.foreground && Hub.on === c) || e["onMac"] as? Bool == true || pushCovers { return }
		switch kind {
		case "reply":
			show(messageId(c), c, title: c.name, body: plain(e["text"] as? String ?? ""), category: replyCategory)
		case "file":
			show(messageId(c), c, title: c.name, body: "Sent you \(e["name"] as? String ?? "a file")", category: replyCategory)
		case "ask":
			ask(c, e)
		case "notice":
			show("notice-\(c.id)", c, title: named(c, "The Lab"), body: e["text"] as? String ?? "")
		default:
			break
		}
	}

	private static func ask(_ c: Computer, _ e: J) {
		guard let ref = e["ref"] as? String else { return }
		let at = c.phoneTime(e["at"]) ?? Date()
		if Date().timeIntervalSince(at) >= askLimit { return }
		// His words first, as on the card. The command stays in the app.
		var lines: [String] = []
		if let from = e["from"] as? String, !from.isEmpty { lines.append(from) }
		lines += e["facts"] as? [String] ?? []
		if let why = e["why"] as? String, !why.isEmpty { lines.append(why) }
		let text = lines.isEmpty ? (e["detail"] as? String ?? "") : lines.joined(separator: "\n")
		show(askId(c, ref), c, title: named(c, e["title"] as? String ?? "Needs your OK"), body: text, category: askCategory, extra: ["ref": ref])
	}

	// Replies are Markdown, and a notification would show the markers.
	private static func plain(_ s: String) -> String {
		s.replacingOccurrences(of: #"[*_`#>]+"#, with: "", options: .regularExpression)
	}

	private static func clearAsks(_ c: Computer) {
		center.getDeliveredNotifications { all in
			let ids = all.filter {
				$0.request.content.categoryIdentifier == askCategory && $0.request.content.userInfo["computer"] as? String == c.id
			}.map(\.request.identifier)
			center.removeDeliveredNotifications(withIdentifiers: ids)
		}
	}

	static func clearReplies(_ c: Computer) {
		center.removeDeliveredNotifications(withIdentifiers: [messageId(c), "notice-\(c.id)", "queued-\(c.id)", "stop-\(c.id)"])
	}

	// Its Allow cards go too, as there's nothing left to answer them with.
	static func clearAll(_ c: Computer) {
		clearReplies(c)
		clearAsks(c)
		center.removeDeliveredNotifications(withIdentifiers: ["unsent-\(c.id)"])
	}

	static func answerFailed(_ c: Computer, ref: String) {
		show(askId(c, ref), c, title: named(c, "Couldn't reach the computer"), body: "Your answer didn't get through. Tap to try again in The Lab.")
	}

	static func answerExpired(_ c: Computer, ref: String) {
		show(askId(c, ref), c, title: named(c, "That question has gone"), body: "It was already answered, or it waited too long.")
	}

	static func queued(_ c: Computer) {
		show("queued-\(c.id)", c, title: named(c, "Message waiting to send"), body: "It goes as soon as the computer is reachable.")
	}

	static func sent(_ c: Computer) {
		center.removeDeliveredNotifications(withIdentifiers: ["queued-\(c.id)"])
	}

	static func unsent(_ c: Computer, _ text: String) {
		show("unsent-\(c.id)", c, title: named(c, "The computer couldn't take that message"), body: text)
	}

	static func stopFailed(_ c: Computer) {
		show("stop-\(c.id)", c, title: named(c, "Couldn't stop it"), body: "The computer didn't answer. Open The Lab to try again.")
	}

	static func handle(_ r: UNNotificationResponse, done: @escaping () -> Void) {
		let info = r.notification.request.content.userInfo
		let c = (info["computer"] as? String).map { Hub.computer($0) } ?? Hub.computer(room: info["room"] as? String)
		let ref = info["ref"] as? String ?? ""
		switch r.actionIdentifier {
		case allow, deny:
			let id = r.notification.request.identifier
			c.answer(ref, allow: r.actionIdentifier == allow) { code in
				if (200...299).contains(code) {
					center.removeDeliveredNotifications(withIdentifiers: [id])
				} else if code == 404 {
					answerExpired(c, ref: ref)
				} else {
					answerFailed(c, ref: ref)
				}
				done()
			}
		case reply:
			let text = (r as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
			clearReplies(c)
			if !text.isEmpty {
				let cid = UUID().uuidString.lowercased()
				c.send(text, cid: cid, files: nil)
				Hub.start()
				DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
					if c.queued(cid) { queued(c) }
				}
			}
			done()
		default:
			Hub.switchTo(c.id)
			done()
		}
	}
}
