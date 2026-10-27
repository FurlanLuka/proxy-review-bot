import Foundation
@testable import ProxyReviewBotCore
import XCTest

final class AddPullRequestTests: XCTestCase {
    func testAddActionPostsTheLinkToPrs() throws {
        let action = ServiceAction.addPullRequest(url: "https://github.com/acme/api/pull/7")
        let data = try XCTUnwrap(action.encodedBody())
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(action.method, "POST")
        XCTAssertEqual(action.path, "/prs")
        XCTAssertEqual(object["url"] as? String, "https://github.com/acme/api/pull/7")
    }

    func testResponseDecodesIdAndWhetherItWasAlreadyTracked() throws {
        let response = try JSONDecoder().decode(AddPullRequestResponse.self, from: Data(#"{"id":12,"isExisting":true}"#.utf8))

        XCTAssertEqual(response, AddPullRequestResponse(id: 12, isExisting: true))
    }

    func testLinkInputIsTrimmedAndBlankIsNothing() {
        XCTAssertEqual(PullRequestLinkInput.normalized("  https://github.com/acme/api/pull/7 \n"), "https://github.com/acme/api/pull/7")
        XCTAssertNil(PullRequestLinkInput.normalized("   "))
    }

    func testAddErrorsReadAsPlainSentences() {
        let message = { (statusCode: Int, code: String, reason: String?) in
            ServiceErrorText.message(statusCode: statusCode, code: code, reason: reason, subject: "that PR")
        }

        XCTAssertEqual(message(400, "invalid_link", nil), "That isn't a GitHub PR link")
        XCTAssertEqual(message(400, "unsupported_host", nil), "Only github.com PRs are supported")
        XCTAssertEqual(message(403, "no_access", nil), "GitHub refused access (SSO or rate limit)")
        XCTAssertEqual(message(409, "pr_closed", "merged"), "That PR is already merged")
        XCTAssertEqual(message(409, "pr_closed", "closed"), "That PR is already closed")
        XCTAssertEqual(message(502, "github_unavailable", nil), "GitHub isn't reachable right now")
        XCTAssertEqual(message(409, "own_pr", nil), "You can only comment on your own PR")
    }

    func testPrNotFoundIsNotTheGenericNotTrackedMessage() {
        XCTAssertEqual(
            ServiceErrorText.message(statusCode: 404, code: "pr_not_found", subject: "that PR"),
            "Can't find that PR, or your gh login can't see it"
        )
        XCTAssertEqual(
            ServiceErrorText.message(statusCode: 404, code: "not_found", subject: "api #7"),
            "The bot is no longer tracking api #7"
        )
    }
}

final class OwnAndLinkedPullRequestTests: XCTestCase {
    func testOwnPullRequestShowsYouInsteadOfTheLogin() {
        var own = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)
        own.isOwn = true
        let other = Fixtures.pullRequest(id: 2, status: .waitingOnAuthor)

        XCTAssertEqual(own.authorText, "you")
        XCTAssertEqual(other.authorText, "@ana")
    }

    func testMissingNewFieldsDecodeAsRequestedAndNotOwn() throws {
        let pullRequest = Fixtures.pullRequest(id: 1, status: .queued)
        let decoded = try JSONDecoder().decode(PullRequest.self, from: JSONEncoder().encode(pullRequest))

        XCTAssertFalse(decoded.isOwnPullRequest)
        XCTAssertFalse(decoded.isAddedByLink)
    }

    func testSourceDecodesLinkAndToleratesUnknownValues() throws {
        XCTAssertEqual(try JSONDecoder().decode(PullRequestSource.self, from: Data(#""link""#.utf8)), .link)
        XCTAssertEqual(try JSONDecoder().decode(PullRequestSource.self, from: Data(#""future""#.utf8)), .unknown)
    }

    func testStartedDraftPullRequestSaysWhyItIsWaiting() {
        var draftPullRequest = Fixtures.pullRequest(id: 1, status: .needsReview)
        draftPullRequest.isStarted = true
        draftPullRequest.isDraft = true

        XCTAssertEqual(
            PullRequestDetail.text(for: draftPullRequest, now: Date()),
            "Draft PR · reviews when it's ready for review"
        )

        draftPullRequest.isDraft = false

        XCTAssertEqual(PullRequestDetail.text(for: draftPullRequest, now: Date()), ReviewStep.upNext.label)
    }

    func testOwnDraftOnlyOffersComment() throws {
        var draft = try JSONDecoder().decode(
            ReviewDraft.self,
            from: Data(#"{"headSha":"h","filing":"approve","summary":"s","mainReview":"m","comments":[],"fileComments":[],"isOwn":true}"#.utf8)
        )
        var editableDraft = EditableReviewDraft(draft: draft)
        editableDraft.event = .approve

        XCTAssertEqual(editableDraft.availableEvents, [.comment])
        XCTAssertFalse(editableDraft.canApprove)
        XCTAssertEqual(editableDraft.postRequest.event, .comment)

        draft.isOwn = nil

        XCTAssertEqual(EditableReviewDraft(draft: draft).availableEvents, [.approve, .comment, .requestChanges])
    }

    func testHistorySaysYouForTheViewersOwnPullRequestIgnoringCase() throws {
        let entry = try JSONDecoder().decode(
            HistoryEntry.self,
            from: Data(#"{"id":1,"owner":"acme","repo":"api","number":7,"title":"t","url":"https://github.com/acme/api/pull/7","author":"FurlanLuka","outcome":"merged","rounds":2,"finishedAt":1}"#.utf8)
        )

        XCTAssertEqual(entry.subtitle(viewerLogin: "furlanluka"), "api #7 · you")
        XCTAssertEqual(entry.subtitle(viewerLogin: "someone"), "api #7 · @FurlanLuka")
        XCTAssertEqual(entry.subtitle, "api #7 · @FurlanLuka")
    }
}
