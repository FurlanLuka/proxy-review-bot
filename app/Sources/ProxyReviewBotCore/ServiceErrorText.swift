public enum ServiceErrorText {
    public static func message(statusCode: Int, code: String?, reason: String? = nil, subject: String) -> String? {
        switch (statusCode, code) {
        case (_, "head_moved"):
            return "New commits arrived on \(subject) — this draft is out of date"
        case (_, "not_awaiting_approval"):
            return "Nothing is awaiting approval on \(subject) anymore"
        case (_, "no_draft"):
            return "There's no draft review for \(subject) anymore"
        case (_, "invalid_draft"):
            return reason.map { "Can't post yet: \($0)" } ?? "The service rejected the edited review"
        case (_, "busy"):
            return "A review is already running on \(subject), try again in a moment"
        case (_, "invalid_link"):
            return "That isn't a GitHub PR link"
        case (_, "unsupported_host"):
            return "Only github.com PRs are supported"
        case (_, "pr_not_found"):
            return "Can't find that PR, or your gh login can't see it"
        case (_, "no_access"):
            return "GitHub refused access (SSO or rate limit)"
        case (_, "pr_closed"):
            return reason == "merged" ? "That PR is already merged" : "That PR is already closed"
        case (_, "github_unavailable"):
            return "GitHub isn't reachable right now"
        case (_, "own_pr"):
            return "You can only comment on your own PR"
        case (404, _):
            return "The bot is no longer tracking \(subject)"
        default:
            return nil
        }
    }
}
