public struct NotificationPlanner: Sendable {
    public static let missedPollsBeforeForgetting = 2

    public private(set) var notifiedKeys: Set<String>?
    private var missedPollsByKey: [String: Int] = [:]

    public init(notifiedKeys: Set<String>? = nil) {
        self.notifiedKeys = notifiedKeys
    }

    public mutating func notices(for pullRequests: [PullRequest], readiness: Readiness) -> [Notice] {
        let candidates = NotificationCandidate.all(pullRequests: pullRequests, readiness: readiness)
        let currentKeys = Set(candidates.map(\.key))

        guard let previousKeys = notifiedKeys else {
            notifiedKeys = currentKeys

            return Self.launchNotices(for: candidates)
        }

        let newNotices = candidates
            .filter { !previousKeys.contains($0.key) }
            .map(\.notice)

        notifiedKeys = currentKeys.union(retainedKeys(missingKeys: previousKeys.subtracting(currentKeys)))

        return newNotices
    }

    private mutating func retainedKeys(missingKeys: Set<String>) -> Set<String> {
        var retainedKeys = Set<String>()
        var updatedMissedPollsByKey: [String: Int] = [:]

        for key in missingKeys {
            let missedPolls = (missedPollsByKey[key] ?? 0) + 1

            if missedPolls < Self.missedPollsBeforeForgetting {
                retainedKeys.insert(key)
                updatedMissedPollsByKey[key] = missedPolls
            }
        }

        missedPollsByKey = updatedMissedPollsByKey

        return retainedKeys
    }

    private static func launchNotices(for candidates: [NotificationCandidate]) -> [Notice] {
        guard candidates.count > 1 else {
            return candidates.map(\.notice)
        }

        let pullRequestCount = candidates.filter(\.isPullRequest).count
        let isSetupNeeded = candidates.contains { !$0.isPullRequest }
        let title = pullRequestCount == 1 ? "1 PR needs you" : "\(pullRequestCount) PRs need you"
        let body = isSetupNeeded ? "Setup is also needed. Open the menu for details." : "Open the menu to see them."

        return [Notice(identifier: "launch-summary", title: title, body: body)]
    }
}
