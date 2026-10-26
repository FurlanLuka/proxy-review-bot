import ProxyReviewBotCore
import SwiftUI

struct ReviewProgressView: View {
    let progress: ReviewProgress

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            VStack(alignment: .leading, spacing: 8) {
                ForEach(progress.subagents) { subagent in
                    SubagentRowView(subagent: subagent, now: context.date)
                }

                if progress.subagents.isEmpty {
                    Text("No advisors running yet")
                        .font(MenuStyle.metaFont)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private struct SubagentRowView: View {
    let subagent: SubagentProgress
    let now: Date

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            statusIcon
                .frame(width: 14, height: 14)

            VStack(alignment: .leading, spacing: 1) {
                Text(subagent.label)
                    .font(MenuStyle.labelFont)

                if let detail = subagent.detailText {
                    Text(detail)
                        .font(MenuStyle.metaFont)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            Spacer(minLength: 4)

            Text(subagent.durationText(now: now))
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var statusIcon: some View {
        switch subagent.status {
        case .running:
            ProgressView()
                .controlSize(.mini)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Palette.sage.ink)
        case .failed, .unknown:
            Image(systemName: "exclamationmark.circle.fill")
                .foregroundStyle(Palette.peach.ink)
        }
    }
}
