import Foundation
@testable import ProxyReviewBotCore
import XCTest

final class ReviewProgressTests: XCTestCase {
    private let progressJSON = """
    {
        "phase": "review",
        "message": "Waiting on advisors",
        "updatedAt": 1793015300000,
        "subagents": [
            {"id": "t1", "agentType": "proxy:architect", "label": "Architecture", "description": "Design", "status": "completed", "currentStep": null, "startedAt": 1793015200000, "finishedAt": 1793015260000},
            {"id": "t2", "agentType": "proxy:test-architect", "label": "Tests", "description": "Coverage", "status": "running", "currentStep": "Running git show", "startedAt": 1793015200000, "finishedAt": null},
            {"id": "t3", "agentType": "x", "label": "x", "description": "Odd", "status": "cancelled", "currentStep": null, "startedAt": 1793015200000, "finishedAt": 1793015210000}
        ]
    }
    """

    func testDecodesProgressAndCountsFinishedAdvisors() throws {
        let progress = try JSONDecoder().decode(ReviewProgress.self, from: Data(progressJSON.utf8))

        XCTAssertEqual(progress.message, "Waiting on advisors")
        XCTAssertEqual(progress.subagents.map(\.status), [.completed, .running, .unknown])
        XCTAssertEqual(progress.advisorsText, "2 of 3 advisors done")
    }

    func testDetailShowsTheCurrentStepWhileRunningAndHidesWhenEmpty() throws {
        var subagents = try JSONDecoder().decode(ReviewProgress.self, from: Data(progressJSON.utf8)).subagents

        XCTAssertEqual(subagents[0].detailText, "Design")
        XCTAssertEqual(subagents[1].detailText, "Running git show")

        subagents[0].description = ""

        XCTAssertNil(subagents[0].detailText)
    }

    func testDurationUsesFinishTimeOrNow() throws {
        let progress = try JSONDecoder().decode(ReviewProgress.self, from: Data(progressJSON.utf8))
        let now = Date(timeIntervalSince1970: 1_793_015_290)

        XCTAssertEqual(progress.subagents[0].durationText(now: now), "1 min")
        XCTAssertEqual(progress.subagents[1].durationText(now: now), "1 min")
        XCTAssertEqual(progress.subagents[2].durationText(now: now), "10s")
    }

    func testReviewingRowShowsAdvisorsCount() throws {
        var pullRequest = Fixtures.pullRequest(id: 1, status: .reviewing, reviewStartedAt: 1_793_015_200_000)
        pullRequest.progress = try JSONDecoder().decode(ReviewProgress.self, from: Data(progressJSON.utf8))

        let text = PullRequestDetail.text(for: pullRequest, now: Date(timeIntervalSince1970: 1_793_015_620))

        XCTAssertEqual(text, "Reviewing · 7 min · 2 of 3 advisors done")
    }

    func testPullRequestWithoutProgressFieldStillDecodes() throws {
        let json = """
        {"id": 1, "owner": "acme", "repo": "api", "number": 1, "title": "t", "url": "https://github.com/acme/api/pull/1", "author": "ana", "status": "queued", "rounds": 0, "maxRounds": 5, "additions": 1, "deletions": 1, "headSha": "a", "summary": null, "reason": null, "reviewStartedAt": null, "updatedAt": 1}
        """
        let pullRequest = try JSONDecoder().decode(PullRequest.self, from: Data(json.utf8))

        XCTAssertNil(pullRequest.progress)
    }
}
