import ProxyReviewBotCore
import XCTest

final class ToolSearchPathTests: XCTestCase {
    func testExtractIgnoresShellStartupNoise() {
        let output = "Welcome!\n__PRB_PATH__/a:/b__PRB_PATH__"

        XCTAssertEqual(ToolSearchPath.extract(fromShellOutput: output), "/a:/b")
    }

    func testExtractWithoutMarkersIsNil() {
        XCTAssertNil(ToolSearchPath.extract(fromShellOutput: "/a:/b"))
        XCTAssertNil(ToolSearchPath.extract(fromShellOutput: "__PRB_PATH____PRB_PATH__"))
    }

    func testKnownLocationsAreAppendedOnceAfterTheShellPath() {
        let path = ToolSearchPath.withKnownLocations("/opt/homebrew/bin:/custom", homeDirectory: "/Users/me")
        let entries = path.split(separator: ":").map(String.init)

        XCTAssertEqual(Array(entries.prefix(2)), ["/opt/homebrew/bin", "/custom"])
        XCTAssertTrue(entries.contains("/Users/me/.local/bin"))
        XCTAssertTrue(entries.contains("/Users/me/.claude/local"))
        XCTAssertEqual(entries.filter { $0 == "/opt/homebrew/bin" }.count, 1)
    }
}
