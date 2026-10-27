public enum DraftGoneMessage {
    public static func text(for pullRequest: PullRequest?) -> String {
        switch pullRequest?.status {
        case .waitingOnAuthor, .queued, .reviewing, .needsReview:
            return "New commits arrived — a new draft is on its way"
        default:
            return "This draft is no longer needed"
        }
    }
}
