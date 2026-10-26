import ProxyReviewBotCore
import SwiftUI

struct PullRequestActionsView: View {
    @ObservedObject var model: BotModel
    let pullRequest: PullRequest
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        switch pullRequest.status {
        case .needsReview:
            Button {
                model.review(pullRequest)
            } label: {
                Label("Review", systemImage: "sparkles")
            }
            .buttonStyle(PillButtonStyle(isProminent: true, tint: Palette.sky))

            openButton
        case .awaitingApproval:
            Button {
                model.approve(pullRequest)
            } label: {
                Label("Approve", systemImage: "checkmark")
            }
            .buttonStyle(PillButtonStyle(isProminent: true, tint: Palette.sage))

            reviewDraftButton(isProminent: false)

            openButton
        case .draftReady:
            reviewDraftButton(isProminent: true)

            openButton
        case .needsYou:
            Button {
                model.retry(pullRequest)
            } label: {
                Label("Review Again", systemImage: "arrow.clockwise")
            }
            .buttonStyle(PillButtonStyle(isProminent: true, tint: Palette.peach))

            openButton
        default:
            EmptyView()
        }
    }

    private func reviewDraftButton(isProminent: Bool) -> some View {
        Button {
            NSApp.activate()
            openWindow(id: DraftEditorWindow.id, value: pullRequest.id)
        } label: {
            Label("Review Draft…", systemImage: "doc.text.magnifyingglass")
        }
        .buttonStyle(PillButtonStyle(isProminent: isProminent, tint: Palette.orchid))
    }

    private var openButton: some View {
        Button {
            NSWorkspace.shared.open(pullRequest.url)
        } label: {
            Label("Open PR", systemImage: "arrow.up.right")
        }
        .buttonStyle(PillButtonStyle())
    }
}
