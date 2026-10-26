import AppKit
import ProxyReviewBotCore
import SwiftUI

struct MenuContentView: View {
    private static let spacing: CGFloat = 12
    private static let screenMargin: CGFloat = 24

    @ObservedObject var model: BotModel
    @State private var contentHeight: CGFloat = 0
    @State private var chromeHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: Self.spacing) {
            VStack(alignment: .leading, spacing: Self.spacing) {
                MenuHeaderView(state: model.state, connection: model.connection)

                StatusBannersView(model: model)
            }
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { chromeHeight = $0 }

            if let state = model.state {
                ScrollView {
                    content(for: state)
                        .frame(width: MenuStyle.width - MenuStyle.outerPadding * 2)
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { contentHeight = $0 }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(height: min(contentHeight, maximumScrollHeight))
            }

            VStack(alignment: .leading, spacing: Self.spacing) {
                Divider()

                MenuFooterView(model: model)
            }
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { footerHeight = $0 }
        }
        .padding(MenuStyle.outerPadding)
        .frame(width: MenuStyle.width)
        .background(MenuWindowTopAnchor())
    }

    private var maximumScrollHeight: CGFloat {
        let visibleHeight = NSScreen.main?.visibleFrame.height ?? 800
        let fixedHeight = chromeHeight + footerHeight + Self.screenMargin + MenuStyle.outerPadding * 2 + Self.spacing * 2

        return max(0, visibleHeight - fixedHeight)
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
