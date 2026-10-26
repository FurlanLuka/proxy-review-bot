import ProxyReviewBotCore
import SwiftUI

struct MenuHeaderView: View {
    let state: BotState?
    let connection: ServiceConnection

    var body: some View {
        HStack {
            Text("Proxy Review Bot")
                .font(.headline)

            Spacer()

            HStack(spacing: 4) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)

                Text(statusText)
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        }
    }

    private var statusText: String {
        switch connection {
        case .starting:
            return "Starting…"
        case .unavailable(let message):
            return message
        case .connected:
            break
        }

        guard let state else {
            return "Starting…"
        }

        let modeText = state.settings.reviewMode == .auto ? "Auto" : "Manual"

        switch state.readiness.status {
        case .setupNeeded:
            return "Setup needed"
        case .checking:
            return "\(modeText) · checking"
        case .ready, .unknown:
            return state.isPaused ? "\(modeText) · paused" : "\(modeText) · running"
        }
    }

    private var statusColor: Color {
        guard connection == .connected, let state else {
            return .gray
        }

        if state.readiness.status == .setupNeeded || state.usageLimitedUntil != nil {
            return .orange
        }

        return state.isPaused ? .yellow : .green
    }
}
