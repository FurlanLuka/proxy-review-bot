import XCTest
@testable import ProxyReviewBotCore

final class MenuBarAccessibilityLabelTests: XCTestCase {
    func testConnectingShowsOnlyTheAppName() {
        XCTAssertEqual(MenuBarAccessibilityLabel.text(for: nil, attentionCount: 0), "Proxy Review Bot")
    }

    func testRunningStateCountsWhatNeedsYou() {
        let state = makeState()

        XCTAssertEqual(MenuBarAccessibilityLabel.text(for: state, attentionCount: 3), "Proxy Review Bot, 3 need you")
        XCTAssertEqual(MenuBarAccessibilityLabel.text(for: state, attentionCount: 1), "Proxy Review Bot, 1 needs you")
    }

    func testPausedStateSaysPaused() {
        let state = makeState(isPaused: true)

        XCTAssertEqual(MenuBarAccessibilityLabel.text(for: state, attentionCount: 0), "Proxy Review Bot, paused")
    }

    func testSetupNeededWinsOverUsageLimit() {
        let state = makeState(usageLimitedUntil: 1_793_015_179_000, readiness: Fixtures.setupNeededReadiness)

        XCTAssertEqual(MenuBarAccessibilityLabel.text(for: state, attentionCount: 2), "Proxy Review Bot, setup needed, 2 need you")
    }

    func testUsageLimitIsNamed() {
        let state = makeState(usageLimitedUntil: 1_793_015_179_000)

        XCTAssertEqual(MenuBarAccessibilityLabel.text(for: state, attentionCount: 0), "Proxy Review Bot, usage limit")
    }

    private func makeState(
        isPaused: Bool = false,
        usageLimitedUntil: Double? = nil,
        readiness: Readiness = Fixtures.readyReadiness
    ) -> BotState {
        BotState(
            viewerLogin: "ana",
            isPaused: isPaused,
            usageLimitedUntil: usageLimitedUntil,
            readiness: readiness,
            settings: BotSettings(
                reviewMode: .manual,
                autoApprove: .off,
                smallPullRequestLineLimit: 50,
                maxRounds: 5,
                pollIntervalSeconds: 60,
                answerQuestions: true,
                watch: [],
                skip: [],
                toolPaths: ToolPaths()
            ),
            pullRequests: []
        )
    }
}
