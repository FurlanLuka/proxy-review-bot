import XCTest
@testable import ProxyReviewBotCore

final class NotificationPlannerTests: XCTestCase {
    private let pendingPullRequests = [
        Fixtures.pullRequest(id: 1),
        Fixtures.pullRequest(id: 2),
        Fixtures.pullRequest(id: 3, status: .needsYou),
    ]

    func testLaunchWithThreePendingSendsOneSummary() {
        var planner = NotificationPlanner()

        let notices = planner.notices(for: pendingPullRequests, readiness: Fixtures.readyReadiness)

        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(notices.first?.title, "3 PRs need you")
        XCTAssertEqual(planner.notifiedKeys?.count, 3)
    }

    func testLaunchWithNothingPendingSendsNothing() {
        var planner = NotificationPlanner()

        let notices = planner.notices(for: [Fixtures.pullRequest(id: 1, status: .reviewing)], readiness: Fixtures.readyReadiness)

        XCTAssertEqual(notices, [])
        XCTAssertEqual(planner.notifiedKeys, [])
    }

    func testSameStateAgainSendsNothing() {
        var planner = NotificationPlanner()
        _ = planner.notices(for: pendingPullRequests, readiness: Fixtures.readyReadiness)

        let notices = planner.notices(for: pendingPullRequests, readiness: Fixtures.readyReadiness)

        XCTAssertEqual(notices, [])
    }

    func testNewAwaitingApprovalSendsOneNotice() {
        var planner = NotificationPlanner()
        _ = planner.notices(for: pendingPullRequests, readiness: Fixtures.readyReadiness)

        let notices = planner.notices(
            for: pendingPullRequests + [Fixtures.pullRequest(id: 4)],
            readiness: Fixtures.readyReadiness
        )

        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(notices.first?.title, "api #404 is ready to approve")
    }

    func testSamePullRequestOnNewHeadNotifiesAgain() {
        var planner = NotificationPlanner()
        _ = planner.notices(for: [Fixtures.pullRequest(id: 1)], readiness: Fixtures.readyReadiness)

        let notices = planner.notices(
            for: [Fixtures.pullRequest(id: 1, headSha: "def456")],
            readiness: Fixtures.readyReadiness
        )

        XCTAssertEqual(notices.count, 1)
        XCTAssertEqual(notices.first?.identifier, "pr-1-awaiting_approval-def456")
    }

    func testServiceBlipDoesNotNotifyAgain() {
        var planner = NotificationPlanner()
        _ = planner.notices(for: pendingPullRequests, readiness: Fixtures.readyReadiness)

        let blipNotices = planner.notices(for: [], readiness: Fixtures.readyReadiness)
        let recoveredNotices = planner.notices(for: pendingPullRequests, readiness: Fixtures.readyReadiness)

        XCTAssertEqual(blipNotices, [])
        XCTAssertEqual(recoveredNotices, [])
    }

    func testItemMissingForTwoPollsNotifiesWhenItReturns() {
        var planner = NotificationPlanner()
        let pullRequest = Fixtures.pullRequest(id: 1)
        _ = planner.notices(for: [pullRequest], readiness: Fixtures.readyReadiness)
        _ = planner.notices(for: [], readiness: Fixtures.readyReadiness)
        _ = planner.notices(for: [], readiness: Fixtures.readyReadiness)

        let notices = planner.notices(for: [pullRequest], readiness: Fixtures.readyReadiness)

        XCTAssertEqual(notices.count, 1)
    }

    func testSetupNeededOnceSendsOneNotice() {
        var planner = NotificationPlanner()
        _ = planner.notices(for: [], readiness: Fixtures.readyReadiness)

        let firstNotices = planner.notices(for: [], readiness: Fixtures.setupNeededReadiness)
        let secondNotices = planner.notices(for: [], readiness: Fixtures.setupNeededReadiness)

        XCTAssertEqual(firstNotices.map(\.title), ["Setup needed"])
        XCTAssertEqual(firstNotices.first?.body, "Claude isn't logged in")
        XCTAssertEqual(secondNotices, [])
    }

    func testLaunchWithOnlySetupNeededSendsTheSetupNotice() {
        var planner = NotificationPlanner()

        let notices = planner.notices(for: [], readiness: Fixtures.setupNeededReadiness)

        XCTAssertEqual(notices.map(\.title), ["Setup needed"])
    }
}
