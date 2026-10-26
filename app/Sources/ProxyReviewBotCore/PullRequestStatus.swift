public enum PullRequestStatus: String, Codable, Sendable {
    case needsReview = "needs_review"
    case queued
    case reviewing
    case waitingOnAuthor = "waiting_on_author"
    case awaitingApproval = "awaiting_approval"
    case blocked
    case needsYou = "needs_you"
    case done
    case stopped
    case unknown

    public init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)
        self = PullRequestStatus(rawValue: rawValue) ?? .unknown
    }

    public var needsAttention: Bool {
        self == .awaitingApproval || self == .needsYou || self == .needsReview
    }

    public var isInReview: Bool {
        self == .queued || self == .reviewing || self == .waitingOnAuthor || self == .blocked
    }

    public var isStoppable: Bool {
        self != .done && self != .stopped && self != .unknown
    }
}
