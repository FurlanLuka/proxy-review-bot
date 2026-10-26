import ProxyReviewBotCore
import SwiftUI

struct StatusAppearance {
    let symbol: String
    let color: PastelColor

    static func of(_ glyph: PullRequestGlyph) -> StatusAppearance {
        switch glyph {
        case .failedReview:
            return StatusAppearance(symbol: "exclamationmark.triangle.fill", color: Palette.rose)
        case .status(let status):
            return of(status)
        }
    }

    static func of(_ status: PullRequestStatus) -> StatusAppearance {
        switch status {
        case .needsReview:
            return StatusAppearance(symbol: "eye.fill", color: Palette.sky)
        case .awaitingApproval:
            return StatusAppearance(symbol: "checkmark.seal.fill", color: Palette.sage)
        case .draftReady:
            return StatusAppearance(symbol: "doc.text.magnifyingglass", color: Palette.orchid)
        case .needsYou:
            return StatusAppearance(symbol: "exclamationmark", color: Palette.peach)
        case .queued:
            return StatusAppearance(symbol: "clock.fill", color: Palette.periwinkle)
        case .reviewing:
            return StatusAppearance(symbol: "sparkles", color: Palette.lavender)
        case .waitingOnAuthor:
            return StatusAppearance(symbol: "hourglass", color: Palette.mint)
        case .blocked:
            return StatusAppearance(symbol: "hand.raised.fill", color: Palette.rose)
        case .done:
            return StatusAppearance(symbol: "checkmark", color: Palette.sage)
        case .stopped, .unknown:
            return StatusAppearance(symbol: "stop.fill", color: Palette.stone)
        }
    }
}

struct StatusGlyph: View {
    let glyph: PullRequestGlyph

    @Environment(\.accessibilityReduceMotion) private var isReducingMotion

    init(glyph: PullRequestGlyph) {
        self.glyph = glyph
    }

    init(status: PullRequestStatus) {
        glyph = .status(status)
    }

    var body: some View {
        let appearance = StatusAppearance.of(glyph)

        ZStack {
            Circle()
                .fill(appearance.color.tint.opacity(MenuStyle.glyphFillOpacity))

            Image(systemName: appearance.symbol)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(appearance.color.ink)
                .symbolEffect(.pulse, isActive: glyph == .status(.reviewing) && !isReducingMotion)
        }
        .frame(width: 30, height: 30)
        .accessibilityElement()
        .accessibilityLabel(glyph.accessibilityLabel)
    }
}
