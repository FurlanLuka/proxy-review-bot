import XCTest
@testable import ProxyReviewBotCore

final class PullRequestPresentationTests: XCTestCase {
    func testSectionsGroupByStatus() {
        let pullRequests = [
            Fixtures.pullRequest(id: 1, status: .needsReview),
            Fixtures.pullRequest(id: 2, status: .awaitingApproval),
            Fixtures.pullRequest(id: 3, status: .needsYou),
            Fixtures.pullRequest(id: 4, status: .reviewing),
            Fixtures.pullRequest(id: 5, status: .blocked),
            Fixtures.pullRequest(id: 6, status: .done),
        ]

        let sections = PullRequestSections(pullRequests: pullRequests)

        XCTAssertEqual(sections.needsReview.map(\.id), [1])
        XCTAssertEqual(sections.needsYou.map(\.id), [2, 3])
        XCTAssertEqual(sections.inReview.map(\.id), [4, 5])
        XCTAssertEqual(PullRequestSections.attentionCount(of: pullRequests), 3)
    }

    func testFailedReviewIsGroupedUnderNeedsYou() {
        var failed = Fixtures.pullRequest(id: 7, status: .waitingOnAuthor)
        failed.reason = "Claude run timed out"
        let pullRequests = [failed, Fixtures.pullRequest(id: 8, status: .waitingOnAuthor)]

        let sections = PullRequestSections(pullRequests: pullRequests)

        XCTAssertEqual(sections.needsYou.map(\.id), [7])
        XCTAssertEqual(sections.inReview.map(\.id), [8])
        XCTAssertEqual(PullRequestSections.attentionCount(of: pullRequests), 1)
    }

    func testReviewingDetailShowsElapsedMinutes() {
        let startedAt = Date(timeIntervalSince1970: 1_000)
        let pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing, reviewStartedAt: 1_000_000)

        let text = PullRequestDetail.text(for: pullRequest, now: startedAt.addingTimeInterval(6 * 60 + 10))

        XCTAssertEqual(text, "Reviewing · 6 min")
    }

    func testRoundTextSpellsOutTheRound() {
        let pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing)

        XCTAssertEqual(PullRequestDetail.roundText(for: pullRequest), "Round 2 of 5")
    }

    func testStatusDisplayNamesReadAsSentences() {
        XCTAssertEqual(PullRequestStatus.needsReview.displayName, "Needs review")
        XCTAssertEqual(PullRequestStatus.awaitingApproval.displayName, "Ready to approve")
        XCTAssertEqual(PullRequestStatus.waitingOnAuthor.displayName, "Waiting on author")
        XCTAssertEqual(PullRequestStatus.stopped.displayName, "Stopped")
    }

    func testListeningEventParsesPort() {
        XCTAssertEqual(ServiceListeningEvent.port(fromLine: #"{"event":"listening","port":54321}"#), 54321)
        XCTAssertNil(ServiceListeningEvent.port(fromLine: #"{"event":"other","port":1}"#))
        XCTAssertNil(ServiceListeningEvent.port(fromLine: "not json"))
    }

    func testActionPaths() {
        XCTAssertEqual(ServiceAction.retry(pullRequestID: 7).path, "/prs/7/retry")
        XCTAssertEqual(ServiceAction.checkReadiness.path, "/readiness/check")
    }
}
