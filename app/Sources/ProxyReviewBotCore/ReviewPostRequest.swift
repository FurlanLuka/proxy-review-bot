public enum ReviewEvent: String, Codable, CaseIterable, Sendable {
    case comment = "COMMENT"
    case approve = "APPROVE"
    case requestChanges = "REQUEST_CHANGES"

    public var title: String {
        switch self {
        case .approve:
            return "Approve"
        case .comment:
            return "Comment"
        case .requestChanges:
            return "Request Changes"
        }
    }
}

public struct ReviewPostRequest: Codable, Equatable, Sendable {
    public var headSha: String
    public var event: ReviewEvent
    public var mainReview: String
    public var comments: [ReviewDraftComment]
    public var fileComments: [ReviewDraftFileComment]
}
