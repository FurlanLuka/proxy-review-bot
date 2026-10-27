public enum ReviewStep: Int, Comparable, Sendable {
    case waitingForYou
    case reviewing
    case queued
    case upNext
    case waitingOnAuthor
    case blocked

    public static func < (left: ReviewStep, right: ReviewStep) -> Bool {
        left.rawValue < right.rawValue
    }

    public var label: String {
        switch self {
        case .waitingForYou:
            return "Waiting for you"
        case .reviewing:
            return "Reviewing"
        case .queued:
            return "Queued"
        case .upNext:
            return "Up next"
        case .waitingOnAuthor:
            return "Waiting on author"
        case .blocked:
            return "Blocked"
        }
    }
}
