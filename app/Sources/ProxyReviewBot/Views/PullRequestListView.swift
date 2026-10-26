import ProxyReviewBotCore
import SwiftUI

struct PullRequestListView: View {
    @ObservedObject var model: BotModel
    let sections: PullRequestSections

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if sections.needsReview.isEmpty && sections.needsYou.isEmpty && sections.inReview.isEmpty {
                emptyState
            }

            if !sections.needsYou.isEmpty {
                section(title: "Needs you", pullRequests: sections.needsYou)
            }

            if !sections.needsReview.isEmpty {
                section(title: "Ready to review", pullRequests: sections.needsReview)
            }

            if !sections.inReview.isEmpty {
                section(title: "In review", pullRequests: sections.inReview)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(Palette.sage.ink)
                .accessibilityHidden(true)

            Text("All caught up")
                .font(MenuStyle.titleFont)

            Text("No PRs are waiting on your review.")
                .font(MenuStyle.metaFont)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .card()
    }

    private func section(title: String, pullRequests: [PullRequest]) -> some View {
        VStack(alignment: .leading, spacing: MenuStyle.cardSpacing) {
            MenuSectionHeader(title: title, count: pullRequests.count)

            ForEach(pullRequests) { pullRequest in
                PullRequestRowView(model: model, pullRequest: pullRequest)
            }
        }
    }
}
