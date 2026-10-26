public struct ToolPaths: Codable, Equatable, Sendable {
    public var claude: String?
    public var gh: String?
    public var git: String?

    private enum CodingKeys: String, CodingKey {
        case claude
        case gh
        case git
    }

    public init(claude: String? = nil, gh: String? = nil, git: String? = nil) {
        self.claude = claude
        self.gh = gh
        self.git = git
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(claude, forKey: .claude)
        try container.encode(gh, forKey: .gh)
        try container.encode(git, forKey: .git)
    }
}
