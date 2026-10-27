public enum PullRequestSource: String, Codable, Equatable, Sendable {
    case requested
    case link
    case unknown

    public init(from decoder: Decoder) throws {
        let rawValue = try decoder.singleValueContainer().decode(String.self)
        self = PullRequestSource(rawValue: rawValue) ?? .unknown
    }
}
