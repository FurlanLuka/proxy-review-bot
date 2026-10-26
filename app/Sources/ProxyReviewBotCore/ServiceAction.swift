import Foundation

public enum ServiceAction: Equatable, Sendable {
    case review(pullRequestID: Int)
    case approve(pullRequestID: Int)
    case stop(pullRequestID: Int)
    case retry(pullRequestID: Int)
    case fetchDraft(pullRequestID: Int)
    case postDraft(pullRequestID: Int, request: ReviewPostRequest)
    case discardDraft(pullRequestID: Int)
    case pause
    case resume
    case checkReadiness

    public var method: String {
        if case .fetchDraft = self {
            return "GET"
        }

        return "POST"
    }

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
        case .fetchDraft(let pullRequestID):
            return "/prs/\(pullRequestID)/draft"
        case .postDraft(let pullRequestID, _):
            return "/prs/\(pullRequestID)/post"
        case .discardDraft(let pullRequestID):
            return "/prs/\(pullRequestID)/discard"
        case .pause:
            return "/pause"
        case .resume:
            return "/resume"
        case .checkReadiness:
            return "/readiness/check"
        }
    }

    public func encodedBody() throws -> Data? {
        guard case .postDraft(_, let request) = self else {
            return nil
        }

        return try JSONEncoder().encode(request)
    }
}
