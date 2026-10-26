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

    func testReviewingDetailShowsElapsedMinutes() {
        let startedAt = Date(timeIntervalSince1970: 1_000)
        let pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing, reviewStartedAt: 1_000_000)

        let text = PullRequestDetail.text(for: pullRequest, now: startedAt.addingTimeInterval(6 * 60 + 10))

        XCTAssertEqual(text, "Reviewing · 6 min")
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
