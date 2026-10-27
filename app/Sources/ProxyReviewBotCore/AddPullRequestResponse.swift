public struct AddPullRequestResponse: Codable, Equatable, Sendable {
    public var id: Int
    public var isExisting: Bool

    public init(id: Int, isExisting: Bool) {
        self.id = id
        self.isExisting = isExisting
    }
}
