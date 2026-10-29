import Foundation

public struct BotState: Codable, Equatable, Sendable {
    public var viewerLogin: String?
    public var isPaused: Bool
    public var usageLimitedUntil: Double?
    public var readiness: Readiness
    public var settings: BotSettings
    public var pullRequests: [PullRequest]
    public var update: UpdateState?

    public var usageLimitedUntilDate: Date? {
        usageLimitedUntil.map { Date(timeIntervalSince1970: $0 / 1000) }
    }
}
