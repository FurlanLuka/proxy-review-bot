import ProxyReviewBotCore
import SwiftUI

struct HomeView: View {
    static let padding: CGFloat = 16

    private struct ScrollRequest: Equatable {
        let pullRequestID: Int
        let token = UUID()
    }

    @ObservedObject var model: BotModel

    @State private var isAddingPullRequest = false
    @State private var scrollRequest: ScrollRequest?
    @State private var addedNotice: String?
    @State private var noticeTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                MenuHeaderView(state: model.state, connection: model.connection)

                StatusBannersView(model: model)

                if isAddingPullRequest {
                    AddPullRequestRow(model: model, onAdded: handleAdded) {
                        isAddingPullRequest = false
                    }
                }

                if let addedNotice {
                    Label(addedNotice, systemImage: "checkmark.circle")
                        .font(MenuStyle.bodyFont)
                        .foregroundStyle(.secondary)
                }
            }
            .padding([.horizontal, .top], Self.padding)
            .padding(.bottom, 12)

            ScrollViewReader { proxy in
                ScrollView {
                    if let state = model.state {
                        content(for: state)
                            .padding(.horizontal, Self.padding)
                            .padding(.bottom, Self.padding)
                    }
                }
                .onChange(of: scrollRequest) { _, request in
                    if let request {
                        withAnimation {
                            proxy.scrollTo(request.pullRequestID, anchor: .top)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            MenuFooterView(model: model, onAddPullRequest: { isAddingPullRequest.toggle() })
                .padding(.horizontal, Self.padding - 4)
                .padding(.vertical, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func handleAdded(_ response: AddPullRequestResponse) {
        isAddingPullRequest = false
        scrollRequest = ScrollRequest(pullRequestID: response.id)

        guard response.isExisting else {
            return
        }

        addedNotice = "Already in review"
        noticeTask?.cancel()
        noticeTask = Task {
            try? await Task.sleep(for: .seconds(3))

            if !Task.isCancelled {
                addedNotice = nil
            }
        }
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
