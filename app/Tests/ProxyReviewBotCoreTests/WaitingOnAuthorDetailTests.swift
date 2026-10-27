import Foundation
@testable import ProxyReviewBotCore
import XCTest

final class WaitingOnAuthorDetailTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_793_015_000)

    func testRetryingFailureIsUpNextWithTheRetryTimeAndReason() {
        var pullRequest = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)
        pullRequest.rounds = 0
        pullRequest.reason = "Claude run timed out"
        pullRequest.retryAt = (now.timeIntervalSince1970 + 9.5 * 60) * 1000

        XCTAssertTrue(pullRequest.isRetryingFailure)
        XCTAssertEqual(pullRequest.reviewStep, .upNext)
        XCTAssertEqual(
            PullRequestDetail.text(for: pullRequest, now: now),
            "Up next · retrying in 10 min · last try failed: Claude run timed out"
        )

        pullRequest.retryAt = (now.timeIntervalSince1970 - 60) * 1000

        XCTAssertEqual(
            PullRequestDetail.text(for: pullRequest, now: now),
            "Up next · retrying soon · last try failed: Claude run timed out"
        )
    }

    func testFailureThatWillNotRetryWaitsForYou() {
        var pullRequest = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)
        pullRequest.reason = "Claude run timed out"

        XCTAssertFalse(pullRequest.isRetryingFailure)
        XCTAssertEqual(pullRequest.reviewStep, .waitingForYou)
        XCTAssertEqual(PullRequestDetail.text(for: pullRequest, now: now), "Waiting for you · Review failed: Claude run timed out")
    }

    func testReviewAgainKeepsRoundsForAFailedReviewButResetsAfterGivingUp() {
        var failed = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)
        failed.reason = "Claude run timed out"

        XCTAssertEqual(failed.reviewAgainAction, .review(pullRequestID: 1))
        XCTAssertEqual(Fixtures.pullRequest(id: 2, status: .needsYou).reviewAgainAction, .retry(pullRequestID: 2))
        XCTAssertNil(Fixtures.pullRequest(id: 3, status: .waitingOnAuthor).reviewAgainAction)
    }

    func testNothingPostedYetSaysSoAfterTheStep() {
        var pullRequest = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)
        pullRequest.rounds = 0

        XCTAssertFalse(pullRequest.hasFailedReview)
        XCTAssertEqual(
            PullRequestDetail.text(for: pullRequest, now: now),
            "Waiting on author · nothing posted yet"
        )
    }

    func testAfterAPostedRoundItShowsTheSummary() {
        let pullRequest = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)

        XCTAssertEqual(PullRequestDetail.text(for: pullRequest, now: now), "Waiting on author · Retry logic sound")
    }
}
