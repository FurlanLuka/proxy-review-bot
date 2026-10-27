import Foundation

public enum ServiceAction: Equatable, Sendable {
    case review(pullRequestID: Int)
    case approve(pullRequestID: Int)
    case stop(pullRequestID: Int)
    case retry(pullRequestID: Int)
    case fetchDraft(pullRequestID: Int)
    case fetchHistory
    case postDraft(pullRequestID: Int, request: ReviewPostRequest)
    case discardDraft(pullRequestID: Int)
    case pause
    case resume
    case checkReadiness
    case addPullRequest(url: String)

    public var method: String {
        switch self {
        case .fetchDraft, .fetchHistory:
            return "GET"
        default:
            return "POST"
        }
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
        case .fetchHistory:
            return "/history"
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
        case .addPullRequest:
            return "/prs"
        }
    }

    public func encodedBody() throws -> Data? {
        switch self {
        case .postDraft(_, let request):
            return try JSONEncoder().encode(request)
        case .addPullRequest(let url):
            return try JSONEncoder().encode(["url": url])
        default:
            return nil
        }
    }
}
