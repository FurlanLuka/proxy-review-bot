import Foundation

public enum PullRequestDetail {
    public static func text(for pullRequest: PullRequest, now: Date) -> String {
        switch pullRequest.status {
        case .needsReview:
            return pullRequest.author.map { "Requested by @\($0)" } ?? "Waiting for your go-ahead"
        case .awaitingApproval:
            return pullRequest.summary.map { "Ready to approve: \($0)" } ?? "Ready to approve"
        case .needsYou:
            return pullRequest.reason ?? "Needs you"
        case .queued:
            return "Queued"
        case .reviewing:
            return reviewingText(startedAt: pullRequest.reviewStartedAtDate, now: now)
        case .waitingOnAuthor:
            return pullRequest.summary.map { "Waiting on author · \($0)" } ?? "Waiting on author"
        case .blocked:
            return pullRequest.reason.map { "Blocked: \($0)" } ?? "Blocked"
        case .done:
            return "Done"
        case .stopped:
            return "Stopped"
        case .unknown:
            return pullRequest.summary ?? ""
        }
    }

    public static func roundText(for pullRequest: PullRequest) -> String {
        "round \(pullRequest.rounds)/\(pullRequest.maxRounds)"
    }

    public static func lineCountText(for pullRequest: PullRequest) -> String {
        "+\(pullRequest.additions) −\(pullRequest.deletions)"
    }

    private static func reviewingText(startedAt: Date?, now: Date) -> String {
        guard let startedAt else {
            return "Reviewing"
        }

        let minutes = max(0, Int(now.timeIntervalSince(startedAt) / 60))

        return "Reviewing · \(minutes) min"
    }
}
