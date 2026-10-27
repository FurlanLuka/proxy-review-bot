public enum AppRoute: Hashable, Sendable {
    case draft(pullRequestID: Int)
    case history
    case settings

    public static func path(opening route: AppRoute) -> [AppRoute] {
        [route]
    }

    public static func path(forNoticeIdentifier identifier: String) -> [AppRoute] {
        NotificationCandidate.draftPullRequestID(fromKey: identifier).map { [.draft(pullRequestID: $0)] } ?? []
    }
}
