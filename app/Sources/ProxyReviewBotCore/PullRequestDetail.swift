import Foundation

public enum PullRequestDetail {
    public static func text(for pullRequest: PullRequest, now: Date) -> String {
        switch pullRequest.status {
        case .needsReview where pullRequest.isWaitingForDraftToBeReady:
            return "Draft PR · reviews when it's ready for review"
        case .needsReview where pullRequest.isReviewStarted:
            return ReviewStep.upNext.label
        case .needsReview:
            return pullRequest.author.map { "Requested by @\($0)" } ?? "Waiting for your go-ahead"
        case .awaitingApproval:
            return waitingForYou(pullRequest.summary.map { "Ready to approve: \($0)" } ?? "Ready to approve")
        case .draftReady:
            return waitingForYou(draftReadyText(for: pullRequest.draft))
        case .needsYou:
            return waitingForYou(pullRequest.reason ?? "Needs you")
        case .queued:
            return "Queued"
        case .reviewing:
            return [
                reviewingText(startedAt: pullRequest.reviewStartedAtDate, now: now),
                pullRequest.progress?.advisorsText,
            ]
            .compactMap { $0 }
            .joined(separator: " · ")
        case .waitingOnAuthor:
            return waitingOnAuthorText(for: pullRequest, now: now)
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
        "Round \(currentRound(of: pullRequest)) of \(pullRequest.maxRounds)"
    }

    private static func currentRound(of pullRequest: PullRequest) -> Int {
        let isRoundInProgress = switch pullRequest.status {
        case .queued, .reviewing, .needsReview, .draftReady, .awaitingApproval:
            true
        default:
            pullRequest.hasFailedReview
        }

        return isRoundInProgress ? min(pullRequest.rounds + 1, pullRequest.maxRounds) : max(pullRequest.rounds, 1)
    }

    public static func lineCountText(for pullRequest: PullRequest) -> String {
        "+\(pullRequest.additions) −\(pullRequest.deletions)"
    }

    private static func draftReadyText(for draft: PullRequestDraftSummary?) -> String {
        guard let draft else {
            return "Draft ready"
        }

        let commentText = draft.commentCount == 1 ? "1 comment" : "\(draft.commentCount) comments"
        let filingText: String? = switch draft.filing {
        case .comment:
            "will comment"
        case .approve:
            "will approve"
        case .unknown:
            nil
        }

        return ["Draft ready", commentText, filingText]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private static func waitingOnAuthorText(for pullRequest: PullRequest, now: Date) -> String {
        if let reason = pullRequest.reason, pullRequest.hasFailedReview {
            guard let retryAt = pullRequest.retryAtDate else {
                return waitingForYou("Review failed: \(reason)")
            }

            let minutes = max(1, Int(ceil(retryAt.timeIntervalSince(now) / 60)))
            let retryText = retryAt > now ? "retrying in \(minutes) min" : "retrying soon"

            return "\(ReviewStep.upNext.label) · \(retryText) · last try failed: \(reason)"
        }

        let label = ReviewStep.waitingOnAuthor.label

        if pullRequest.rounds == 0 {
            return "\(label) · nothing posted yet"
        }

        return pullRequest.summary.map { "\(label) · \($0)" } ?? label
    }

    private static func waitingForYou(_ detail: String) -> String {
        "\(ReviewStep.waitingForYou.label) · \(detail)"
    }

    private static func reviewingText(startedAt: Date?, now: Date) -> String {
        guard let startedAt else {
            return "Reviewing"
        }

        let minutes = max(0, Int(now.timeIntervalSince(startedAt) / 60))

        return "Reviewing · \(minutes) min"
    }
}
