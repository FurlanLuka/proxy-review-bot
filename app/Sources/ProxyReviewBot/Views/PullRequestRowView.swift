import ProxyReviewBotCore
import SwiftUI

struct PullRequestRowView: View {
    @ObservedObject var model: BotModel
    let pullRequest: PullRequest

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            titleLine

            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(PullRequestDetail.text(for: pullRequest, now: context.date))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            HStack(spacing: 6) {
                PullRequestActionsView(model: model, pullRequest: pullRequest)

                Spacer()

                if pullRequest.status.isStoppable {
                    Button("Stop") {
                        model.stop(pullRequest)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                }
            }
            .controlSize(.small)
            .disabled(model.busyPullRequestIDs.contains(pullRequest.id))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private var titleLine: some View {
        HStack(spacing: 6) {
            Text(pullRequest.shortName)
                .fontWeight(.semibold)

            Text(pullRequest.title)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            Text(trailingText)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private var trailingText: String {
        pullRequest.status.isInReview
            ? PullRequestDetail.roundText(for: pullRequest)
            : PullRequestDetail.lineCountText(for: pullRequest)
    }
}
