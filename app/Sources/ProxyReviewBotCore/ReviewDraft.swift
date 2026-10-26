public struct ReviewDraftComment: Codable, Equatable, Sendable {
    public var path: String
    public var line: Int
    public var side: String
    public var body: String

    public var location: String {
        "\(path):\(line)"
    }
}

public struct ReviewDraftFileComment: Codable, Equatable, Sendable {
    public var path: String
    public var body: String
}

public struct ReviewDraft: Codable, Equatable, Sendable {
    public var headSha: String
    public var filing: DraftFiling
    public var summary: String
    public var mainReview: String
    public var comments: [ReviewDraftComment]
    public var fileComments: [ReviewDraftFileComment]
    public var coverage: String?
}
