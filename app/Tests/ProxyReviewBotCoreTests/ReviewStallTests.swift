import Foundation
@testable import ProxyReviewBotCore
import XCTest

final class ReviewStallTests: XCTestCase {
    private let lastActivityAt = 1_793_015_200_000.0

    private func reviewing(lastActivityAt: Double?) -> PullRequest {
        var pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing, reviewStartedAt: 1_793_015_000_000)
        pullRequest.progress = ReviewProgress(
            phase: nil,
            message: "Reviewing",
            subagents: [],
            updatedAt: 1_793_015_000_000,
            lastActivityAt: lastActivityAt
        )

        return pullRequest
    }

    private func minutesAfterActivity(_ minutes: Double) -> Date {
        Date(timeIntervalSince1970: (lastActivityAt + minutes * 60_000) / 1000)
    }

    func testNoTextBeforeTenMinutesOfSilence() {
        XCTAssertNil(ReviewStall.text(for: reviewing(lastActivityAt: lastActivityAt), now: minutesAfterActivity(9.9)))
    }

    func testTextFromTenMinutesWithMinutesRoundedDown() {
        let pullRequest = reviewing(lastActivityAt: lastActivityAt)

        XCTAssertEqual(
            ReviewStall.text(for: pullRequest, now: minutesAfterActivity(10)),
            "No activity from Claude for 10 min"
        )
        XCTAssertEqual(
            ReviewStall.text(for: pullRequest, now: minutesAfterActivity(14.9)),
            "No activity from Claude for 14 min"
        )
    }

    func testNoTextWhenNotReviewingOrWithoutActivity() {
        var queued = reviewing(lastActivityAt: lastActivityAt)
        queued.status = .queued
        var noProgress = reviewing(lastActivityAt: lastActivityAt)
        noProgress.progress = nil
        let olderService = reviewing(lastActivityAt: nil)
        let now = minutesAfterActivity(30)

        XCTAssertNil(ReviewStall.text(for: queued, now: now))
        XCTAssertNil(ReviewStall.text(for: noProgress, now: now))
        XCTAssertNil(ReviewStall.text(for: olderService, now: now))
    }
}
