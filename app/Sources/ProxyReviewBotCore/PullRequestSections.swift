public struct PullRequestSections: Equatable, Sendable {
    public let needsReview: [PullRequest]
    public let needsYou: [PullRequest]
    public let inReview: [PullRequest]

    public init(pullRequests: [PullRequest]) {
        let waitingOnYou = pullRequests.filter { $0.status.isWaitingOnYou }

        needsReview = pullRequests.filter { $0.status == .needsReview }
        needsYou = waitingOnYou.filter { $0.status == .draftReady } + waitingOnYou.filter { $0.status != .draftReady }
        inReview = pullRequests.filter { $0.status.isInReview }
    }

    public static func attentionCount(of pullRequests: [PullRequest]) -> Int {
        pullRequests.filter { $0.status.needsAttention }.count
    }
}
