import AppKit
import ProxyReviewBotCore
import SwiftUI

struct HistoryRowView: View {
    let entry: HistoryEntry
    var viewerLogin: String?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            OutcomePill(outcome: entry.outcome)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.title)
                    .font(MenuStyle.titleFont)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text(entry.subtitle(viewerLogin: viewerLogin))
                    .font(MenuStyle.metaFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

            VStack(alignment: .trailing, spacing: 2) {
                Text(entry.finishedAtDate.formatted(date: .omitted, time: .shortened))
                    .font(MenuStyle.metaFont.monospacedDigit())

                Text(entry.roundsText)
                    .font(MenuStyle.metaFont)
                    .foregroundStyle(.secondary)
            }

            Button {
                NSWorkspace.shared.open(entry.url)
            } label: {
                Label("Open PR", systemImage: "arrow.up.right")
            }
            .buttonStyle(PillButtonStyle())
        }
        .padding(12)
        .card()
        .accessibilityElement(children: .combine)
    }
}

struct OutcomePill: View {
    let outcome: HistoryOutcome

    var body: some View {
        let color = Self.color(for: outcome)

        Text(outcome.displayName)
            .font(MenuStyle.labelFont)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .foregroundStyle(color.ink)
            .background(Capsule(style: .circular).fill(color.tint.opacity(MenuStyle.pillFillOpacity)))
            .frame(width: 128, alignment: .leading)
    }

    static func color(for outcome: HistoryOutcome) -> PastelColor {
        switch outcome {
        case .approvedByBot:
            return Palette.sage
        case .approvedByYou:
            return Palette.mint
        case .merged:
            return Palette.lavender
        case .closed:
            return Palette.stone
        case .takenOver:
            return Palette.peach
        case .stopped, .unknown:
            return Palette.periwinkle
        }
    }
}
