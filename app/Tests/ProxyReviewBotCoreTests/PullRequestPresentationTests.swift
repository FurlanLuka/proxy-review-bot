import XCTest
@testable import ProxyReviewBotCore

final class PullRequestPresentationTests: XCTestCase {
    func testOnlyUnstartedReviewsAreReadyToReviewAndEverythingStartedIsInReview() {
        var firstReview = Fixtures.pullRequest(id: 1, status: .needsReview)
        firstReview.rounds = 0
        var startedAgain = Fixtures.pullRequest(id: 6, status: .needsReview)
        startedAgain.rounds = 0
        startedAgain.isStarted = true
        let pullRequests = [
            firstReview,
            Fixtures.pullRequest(id: 2, status: .blocked),
            Fixtures.pullRequest(id: 3, status: .waitingOnAuthor),
            Fixtures.pullRequest(id: 4, status: .queued),
            Fixtures.pullRequest(id: 5, status: .reviewing),
            startedAgain,
            Fixtures.pullRequest(id: 7, status: .needsYou),
            Fixtures.pullRequest(id: 8, status: .done),
        ]

        let sections = PullRequestSections(pullRequests: pullRequests)

        XCTAssertEqual(sections.readyToReview.map(\.id), [1])
        XCTAssertEqual(sections.inReview.map(\.id), [7, 5, 4, 6, 3, 2])
        XCTAssertEqual(sections.inReview.map(\.reviewStep), [.waitingForYou, .reviewing, .queued, .upNext, .waitingOnAuthor, .blocked])
        XCTAssertEqual(PullRequestSections.attentionCount(of: pullRequests), 2)
    }

    func testAFollowUpNeverGoesBackToReadyToReview() {
        var followUp = Fixtures.pullRequest(id: 1, status: .needsReview)
        followUp.rounds = 1
        followUp.isStarted = true

        let sections = PullRequestSections(pullRequests: [followUp])

        XCTAssertTrue(sections.readyToReview.isEmpty)
        XCTAssertEqual(sections.inReview.map(\.id), [1])
        XCTAssertTrue(followUp.showsRoundCount)
        XCTAssertEqual(PullRequestDetail.text(for: followUp, now: Date()), "Up next")
        XCTAssertEqual(PullRequestSections.attentionCount(of: [followUp]), 0)
    }

    func testRetryingFailureSortsAfterQueuedAndIsNotCountedInTheBadge() {
        var retrying = Fixtures.pullRequest(id: 7, status: .waitingOnAuthor)
        retrying.reason = "Claude run timed out"
        retrying.retryAt = 1_793_016_000_000
        let pullRequests = [retrying, Fixtures.pullRequest(id: 8, status: .queued), Fixtures.pullRequest(id: 9, status: .draftReady)]

        let sections = PullRequestSections(pullRequests: pullRequests)

        XCTAssertEqual(sections.inReview.map(\.id), [9, 8, 7])
        XCTAssertEqual(PullRequestSections.attentionCount(of: pullRequests), 1)
    }

    func testFailedReviewWaitsForYouInsideInReview() {
        var failed = Fixtures.pullRequest(id: 7, status: .waitingOnAuthor)
        failed.reason = "Claude run timed out"
        let pullRequests = [Fixtures.pullRequest(id: 8, status: .waitingOnAuthor), failed]

        let sections = PullRequestSections(pullRequests: pullRequests)

        XCTAssertEqual(sections.inReview.map(\.id), [7, 8])
        XCTAssertEqual(failed.reviewStep, .waitingForYou)
        XCTAssertEqual(PullRequestSections.attentionCount(of: pullRequests), 1)
    }

    func testFirstReviewIsReadyToReviewWithoutARoundCount() {
        var firstReview = Fixtures.pullRequest(id: 2, status: .needsReview)
        firstReview.rounds = 0

        XCTAssertNil(firstReview.reviewStep)
        XCTAssertFalse(firstReview.showsRoundCount)
        XCTAssertEqual(PullRequestDetail.text(for: firstReview, now: Date()), "Requested by @ana")
    }

    func testRoundTextCountsTheRoundInProgress() {
        var reviewing = Fixtures.pullRequest(id: 1, status: .reviewing)
        reviewing.rounds = 0
        var waiting = Fixtures.pullRequest(id: 2, status: .waitingOnAuthor)
        waiting.rounds = 1
        var gaveUp = Fixtures.pullRequest(id: 3, status: .needsYou)
        gaveUp.rounds = 5

        XCTAssertEqual(PullRequestDetail.roundText(for: reviewing), "Round 1 of 5")
        XCTAssertEqual(PullRequestDetail.roundText(for: waiting), "Round 1 of 5")
        XCTAssertEqual(PullRequestDetail.roundText(for: gaveUp), "Round 5 of 5")
    }

    func testRoundTextNeverGoesPastTheLimit() {
        var approving = Fixtures.pullRequest(id: 1, status: .awaitingApproval)
        approving.rounds = 5

        XCTAssertEqual(PullRequestDetail.roundText(for: approving), "Round 5 of 5")
    }

    func testTheServiceDecidesWhetherAReviewHasStarted() {
        var notStarted = Fixtures.pullRequest(id: 1, status: .needsReview)
        notStarted.rounds = 2
        notStarted.isStarted = false

        XCTAssertTrue(notStarted.isReadyToReview)
        XCTAssertEqual(PullRequestSections(pullRequests: [notStarted]).readyToReview.map(\.id), [1])
    }

    func testStaleDraftScreenExplainsWhyTheDraftIsGone() {
        XCTAssertEqual(DraftGoneMessage.text(for: Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)), "New commits arrived — a new draft is on its way")
        XCTAssertEqual(DraftGoneMessage.text(for: Fixtures.pullRequest(id: 2, status: .queued)), "New commits arrived — a new draft is on its way")
        XCTAssertEqual(DraftGoneMessage.text(for: Fixtures.pullRequest(id: 3, status: .done)), "This draft is no longer needed")
        XCTAssertEqual(DraftGoneMessage.text(for: Fixtures.pullRequest(id: 4, status: .needsYou)), "This draft is no longer needed")
        XCTAssertEqual(DraftGoneMessage.text(for: nil), "This draft is no longer needed")
    }

    func testWaitingForYouStepsLeadWithTheStep() {
        XCTAssertEqual(PullRequestDetail.text(for: Fixtures.pullRequest(id: 1, status: .awaitingApproval), now: Date()), "Waiting for you · Ready to approve: Retry logic sound")
        XCTAssertEqual(PullRequestDetail.text(for: Fixtures.pullRequest(id: 2, status: .needsYou), now: Date()), "Waiting for you · Gave up after 5 rounds")
    }

    func testReviewingDetailShowsElapsedMinutes() {
        let startedAt = Date(timeIntervalSince1970: 1_000)
        let pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing, reviewStartedAt: 1_000_000)

        let text = PullRequestDetail.text(for: pullRequest, now: startedAt.addingTimeInterval(6 * 60 + 10))

        XCTAssertEqual(text, "Reviewing · 6 min")
    }

    func testRoundTextSpellsOutTheRound() {
        let pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing)

        XCTAssertEqual(PullRequestDetail.roundText(for: pullRequest), "Round 3 of 5")
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
