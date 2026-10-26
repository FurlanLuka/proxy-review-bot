struct NotificationCandidate: Equatable, Sendable {
    static let setupNeededKey = "setup_needed"

    let key: String
    let notice: Notice
    let isPullRequest: Bool

    static func all(pullRequests: [PullRequest], readiness: Readiness) -> [NotificationCandidate] {
        let pullRequestCandidates = pullRequests.compactMap(candidate(for:))

        guard readiness.status == .setupNeeded else {
            return pullRequestCandidates
        }

        return [setupNeededCandidate(for: readiness)] + pullRequestCandidates
    }

    static func key(for pullRequest: PullRequest) -> String {
        "pr-\(pullRequest.id)-\(pullRequest.status.rawValue)-\(pullRequest.headSha)"
    }

    private static func candidate(for pullRequest: PullRequest) -> NotificationCandidate? {
        switch pullRequest.status {
        case .awaitingApproval:
            let summary = pullRequest.summary.map { "\($0)\n" } ?? ""
            let body = "\(summary)\(PullRequestDetail.lineCountText(for: pullRequest)) · round \(pullRequest.rounds)"

            return pullRequestCandidate(
                pullRequest,
                notice: Notice(identifier: key(for: pullRequest), title: "\(pullRequest.shortName) is ready to approve", body: body)
            )
        case .needsYou:
            return pullRequestCandidate(
                pullRequest,
                notice: Notice(identifier: key(for: pullRequest), title: "\(pullRequest.shortName) needs you", body: pullRequest.reason ?? pullRequest.title)
            )
        default:
            return nil
        }
    }

    private static func pullRequestCandidate(_ pullRequest: PullRequest, notice: Notice) -> NotificationCandidate {
        NotificationCandidate(key: key(for: pullRequest), notice: notice, isPullRequest: true)
    }

    private static func setupNeededCandidate(for readiness: Readiness) -> NotificationCandidate {
        let failingLabels = readiness.failingChecks.map(\.label)
        let body = failingLabels.isEmpty ? "Open the menu to see what's missing" : failingLabels.joined(separator: "\n")

        return NotificationCandidate(
            key: setupNeededKey,
            notice: Notice(identifier: setupNeededKey, title: "Setup needed", body: body),
            isPullRequest: false
        )
    }
}
