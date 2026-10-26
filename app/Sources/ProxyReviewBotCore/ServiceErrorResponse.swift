public struct ServiceErrorResponse: Codable, Equatable, Sendable {
    public var error: String
    public var reason: String?
}
