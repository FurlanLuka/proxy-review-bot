import Foundation
@testable import ProxyReviewBotCore

enum Fixtures {
    static let readyReadiness = Readiness(status: .ready, checks: [])

    static let setupNeededReadiness = Readiness(
        status: .setupNeeded,
        checks: [ReadinessCheck(name: "claude_logged_in", isOk: false, label: "Claude isn't logged in", fix: "claude auth login")]
    )

    static func pullRequest(
        id: Int,
        status: PullRequestStatus = .awaitingApproval,
        headSha: String = "abc123",
        reviewStartedAt: Double? = nil,
        draft: PullRequestDraftSummary? = nil
    ) -> PullRequest {
        PullRequest(
            id: id,
            owner: "acme",
            repo: "api",
            number: 400 + id,
            title: "Change \(id)",
            url: URL(string: "https://github.com/acme/api/pull/\(400 + id)")!,
            author: "ana",
            status: status,
            rounds: 2,
            maxRounds: 5,
            additions: 84,
            deletions: 12,
            headSha: headSha,
            summary: "Retry logic sound",
            reason: status == .needsYou ? "Gave up after 5 rounds" : nil,
            reviewStartedAt: reviewStartedAt,
            updatedAt: 1_793_015_179_000,
            draft: draft
        )
    }
}
