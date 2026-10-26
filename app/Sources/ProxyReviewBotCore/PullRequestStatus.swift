public enum PullRequestStatus: String, Codable, Sendable {
    case needsReview = "needs_review"
    case queued
    case reviewing
    case waitingOnAuthor = "waiting_on_author"
    case awaitingApproval = "awaiting_approval"
    case draftReady = "draft_ready"
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
        isWaitingOnYou || self == .needsReview
    }

    public var isWaitingOnYou: Bool {
        self == .draftReady || self == .awaitingApproval || self == .needsYou
    }

    public var hasDraft: Bool {
        self == .draftReady || self == .awaitingApproval
    }

    public var isInReview: Bool {
        self == .queued || self == .reviewing || self == .waitingOnAuthor || self == .blocked
    }

    public var isStoppable: Bool {
        self != .done && self != .stopped && self != .unknown
    }

    public var displayName: String {
        switch self {
        case .needsReview:
            return "Needs review"
        case .awaitingApproval:
            return "Ready to approve"
        case .draftReady:
            return "Draft ready"
        case .needsYou:
            return "Needs you"
        case .queued:
            return "Queued"
        case .reviewing:
            return "Reviewing"
        case .waitingOnAuthor:
            return "Waiting on author"
        case .blocked:
            return "Blocked"
        case .done:
            return "Done"
        case .stopped:
            return "Stopped"
        case .unknown:
            return "Unknown"
        }
    }
}
