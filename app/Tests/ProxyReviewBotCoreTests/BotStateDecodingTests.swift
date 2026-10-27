import XCTest
@testable import ProxyReviewBotCore

final class BotStateDecodingTests: XCTestCase {
    private let stateJSON = """
    {
        "viewerLogin": "FurlanLuka",
        "isPaused": false,
        "usageLimitedUntil": null,
        "readiness": {
            "status": "ready",
            "checks": [
                { "name": "claude_logged_in", "isOk": true, "label": "Claude logged in (max)", "fix": null }
            ]
        },
        "settings": {
            "reviewMode": "manual",
            "postReviews": "auto",
            "autoApprove": "off",
            "smallPullRequestLineLimit": 200,
            "maxRounds": 5,
            "pollIntervalSeconds": 60,
            "answerQuestions": true,
            "watch": ["acme"],
            "skip": ["acme/infra"],
            "toolPaths": { "claude": null, "gh": null, "git": null }
        },
        "pullRequests": [
            {
                "id": 1,
                "owner": "acme",
                "repo": "api",
                "number": 412,
                "title": "Fix auth retry",
                "url": "https://github.com/acme/api/pull/412",
                "author": "ana",
                "status": "awaiting_approval",
                "rounds": 2,
                "maxRounds": 5,
                "additions": 84,
                "deletions": 12,
                "headSha": "abc123",
                "summary": "Retry logic sound, tests cover backoff",
                "reason": null,
                "reviewStartedAt": null,
                "updatedAt": 1793015179000
            },
            {
                "id": 2,
                "owner": "acme",
                "repo": "web",
                "number": 88,
                "title": "Onboarding copy",
                "url": "https://github.com/acme/web/pull/88",
                "author": "ana",
                "status": "some_future_status",
                "rounds": 1,
                "maxRounds": 5,
                "additions": 1,
                "deletions": 1,
                "headSha": "def456",
                "summary": null,
                "reason": null,
                "reviewStartedAt": null,
                "updatedAt": 1793015179000,
                "isStarted": true
            }
        ]
    }
    """

    func testDecodesTheDocumentedState() throws {
        let state = try JSONDecoder().decode(BotState.self, from: Data(stateJSON.utf8))

        XCTAssertEqual(state.readiness.status, .ready)
        XCTAssertEqual(state.settings.reviewMode, .manual)
        XCTAssertEqual(state.settings.postReviews, .auto)
        XCTAssertEqual(state.settings.toolPaths, ToolPaths())
        XCTAssertEqual(state.pullRequests.first?.status, .awaitingApproval)
        XCTAssertEqual(state.pullRequests.first?.shortName, "api #412")
        XCTAssertNil(state.usageLimitedUntilDate)
    }

    func testUnknownStatusDecodesAsUnknown() throws {
        let state = try JSONDecoder().decode(BotState.self, from: Data(stateJSON.utf8))

        XCTAssertEqual(state.pullRequests.last?.status, .unknown)
    }

    func testIsStartedDecodesWhenPresentAndDefaultsToNotStarted() throws {
        let state = try JSONDecoder().decode(BotState.self, from: Data(stateJSON.utf8))

        XCTAssertNil(state.pullRequests.first?.isStarted)
        XCTAssertEqual(state.pullRequests.last?.isStarted, true)
    }

    func testToolPathsEncodeNullsExplicitly() throws {
        let data = try JSONEncoder().encode(ToolPaths(claude: "/usr/local/bin/claude"))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(Set(object.keys), ["claude", "gh", "git"])
        XCTAssertTrue(object["gh"] is NSNull)
    }
}
