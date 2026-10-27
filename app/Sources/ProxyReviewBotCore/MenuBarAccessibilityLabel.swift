public enum MenuBarAccessibilityLabel {
    public static let appName = "Proxy Review Bot"

    public static func text(for state: BotState?, attentionCount: Int) -> String {
        [appName, conditionText(for: state), attentionText(for: attentionCount)]
            .compactMap { $0 }
            .joined(separator: ", ")
    }

    public static func toolTip(for state: BotState?, attentionCount: Int) -> String {
        let countText = attentionCount == 0
            ? "Nothing needs your action"
            : "\(attentionText(for: attentionCount) ?? ""): waiting for you or ready to review"

        return [appName, conditionText(for: state), countText]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    private static func conditionText(for state: BotState?) -> String? {
        guard let state else {
            return nil
        }

        if state.readiness.status == .setupNeeded {
            return "setup needed"
        }

        if state.usageLimitedUntil != nil {
            return "usage limit"
        }

        return state.isPaused ? "paused" : nil
    }

    private static func attentionText(for attentionCount: Int) -> String? {
        switch attentionCount {
        case 0:
            return nil
        case 1:
            return "1 PR needs your action"
        default:
            return "\(attentionCount) PRs need your action"
        }
    }
}
