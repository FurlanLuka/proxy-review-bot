import ProxyReviewBotCore

struct StatusItemAppearance {
    let symbolName: String
    let countText: String
    let accessibilityLabel: String
    let toolTip: String

    init(state: BotState?, attentionCount: Int) {
        symbolName = Self.symbolName(for: state)
        countText = attentionCount > 0 ? " \(attentionCount)" : ""
        accessibilityLabel = MenuBarAccessibilityLabel.text(for: state, attentionCount: attentionCount)
        toolTip = MenuBarAccessibilityLabel.toolTip(for: state, attentionCount: attentionCount)
    }

    private static func symbolName(for state: BotState?) -> String {
        guard let state else {
            return "checkmark.bubble"
        }

        if state.readiness.status == .setupNeeded || state.usageLimitedUntil != nil {
            return "exclamationmark.triangle"
        }

        return state.isPaused ? "pause.fill" : "checkmark.bubble"
    }
}
