import Foundation
@testable import ProxyReviewBotCore
import XCTest

final class DraftReviewTests: XCTestCase {
    private let draftJSON = """
    {
        "headSha": "abc123",
        "filing": "approve",
        "summary": "Retry loop never backs off",
        "mainReview": "The retry loop needs a backoff.",
        "comments": [
            { "path": "src/retry.ts", "line": 12, "side": "RIGHT", "body": "No delay between attempts." },
            { "path": "src/retry.ts", "line": 30, "side": "LEFT", "body": "Old branch." }
        ],
        "fileComments": [{ "path": "src/old.ts", "body": "This file can go." }],
        "coverage": "Checked retry paths; couldn't run the tests."
    }
    """

    func testDecodesTheDraftSummaryOnAPullRequest() throws {
        let json = """
        {"id": 1, "owner": "acme", "repo": "api", "number": 412, "title": "t", "url": "https://github.com/acme/api/pull/412", "author": "ana", "status": "draft_ready", "rounds": 1, "maxRounds": 5, "additions": 1, "deletions": 1, "headSha": "a", "summary": null, "reason": null, "reviewStartedAt": null, "updatedAt": 1, "progress": null, "draft": {"filing": "comment", "summary": "Needs a backoff", "commentCount": 3}}
        """

        let pullRequest = try JSONDecoder().decode(PullRequest.self, from: Data(json.utf8))

        XCTAssertEqual(pullRequest.status, .draftReady)
        XCTAssertEqual(pullRequest.draft, PullRequestDraftSummary(filing: .comment, summary: "Needs a backoff", commentCount: 3))
    }

    func testUnknownFilingDecodesAsUnknown() throws {
        let json = #"{"filing": "request_changes", "summary": "s", "commentCount": 0}"#

        let summary = try JSONDecoder().decode(PullRequestDraftSummary.self, from: Data(json.utf8))

        XCTAssertEqual(summary.filing, .unknown)
    }

    func testDecodesTheFullDraft() throws {
        let draft = try JSONDecoder().decode(ReviewDraft.self, from: Data(draftJSON.utf8))

        XCTAssertEqual(draft.filing, .approve)
        XCTAssertEqual(draft.comments.map(\.location), ["src/retry.ts:12", "src/retry.ts:30"])
        XCTAssertEqual(draft.comments.last?.side, "LEFT")
        XCTAssertEqual(draft.fileComments.first?.path, "src/old.ts")
        XCTAssertEqual(draft.coverage, "Checked retry paths; couldn't run the tests.")
    }

    func testPostBodyOmitsExcludedCommentsAndCarriesTheEvent() throws {
        var editableDraft = EditableReviewDraft(draft: try JSONDecoder().decode(ReviewDraft.self, from: Data(draftJSON.utf8)))
        editableDraft.mainReview = "Edited"
        editableDraft.comments[0].item.body = "Edited comment"
        editableDraft.comments[1].isIncluded = false
        editableDraft.fileComments[0].isIncluded = false

        let data = try XCTUnwrap(ServiceAction.postDraft(pullRequestID: 1, request: editableDraft.postRequest).encodedBody())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let comments = try XCTUnwrap(object["comments"] as? [[String: Any]])

        XCTAssertEqual(object["event"] as? String, "APPROVE")
        XCTAssertEqual(object["mainReview"] as? String, "Edited")
        XCTAssertEqual(comments.count, 1)
        XCTAssertEqual(comments.first?["body"] as? String, "Edited comment")
        XCTAssertEqual(comments.first?["line"] as? Int, 12)
        XCTAssertEqual(comments.first?["side"] as? String, "RIGHT")
        XCTAssertEqual((object["fileComments"] as? [Any])?.count, 0)
    }

    func testApproveDraftCanBePostedAsCommentOnly() throws {
        var editableDraft = EditableReviewDraft(draft: try JSONDecoder().decode(ReviewDraft.self, from: Data(draftJSON.utf8)))
        editableDraft.event = .comment

        XCTAssertEqual(editableDraft.postRequest.event, .comment)
    }

