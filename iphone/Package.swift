// swift-tools-version:5.9
// The parts that don't need a screen, so `swift test` can run them on a Mac
// against the real computer/tunnel.ts.
import PackageDescription

let package = Package(
	name: "LabCore",
	platforms: [.macOS(.v13), .iOS(.v16)],
	targets: [
		.target(name: "LabCore", path: "TheLab/Core"),
		.testTarget(name: "LabCoreTests", dependencies: ["LabCore"], path: "Tests", exclude: ["peer.mjs", "engine.cjs"]),
	]
)
