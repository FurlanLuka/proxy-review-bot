import ProxyReviewBotCore
import SwiftUI

struct PullRequestActionsView: View {
    @ObservedObject var model: BotModel
    let pullRequest: PullRequest

    var body: some View {
        switch pullRequest.status {
        case .needsReview:
            Button("Review") {
                model.review(pullRequest)
            }
            .buttonStyle(.borderedProminent)
        case .awaitingApproval:
            Button("Approve") {
                model.approve(pullRequest)
            }
            .buttonStyle(.borderedProminent)

            openButton(title: "Open review")
        case .needsYou:
            openButton(title: "Open PR")

            Button("Review again") {
                model.retry(pullRequest)
            }
            .buttonStyle(.bordered)
        default:
            EmptyView()
        }
    }

    private func openButton(title: String) -> some View {
        Button(title) {
            NSWorkspace.shared.open(pullRequest.url)
        }
        .buttonStyle(.bordered)
    }
}
