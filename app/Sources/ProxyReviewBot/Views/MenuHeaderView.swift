import ProxyReviewBotCore
import SwiftUI

struct MenuHeaderView: View {
    let state: BotState?
    let connection: ServiceConnection

    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        HStack(spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: MenuStyle.innerCornerRadius, style: .continuous)
                    .fill(LinearGradient(colors: [Palette.lavender.tint, Palette.sky.tint], startPoint: .topLeading, endPoint: .bottomTrailing))

                Image(systemName: "checkmark.bubble.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(colorScheme == .dark ? Color.black.opacity(0.55) : Color.white)
            }
            .frame(width: 30, height: 30)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 1) {
                Text(MenuBarAccessibilityLabel.appName)
                    .font(MenuStyle.titleFont)

                Text(modeText)
                    .font(MenuStyle.metaFont)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if !isStatusShownInBanner {
                statusCapsule
            }
        }
    }

    private var statusCapsule: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(statusColor.ink)
                .frame(width: 7, height: 7)

            Text(statusText)
                .font(.system(size: 11, weight: .medium))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(Capsule(style: .circular).fill(statusColor.tint.opacity(MenuStyle.glyphFillOpacity)))
        .foregroundStyle(statusColor.ink)
        .accessibilityElement(children: .combine)
    }

    private var isStatusShownInBanner: Bool {
        guard connection == .connected, let state else {
            return false
        }

        return state.isPaused || state.usageLimitedUntil != nil
    }

    private var modeText: String {
        guard let state else {
            return "Connecting…"
        }

        return state.settings.reviewMode == .auto ? "Auto mode · reviews on its own" : "Manual mode · you start reviews"
    }

    private var statusText: String {
        switch connection {
        case .starting:
            return "Starting"
        case .unavailable:
            return "Offline"
        case .connected:
            break
        }

        guard let state else {
            return "Starting"
        }

        if state.usageLimitedUntil != nil {
            return "Usage limit"
        }

        switch state.readiness.status {
        case .setupNeeded:
            return "Setup needed"
        case .checking:
            return "Checking"
        case .ready, .unknown:
            return state.isPaused ? "Paused" : "Running"
        }
    }

    private var statusColor: PastelColor {
        guard connection == .connected, let state else {
            return Palette.stone
        }

        if state.readiness.status == .setupNeeded || state.usageLimitedUntil != nil {
            return Palette.peach
        }

        if state.readiness.status == .checking {
            return Palette.stone
        }

        return state.isPaused ? Palette.butter : Palette.sage
    }
}
