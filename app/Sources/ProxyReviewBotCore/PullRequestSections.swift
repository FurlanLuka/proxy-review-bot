public struct PullRequestSections: Equatable, Sendable {
    public let needsReview: [PullRequest]
    public let needsYou: [PullRequest]
    public let inReview: [PullRequest]

    public init(pullRequests: [PullRequest]) {
        needsReview = pullRequests.filter { $0.status == .needsReview }
        needsYou = pullRequests.filter { $0.status == .awaitingApproval || $0.status == .needsYou }
        inReview = pullRequests.filter { $0.status.isInReview }
    }

    public static func attentionCount(of pullRequests: [PullRequest]) -> Int {
        pullRequests.filter { $0.status.needsAttention }.count
    }
}
