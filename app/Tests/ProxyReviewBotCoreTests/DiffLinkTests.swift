import Foundation
import ProxyReviewBotCore
import XCTest

final class DiffLinkTests: XCTestCase {
    private let pullRequestURL = URL(string: "https://github.com/acme/api/pull/412")!

    func testRightSideLineLinksToTheHeadLineOfThatFile() {
        let url = DiffLink.lineURL(pullRequestURL: pullRequestURL, path: "README.md", line: 12, side: "RIGHT")

        XCTAssertEqual(
            url.absoluteString,
            "https://github.com/acme/api/pull/412/files#diff-b335630551682c19a781afebcf4d07bf978fb1f8ac04c6bf87428ed5106870f5R12"
        )
    }

    func testLeftSideUsesL() {
        let url = DiffLink.lineURL(pullRequestURL: pullRequestURL, path: "src/a.ts", line: 3, side: "LEFT")

        XCTAssertTrue(url.absoluteString.hasSuffix("L3"))
    }

    func testFileLinkHasNoLineSuffix() {
        let url = DiffLink.fileURL(pullRequestURL: pullRequestURL, path: "src/a.ts")

        XCTAssertEqual(url.fragment?.count, "diff-".count + 64)
    }
}
