import ProxyReviewBotCore
import XCTest

final class StopWordingTests: XCTestCase {
    func testNotStartedPullRequestsAreSkippedAndStartedOnesStopped() {
        XCTAssertEqual(StopWording(isReviewStarted: false).buttonTitle, "Skip")
        XCTAssertEqual(StopWording(isReviewStarted: false).question, "Skip this PR? The bot picks it up again when someone re-requests your review.")
        XCTAssertEqual(StopWording(isReviewStarted: true).buttonTitle, "Stop")
        XCTAssertEqual(StopWording(isReviewStarted: true).confirmTitle, "Stop Reviewing")
    }
}
