import ProxyReviewBotCore
import SwiftUI

struct MenuContentView: View {
    @ObservedObject var model: BotModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            MenuHeaderView(state: model.state, connection: model.connection)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)

            Divider()

            StatusBannersView(model: model)

            if let state = model.state {
                if state.readiness.status == .setupNeeded {
                    SetupSectionView(model: model, readiness: state.readiness, waitingCount: model.attentionCount)
                } else {
                    PullRequestListView(model: model, sections: PullRequestSections(pullRequests: state.pullRequests))
                }
            }

            MenuFooterView(model: model)
                .padding(.vertical, 6)
        }
        .frame(width: 380)
    }
}
