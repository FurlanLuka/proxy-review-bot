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
    public var reviewStartedAt: Double?
    public var updatedAt: Double
    public var progress: ReviewProgress?
    public var draft: PullRequestDraftSummary?

    public var shortName: String {
        "\(repo) #\(number)"
    }

    public var reviewStartedAtDate: Date? {
        reviewStartedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}
