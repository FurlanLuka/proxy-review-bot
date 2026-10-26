public enum PullRequestGlyph: Equatable, Sendable {
    case status(PullRequestStatus)
    case failedReview

    public var accessibilityLabel: String {
        switch self {
        case .status(let status):
            return status.displayName
        case .failedReview:
            return "Review failed"
        }
    }
}

extension PullRequest {
    public var glyph: PullRequestGlyph {
        hasFailedReview ? .failedReview : .status(status)
    }
}
