public struct PullRequestSections: Equatable, Sendable {
    public let readyToReview: [PullRequest]
    public let inReview: [PullRequest]

    public init(pullRequests: [PullRequest]) {
        readyToReview = pullRequests.filter(\.isReadyToReview)
        inReview = pullRequests.enumerated()
            .compactMap { offset, pullRequest in
                pullRequest.reviewStep.map { (rank: Self.rank(of: pullRequest, step: $0), offset: offset, pullRequest: pullRequest) }
            }
            .sorted { ($0.rank, $0.offset) < ($1.rank, $1.offset) }
            .map(\.pullRequest)
    }

    public var isEmpty: Bool {
        readyToReview.isEmpty && inReview.isEmpty
    }

    public static func attentionCount(of pullRequests: [PullRequest]) -> Int {
        pullRequests.filter { $0.isWaitingOnYou || $0.isReadyToReview || $0.isWaitingForManualStart }.count
    }

    private static func rank(of pullRequest: PullRequest, step: ReviewStep) -> Int {
        let isDraftFirst = step == .waitingForYou && pullRequest.status == .draftReady

        return step.rawValue * 2 + (isDraftFirst ? 0 : 1)
    }
}
