import Foundation

public struct PullRequest: Codable, Equatable, Identifiable, Sendable {
    public var id: Int
    public var owner: String
    public var repo: String
    public var number: Int
    public var title: String
    public var url: URL
    public var author: String?
    public var status: PullRequestStatus
    public var rounds: Int
    public var maxRounds: Int
    public var additions: Int
    public var deletions: Int
    public var headSha: String
    public var summary: String?
    public var reason: String?
    public var retryAt: Double?
    public var reviewStartedAt: Double?
    public var updatedAt: Double
    public var progress: ReviewProgress?
    public var draft: PullRequestDraftSummary?
    public var isStarted: Bool?
    public var isOwn: Bool?
    public var source: PullRequestSource?
    public var isDraft: Bool?

    public var shortName: String {
        "\(repo) #\(number)"
    }

    public var isOwnPullRequest: Bool {
        isOwn == true
    }

    public var isAddedByLink: Bool {
        source == .link
    }

    public var authorText: String? {
        isOwnPullRequest ? "you" : author.map { "@\($0)" }
    }

    public var isWaitingForDraftToBeReady: Bool {
        status == .needsReview && isReviewStarted && isDraft == true
    }

    public var hasFailedReview: Bool {
        status == .waitingOnAuthor && reason != nil
    }

    public var isRetryingFailure: Bool {
        hasFailedReview && retryAt != nil
    }

    public var reviewAgainAction: ServiceAction? {
        if status == .needsYou {
            return .retry(pullRequestID: id)
        }

        return hasFailedReview ? .review(pullRequestID: id) : nil
    }

    public var isReviewStarted: Bool {
        status != .needsReview || isStarted == true
    }

    public var isReadyToReview: Bool {
        status == .needsReview && !isReviewStarted
    }

    public var reviewStep: ReviewStep? {
        if hasFailedReview {
            return isRetryingFailure ? .upNext : .waitingForYou
        }

        switch status {
        case .draftReady, .awaitingApproval, .needsYou:
            return .waitingForYou
        case .reviewing:
            return .reviewing
        case .queued:
            return .queued
        case .needsReview:
            return isReviewStarted ? .upNext : nil
        case .waitingOnAuthor:
            return .waitingOnAuthor
        case .blocked:
            return .blocked
        case .done, .stopped, .unknown:
            return nil
        }
    }

    public var isWaitingOnYou: Bool {
        reviewStep == .waitingForYou
    }

    public var showsRoundCount: Bool {
        reviewStep != nil
    }

    public var retryAtDate: Date? {
        retryAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    public var reviewStartedAtDate: Date? {
        reviewStartedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}
