import ProxyReviewBotCore
import SwiftUI

struct MenuBarLabel: View {
    @ObservedObject var model: BotModel

    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: symbolName)

            if model.attentionCount > 0 {
                Text("\(model.attentionCount)")
            }
        }
        .accessibilityElement()
        .accessibilityLabel(MenuBarAccessibilityLabel.text(for: model.state, attentionCount: model.attentionCount))
    }

    private var symbolName: String {
        guard let state = model.state else {
            return "checkmark.bubble"
        }

        if state.readiness.status == .setupNeeded || state.usageLimitedUntil != nil {
            return "exclamationmark.triangle"
        }

        return state.isPaused ? "pause.fill" : "checkmark.bubble"
    }
}