    func testCommentDraftAlwaysPostsAsComment() throws {
        var draft = try JSONDecoder().decode(ReviewDraft.self, from: Data(draftJSON.utf8))
        draft.filing = .comment
        var editableDraft = EditableReviewDraft(draft: draft)
        editableDraft.event = .approve

        XCTAssertFalse(editableDraft.canApprove)
        XCTAssertEqual(editableDraft.postRequest.event, .comment)
    }

    func testDraftActionPathsAndMethods() {
        let request = ReviewPostRequest(headSha: "abc", event: .comment, mainReview: "", comments: [], fileComments: [])

        XCTAssertEqual(ServiceAction.fetchDraft(pullRequestID: 7).path, "/prs/7/draft")
        XCTAssertEqual(ServiceAction.fetchDraft(pullRequestID: 7).method, "GET")
        XCTAssertEqual(ServiceAction.postDraft(pullRequestID: 7, request: request).path, "/prs/7/post")
        XCTAssertEqual(ServiceAction.postDraft(pullRequestID: 7, request: request).method, "POST")
        XCTAssertEqual(ServiceAction.discardDraft(pullRequestID: 7).path, "/prs/7/discard")
        XCTAssertEqual(ServiceAction.discardDraft(pullRequestID: 7).method, "POST")
        XCTAssertNil(try ServiceAction.discardDraft(pullRequestID: 7).encodedBody())
    }

    func testDraftReadyDetailText() {
        let commentDraft = Fixtures.pullRequest(
            id: 1,
            status: .draftReady,
            draft: PullRequestDraftSummary(filing: .comment, summary: "s", commentCount: 3)
        )
        let approveDraft = Fixtures.pullRequest(
            id: 2,
            status: .draftReady,
            draft: PullRequestDraftSummary(filing: .approve, summary: "s", commentCount: 1)
        )
        let now = Date()

        XCTAssertEqual(PullRequestDetail.text(for: commentDraft, now: now), "Waiting for you · Draft ready · 3 comments · will comment")
        XCTAssertEqual(PullRequestDetail.text(for: approveDraft, now: now), "Waiting for you · Draft ready · 1 comment · will approve")
        XCTAssertEqual(PullRequestDetail.text(for: Fixtures.pullRequest(id: 3, status: .draftReady), now: now), "Waiting for you · Draft ready")
    }

    func testDraftReadyComesFirstInInReviewAndCountsForAttention() {
        let pullRequests = [
            Fixtures.pullRequest(id: 1, status: .awaitingApproval),
            Fixtures.pullRequest(id: 2, status: .needsYou),
            Fixtures.pullRequest(id: 3, status: .draftReady),
            Fixtures.pullRequest(id: 4, status: .reviewing),
        ]

        let sections = PullRequestSections(pullRequests: pullRequests)

        XCTAssertEqual(sections.inReview.map(\.id), [3, 1, 2, 4])
        XCTAssertEqual(PullRequestSections.attentionCount(of: pullRequests), 3)
        XCTAssertTrue(PullRequestStatus.draftReady.isStoppable)
    }

    func testDraftReadySendsANoticeWithTheDraftSummary() {
        var planner = NotificationPlanner()
        _ = planner.notices(for: [], readiness: Fixtures.readyReadiness)
        let pullRequest = Fixtures.pullRequest(
            id: 12,
            status: .draftReady,
            draft: PullRequestDraftSummary(filing: .comment, summary: "Retry loop never backs off", commentCount: 2)
        )

        let notices = planner.notices(for: [pullRequest], readiness: Fixtures.readyReadiness)

        XCTAssertEqual(notices.map(\.title), ["api #412 has a draft review ready"])
        XCTAssertEqual(notices.first?.body, "Retry loop never backs off\n+84 −12 · round 2")
        XCTAssertEqual(notices.first?.identifier, "pr-12-draft_ready-abc123")
    }

    func testDraftErrorsReadNaturally() {
        XCTAssertEqual(
            ServiceErrorText.message(statusCode: 409, code: "head_moved", subject: "the PR"),
            "New commits arrived on the PR — this draft is out of date"
        )
        XCTAssertEqual(ServiceErrorText.message(statusCode: 409, code: "no_draft", subject: "api #412"), "There's no draft review for api #412 anymore")
        XCTAssertEqual(ServiceErrorText.message(statusCode: 400, code: "invalid_draft", subject: "the PR"), "The service rejected the edited review")
        XCTAssertEqual(
            ServiceErrorText.message(statusCode: 409, code: "busy", subject: "api #412"),
            "A review is already running on api #412, try again in a moment"
        )
        XCTAssertEqual(ServiceErrorText.message(statusCode: 404, code: nil, subject: "api #412"), "The bot is no longer tracking api #412")
        XCTAssertNil(ServiceErrorText.message(statusCode: 500, code: "boom", subject: "api #412"))
    }

