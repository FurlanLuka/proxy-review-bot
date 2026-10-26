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

    public var shortName: String {
        "\(repo) #\(number)"
    }

    public var hasFailedReview: Bool {
        status == .waitingOnAuthor && reason != nil
    }

    public var reviewAgainAction: ServiceAction? {
        if status == .needsYou {
            return .retry(pullRequestID: id)
        }

        return hasFailedReview ? .review(pullRequestID: id) : nil
    }

    public var isWaitingOnYou: Bool {
        status.isWaitingOnYou || hasFailedReview
    }

    public var isInReview: Bool {
        status.isInReview && !hasFailedReview
    }

    public var retryAtDate: Date? {
        retryAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }

    public var reviewStartedAtDate: Date? {
        reviewStartedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}
