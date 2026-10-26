import Foundation

public enum SubagentStatus: String, Codable, Equatable, Sendable {
    case running
    case completed
    case failed
    case unknown

    public init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)

        self = SubagentStatus(rawValue: rawValue) ?? .unknown
    }
}

public struct SubagentProgress: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var agentType: String
    public var label: String
    public var description: String
    public var status: SubagentStatus
    public var currentStep: String?
    public var startedAt: Double
    public var finishedAt: Double?

    public func durationText(now: Date) -> String {
        let endMilliseconds = finishedAt ?? now.timeIntervalSince1970 * 1000
        let seconds = max(0, Int((endMilliseconds - startedAt) / 1000))

        return seconds < 60 ? "\(seconds)s" : "\(seconds / 60) min"
    }
}

public struct ReviewProgress: Codable, Equatable, Sendable {
    public var phase: String?
    public var message: String?
    public var subagents: [SubagentProgress]
    public var updatedAt: Double

    public var finishedSubagentCount: Int {
        subagents.filter { $0.status != .running }.count
    }

    public var advisorsText: String? {
        subagents.isEmpty ? nil : "\(finishedSubagentCount) of \(subagents.count) advisors done"
    }
}