    func testPostRequestCarriesTheDraftHead() throws {
        let draft = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"headSha":"head-9","filing":"comment","summary":"s","mainReview":"m","comments":[{"path":"a.ts","line":1,"side":"RIGHT","body":"x"}],"fileComments":[]}"#.utf8))

        XCTAssertEqual(EditableReviewDraft(draft: draft).postRequest.headSha, "head-9")
    }

    func testBlankIncludedCommentBlocksPostingButAnExcludedOneDoesNot() throws {
        let draft = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"headSha":"h","filing":"comment","summary":"s","mainReview":"m","comments":[{"path":"a.ts","line":1,"side":"RIGHT","body":"x"}],"fileComments":[]}"#.utf8))
        var editableDraft = EditableReviewDraft(draft: draft)

        XCTAssertTrue(editableDraft.isPostable)

        editableDraft.comments[0].item.body = "   "
        XCTAssertFalse(editableDraft.isPostable)

        editableDraft.comments[0].isIncluded = false
        XCTAssertTrue(editableDraft.isPostable)
    }

    func testInvalidDraftShowsTheServiceReason() {
        XCTAssertEqual(
            ServiceErrorText.message(statusCode: 400, code: "invalid_draft", reason: "a comment is empty", subject: "the PR"),
            "Can't post yet: a comment is empty"
        )
    }

    func testEventChoicesFollowTheFiling() throws {
        let commentDraft = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"headSha":"h","filing":"comment","summary":"s","mainReview":"m","comments":[],"fileComments":[]}"#.utf8))
        let approveDraft = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"headSha":"h","filing":"approve","summary":"s","mainReview":"m","comments":[],"fileComments":[]}"#.utf8))

        XCTAssertEqual(EditableReviewDraft(draft: commentDraft).availableEvents, [.comment, .requestChanges])
        XCTAssertEqual(EditableReviewDraft(draft: approveDraft).availableEvents, [.approve, .comment, .requestChanges])
    }

    func testRequestChangesIsSentAsIs() throws {
        let draft = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"headSha":"h","filing":"comment","summary":"s","mainReview":"m","comments":[],"fileComments":[]}"#.utf8))
        var editableDraft = EditableReviewDraft(draft: draft)

        editableDraft.event = .requestChanges

        XCTAssertEqual(editableDraft.postRequest.event, .requestChanges)

        editableDraft.event = .approve

        XCTAssertEqual(editableDraft.postRequest.event, .comment)
    }

    func testRequestChangesIsEncodedForTheService() throws {
        var editableDraft = EditableReviewDraft(draft: try JSONDecoder().decode(ReviewDraft.self, from: Data(draftJSON.utf8)))
        editableDraft.event = .requestChanges

        let data = try XCTUnwrap(ServiceAction.postDraft(pullRequestID: 1, request: editableDraft.postRequest).encodedBody())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["event"] as? String, "REQUEST_CHANGES")
    }

    func testRequestChangesNeedsSomeFeedback() throws {
        let draft = try JSONDecoder().decode(ReviewDraft.self, from: Data(#"{"headSha":"h","filing":"comment","summary":"s","mainReview":"m","comments":[{"path":"a.ts","line":1,"side":"RIGHT","body":"Fix"}],"fileComments":[]}"#.utf8))
        var editableDraft = EditableReviewDraft(draft: draft)
        editableDraft.event = .requestChanges
        editableDraft.mainReview = "  "

        XCTAssertTrue(editableDraft.isPostable)

        editableDraft.comments[0].isIncluded = false

        XCTAssertEqual(editableDraft.unpostableReason, "Requesting changes needs a review or a comment")

        editableDraft.event = .comment

        XCTAssertTrue(editableDraft.isPostable)

        editableDraft.event = .requestChanges
        editableDraft.mainReview = "Please fix"

        XCTAssertTrue(editableDraft.isPostable)
    }
}
