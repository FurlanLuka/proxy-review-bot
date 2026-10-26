public struct BotSettings: Codable, Equatable, Sendable {
    public var reviewMode: ReviewMode
    public var autoApprove: AutoApproveMode
    public var smallPullRequestLineLimit: Int
    public var maxRounds: Int
    public var pollIntervalSeconds: Int
    public var answerQuestions: Bool
    public var watch: [String]
    public var skip: [String]
    public var toolPaths: ToolPaths
}

public enum ReviewMode: String, Codable, CaseIterable, Sendable {
    case manual
    case auto
}

public enum AutoApproveMode: String, Codable, CaseIterable, Sendable {
    case off
    case on
    case small
}
