public struct Readiness: Codable, Equatable, Sendable {
    public var status: ReadinessStatus
    public var checks: [ReadinessCheck]

    public var failingChecks: [ReadinessCheck] {
        checks.filter { !$0.isOk }
    }
}

public struct ReadinessCheck: Codable, Equatable, Identifiable, Sendable {
    public var name: String
    public var isOk: Bool
    public var label: String
    public var fix: String?

    public var id: String {
        name
    }
}

public enum ReadinessStatus: String, Codable, Sendable {
    case ready
    case setupNeeded = "setup_needed"
    case checking
    case unknown

    public init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)
        self = ReadinessStatus(rawValue: rawValue) ?? .unknown
    }
}
