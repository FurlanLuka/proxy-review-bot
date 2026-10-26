import ProxyReviewBotCore
import SwiftUI

struct PullRequestListView: View {
    @ObservedObject var model: BotModel
    let sections: PullRequestSections

    var body: some View {
        if sections.needsReview.isEmpty && sections.needsYou.isEmpty && sections.inReview.isEmpty {
            Text("Nothing to review")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)

            Divider()
        }

        if !sections.needsReview.isEmpty {
            section(title: "Needs review", pullRequests: sections.needsReview)
        }

        if !sections.needsYou.isEmpty {
            section(title: "Needs you", pullRequests: sections.needsYou)
        }

        if !sections.inReview.isEmpty {
            section(title: "In review", pullRequests: sections.inReview)
        }
    }

    private func section(title: String, pullRequests: [PullRequest]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuSectionHeader(title: title)

            ForEach(pullRequests) { pullRequest in
                PullRequestRowView(model: model, pullRequest: pullRequest)
            }

            Divider()
                .padding(.top, 4)
        }
    }
}
