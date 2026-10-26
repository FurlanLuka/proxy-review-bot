public enum ServiceAction: Equatable, Sendable {
    case review(pullRequestID: Int)
    case approve(pullRequestID: Int)
    case stop(pullRequestID: Int)
    case retry(pullRequestID: Int)
    case pause
    case resume
    case checkReadiness

    public var path: String {
        switch self {
        case .review(let pullRequestID):
            return "/prs/\(pullRequestID)/review"
        case .approve(let pullRequestID):
            return "/prs/\(pullRequestID)/approve"
        case .stop(let pullRequestID):
            return "/prs/\(pullRequestID)/stop"
        case .retry(let pullRequestID):
            return "/prs/\(pullRequestID)/retry"
        case .pause:
            return "/pause"
        case .resume:
            return "/resume"
        case .checkReadiness:
            return "/readiness/check"
        }
    }
}
