import UIKit
import UserNotifications

@main
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
	func application(_ app: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
		Hub.setUp()
		Notifier.setUp()
		UNUserNotificationCenter.current().delegate = self
		// Only once he has said yes, and a build without push simply fails it.
		Notifier.enabled { on in
			if on { UIApplication.shared.registerForRemoteNotifications() }
		}
		return true
	}

	func application(_ app: UIApplication, configurationForConnecting s: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
		UISceneConfiguration(name: "Main", sessionRole: s.role)
	}

	func application(_ app: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
		Hub.pushToken = token.map { String(format: "%02x", $0) }.joined()
		Hub.registerPush()
	}

	func application(_ app: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
		labLog("no push: \(error)")
	}

	// A push is for when The Lab isn't running. With it open, the app's own stream got there first.
	func userNotificationCenter(_ c: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
		done(n.request.trigger is UNPushNotificationTrigger ? [] : [.banner, .sound, .list])
	}

	func userNotificationCenter(_ c: UNUserNotificationCenter, didReceive r: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
		Notifier.handle(r, done: done)
	}
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
	var window: UIWindow?
	private var wasAway = false

	func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
		guard let s = scene as? UIWindowScene else { return }
		let w = UIWindow(windowScene: s)
		let screen = Screen()
		w.rootViewController = screen
		window = w
		w.makeKeyAndVisible()
		if let u = options.urlContexts.first?.url { screen.arrive(u) }
	}

	func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
		if let u = contexts.first?.url { Screen.current?.arrive(u) }
	}

	func sceneDidBecomeActive(_ scene: UIScene) {
		Hub.foreground = true
		Hub.start()
		// A suspended app's sockets can be dead without saying so. A look at Control
		// Center suspends nothing, and a redial then would kill an upload under way.
		if wasAway, Hub.paired { Hub.redial() }
		wasAway = false
		Screen.current?.becameActive()
	}

	func sceneWillResignActive(_ scene: UIScene) {
		Hub.foreground = false
	}

	// No background task here. On GitHub's Macs the app stayed frozen while holding one,
	// and iOS killed it for not letting go. What's unsent just waits in the outbox.
	func sceneDidEnterBackground(_ scene: UIScene) {
		wasAway = true
		Screen.current?.wentAway()
	}
}
