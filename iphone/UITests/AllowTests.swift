import XCTest

// check.mjs runs this when a question is on screen, as simctl has no way to tap.
final class AllowTests: XCTestCase {
	func testAllow() {
		let app = XCUIApplication(bundleIdentifier: "com.somethingobvious.thelab")
		app.activate()
		let allow = app.buttons["Allow"]
		XCTAssertTrue(allow.waitForExistence(timeout: 90), app.debugDescription)
		allow.tap()
		let confirm = app.alerts.buttons["Allow"]
		XCTAssertTrue(confirm.waitForExistence(timeout: 30), app.debugDescription)
		confirm.tap()
		XCTAssertTrue(confirm.waitForNonExistence(timeout: 30))
	}
}
