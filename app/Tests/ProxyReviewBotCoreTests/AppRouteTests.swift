import XCTest
@testable import ProxyReviewBotCore

final class AppRouteTests: XCTestCase {
    func testEveryScreenOpensDirectlyAboveTheList() {
        XCTAssertEqual(AppRoute.path(opening: .settings), [.settings])
        XCTAssertEqual(AppRoute.path(opening: .history), [.history])
        XCTAssertEqual(AppRoute.path(opening: .draft(pullRequestID: 4)), [.draft(pullRequestID: 4)])
    }

    func testDraftNoticesOpenThatDraftAndOthersGoToTheList() {
        XCTAssertEqual(AppRoute.path(forNoticeIdentifier: "pr-12-draft_ready-abc123"), [.draft(pullRequestID: 12)])
        XCTAssertEqual(AppRoute.path(forNoticeIdentifier: "pr-3-awaiting_approval-abc"), [.draft(pullRequestID: 3)])
        XCTAssertEqual(AppRoute.path(forNoticeIdentifier: "pr-5-needs_you-abc"), [])
        XCTAssertEqual(AppRoute.path(forNoticeIdentifier: "setup_needed"), [])
        XCTAssertEqual(AppRoute.path(forNoticeIdentifier: "launch-summary"), [])
    }

    func testTheNoticeThePlannerSendsForADraftOpensThatDraft() throws {
        var planner = NotificationPlanner()
        _ = planner.notices(for: [], readiness: Fixtures.readyReadiness)

        let notices = planner.notices(for: [Fixtures.pullRequest(id: 7, status: .draftReady)], readiness: Fixtures.readyReadiness)
        let notice = try XCTUnwrap(notices.first)

        XCTAssertEqual(AppRoute.path(forNoticeIdentifier: notice.identifier), [.draft(pullRequestID: 7)])
    }
}

