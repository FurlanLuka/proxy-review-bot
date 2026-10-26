public enum DraftFiling: String, Codable, Sendable {
    case comment
    case approve
    case unknown

    public init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)
        self = DraftFiling(rawValue: rawValue) ?? .unknown
    }

    public var defaultEvent: ReviewEvent {
        self == .approve ? .approve : .comment
    }
}

public struct PullRequestDraftSummary: Codable, Equatable, Sendable {
    public var filing: DraftFiling
    public var summary: String
    public var commentCount: Int

    public init(filing: DraftFiling, summary: String, commentCount: Int) {
        self.filing = filing
        self.summary = summary
        self.commentCount = commentCount
    }
}
