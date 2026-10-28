import XCTest
@testable import ProxyReviewBotCore

final class StartManuallyTests: XCTestCase {
    func testBranchPairAcceptsEachSeparatorAndShowsAnArrow() {
        for text in ["develop → master", "develop->master", " develop : master ", "develop -> master"] {
            XCTAssertEqual(BranchPair(text: text), BranchPair(head: "develop", base: "master"), text)
            XCTAssertEqual(BranchPair.normalize(text), "develop → master", text)
        }

        XCTAssertEqual(BranchPair.normalize("release/1.2 -> main"), "release/1.2 → main")
    }

    func testBranchPairRejectsTextThatIsNotTwoBranchNames() {
        for text in ["develop", "develop →", "→ master", "develop → master → main", "my branch → master", "a -> b:c"] {
            XCTAssertNil(BranchPair(text: text), text)
        }
    }

    func testBranchPairTextParsesBackToTheSamePair() {
        let pairs = [
            BranchPair(head: "develop", base: "master"),
            BranchPair(head: "develop", base: "main"),
            BranchPair(head: "release/1.2", base: "main"),
        ]

        for pair in pairs {
            XCTAssertEqual(BranchPair(text: pair.text), pair, pair.text)
        }
    }

    func testDifferentlyTypedPairsNormalizeToTheSameEntry() {
        let entries = ["develop->master", "develop → master", "develop:master"].compactMap(BranchPair.normalize)

        XCTAssertEqual(Set(entries), ["develop → master"])
    }

    func testWaitingReleasePullRequestNamesItsBranchesAndCountsInTheBadge() {
        var release = Fixtures.pullRequest(id: 1, status: .needsReview)
        release.headRefName = "develop"
        release.baseRefName = "master"
        release.isManualStart = true

        XCTAssertEqual(PullRequestDetail.text(for: release, now: Date()), "develop → master · starts when you click Review")
        XCTAssertEqual(PullRequestSections(pullRequests: [release]).readyToReview.map(\.id), [1])
        XCTAssertEqual(PullRequestSections.attentionCount(of: [release]), 1)

        release.isStarted = true

        XCTAssertEqual(PullRequestDetail.text(for: release, now: Date()), "Up next · develop → master · starts when you click Review")
        XCTAssertEqual(PullRequestSections(pullRequests: [release]).inReview.map(\.reviewStep), [.upNext])
        XCTAssertEqual(PullRequestSections.attentionCount(of: [release]), 1)
    }

    func testReleasePullRequestFromTheServiceDecodesAsWaitingForManualStart() throws {
        let pullRequestJSON = """
        {
            "id": 1, "owner": "acme", "repo": "api", "number": 7, "title": "Release",
            "url": "https://github.com/acme/api/pull/7", "author": "ana", "status": "needs_review",
            "rounds": 0, "maxRounds": 5, "additions": 1, "deletions": 1, "headSha": "abc",
            "updatedAt": 1793015179000, "headRefName": "develop", "baseRefName": "master", "isManualStart": true
        }
        """
        let pullRequest = try JSONDecoder().decode(PullRequest.self, from: Data(pullRequestJSON.utf8))

        XCTAssertTrue(pullRequest.isWaitingForManualStart)
        XCTAssertEqual(pullRequest.branchesText, "develop → master")
    }

    func testOlderServiceWithoutTheNewFieldsDecodes() throws {
        let pullRequestJSON = """
        {
            "id": 1, "owner": "acme", "repo": "api", "number": 7, "title": "Release",
            "url": "https://github.com/acme/api/pull/7", "author": "ana", "status": "needs_review",
            "rounds": 0, "maxRounds": 5, "additions": 1, "deletions": 1, "headSha": "abc",
            "updatedAt": 1793015179000
        }
        """
        let pullRequest = try JSONDecoder().decode(PullRequest.self, from: Data(pullRequestJSON.utf8))

        XCTAssertNil(pullRequest.headRefName)
        XCTAssertFalse(pullRequest.isWaitingForManualStart)
        XCTAssertEqual(PullRequestDetail.text(for: pullRequest, now: Date()), "Requested by @ana")
    }

    func testSettingsDecodeTheBranchListAndLeaveItOutWhenMissing() throws {
        let settingsJSON = """
        {
            "reviewMode": "auto", "postReviews": "ask", "autoApprove": "off", "smallPullRequestLineLimit": 200,
            "maxRounds": 5, "pollIntervalSeconds": 60, "answerQuestions": true, "watch": [], "skip": [],
            "toolPaths": { "claude": null, "gh": null, "git": null }
            %@
        }
        """
        let withList = String(format: settingsJSON, #", "manualStartBranches": [{ "head": "develop", "base": "master" }]"#)
        let withoutList = String(format: settingsJSON, "")

        let decoded = try JSONDecoder().decode(BotSettings.self, from: Data(withList.utf8))
        let older = try JSONDecoder().decode(BotSettings.self, from: Data(withoutList.utf8))
        let encodedOlder = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(older)) as? [String: Any])

        XCTAssertEqual(decoded.manualStartBranches, [BranchPair(head: "develop", base: "master")])
        XCTAssertNil(older.manualStartBranches)
        XCTAssertNil(encodedOlder["manualStartBranches"])
    }
}
