public struct BotSettings: Codable, Equatable, Sendable {
    public var reviewMode: ReviewMode
    public var postReviews: PostReviewsMode
    public var autoApprove: AutoApproveMode
    public var smallPullRequestLineLimit: Int
    public var maxRounds: Int
    public var pollIntervalSeconds: Int
    public var answerQuestions: Bool
    public var watch: [String]
    public var skip: [String]
    public var toolPaths: ToolPaths
    public var manualStartBranches: [BranchPair]?
    public var claudeModel: String?
    public var autoUpdate: Bool?
}

public enum ReviewMode: String, Codable, CaseIterable, Sendable {
    case manual
    case auto
}

public enum PostReviewsMode: String, Codable, CaseIterable, Sendable {
    case ask
    case auto
}

public enum AutoApproveMode: String, Codable, CaseIterable, Sendable {
    case off
    case on
    case small
}

extension BotSettings {
    public var flowText: String {
        switch (reviewMode, postReviews) {
        case (.manual, .ask):
            return "You start reviews and post each draft"
        case (.manual, .auto):
            return "You start reviews, they post on their own"
        case (.auto, .ask):
            return "Reviews start on their own, you post each draft"
        case (.auto, .auto):
            return "Reviews start and post on their own"
        }
    }
}
