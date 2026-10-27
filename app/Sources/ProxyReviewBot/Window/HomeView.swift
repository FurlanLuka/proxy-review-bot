import ProxyReviewBotCore
import SwiftUI

struct HomeView: View {
    static let padding: CGFloat = 16

    @ObservedObject var model: BotModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                MenuHeaderView(state: model.state, connection: model.connection)

                StatusBannersView(model: model)
            }
            .padding([.horizontal, .top], Self.padding)
            .padding(.bottom, 12)

            ScrollView {
                if let state = model.state {
                    content(for: state)
                        .padding(.horizontal, Self.padding)
                        .padding(.bottom, Self.padding)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            MenuFooterView(model: model)
                .padding(.horizontal, Self.padding - 4)
                .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    @ViewBuilder
    private func content(for state: BotState) -> some View {
        if state.readiness.status == .setupNeeded {
            SetupSectionView(model: model, readiness: state.readiness, waitingCount: model.attentionCount)
        } else {
            PullRequestListView(model: model, sections: PullRequestSections(pullRequests: state.pullRequests))
        }
    }
}
