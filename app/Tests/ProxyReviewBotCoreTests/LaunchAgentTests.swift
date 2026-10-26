import Foundation
import ProxyReviewBotCore
import XCTest

final class LaunchAgentTests: XCTestCase {
    private var homeDirectory: URL!

    override func setUpWithError() throws {
        homeDirectory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: homeDirectory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: homeDirectory)
    }

    func testInstallWritesAPlistThatRestartsOnlyAfterACrash() throws {
        let launchAgent = LaunchAgent(homeDirectory: homeDirectory)

        try launchAgent.install(executablePath: "/Apps/ProxyReviewBot.app/Contents/MacOS/ProxyReviewBot")

        XCTAssertTrue(launchAgent.isInstalled)
        XCTAssertEqual(
            launchAgent.plistURL.path,
            homeDirectory.appendingPathComponent("Library/LaunchAgents/com.furlanluka.proxy-review-bot.plist").path
        )

        let data = try Data(contentsOf: launchAgent.plistURL)
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        XCTAssertEqual(plist["Label"] as? String, LaunchAgent.label)
        XCTAssertEqual(plist["ProgramArguments"] as? [String], ["/Apps/ProxyReviewBot.app/Contents/MacOS/ProxyReviewBot"])
        XCTAssertEqual(plist["RunAtLoad"] as? Bool, true)
        XCTAssertEqual((plist["KeepAlive"] as? [String: Bool])?["SuccessfulExit"], false)
    }

    func testRemoveIsIdempotent() throws {
        let launchAgent = LaunchAgent(homeDirectory: homeDirectory)

        try launchAgent.remove()
        try launchAgent.install(executablePath: "/x")
        try launchAgent.remove()

        XCTAssertFalse(launchAgent.isInstalled)
    }
}
