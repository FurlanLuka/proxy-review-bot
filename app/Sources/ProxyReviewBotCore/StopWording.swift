public struct StopWording: Equatable, Sendable {
    public let buttonTitle: String
    public let confirmTitle: String
    public let actionLabel: String
    public let question: String
    public let symbolName: String

    public init(isReviewStarted: Bool) {
        if isReviewStarted {
            buttonTitle = "Stop"
            confirmTitle = "Stop Reviewing"
            actionLabel = "Stop Reviewing This PR"
            question = "Stop reviewing this PR? The bot picks it up again when someone re-requests your review."
            symbolName = "stop.circle"
        } else {
            buttonTitle = "Skip"
            confirmTitle = "Skip PR"
            actionLabel = "Skip This PR"
            question = "Skip this PR? The bot picks it up again when someone re-requests your review."
            symbolName = "forward.end"
        }
    }
}
