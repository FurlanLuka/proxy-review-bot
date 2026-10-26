import ProxyReviewBotCore
import SwiftUI

enum DraftEditorWindow {
    static let id = "draft"
    static let minimumWidth: CGFloat = 640
    static let defaultSize = CGSize(width: minimumWidth, height: 720)
}

struct DraftEditorWindowView: View {
    @ObservedObject var model: BotModel
    let pullRequestID: Int

    @Environment(\.dismiss) private var dismiss
    @State private var loadState = LoadState.loading

    private enum LoadState {
        case loading
        case loaded(ReviewDraft)
        case failed(String)
    }

    var body: some View {
        Group {
            switch loadState {
            case .loading:
                ProgressView("Loading the draft…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let draft):
                DraftEditorContentView(
                    pullRequest: model.pullRequest(id: pullRequestID),
                    draft: draft,
                    onPost: { try await model.postDraft($0, pullRequestID: pullRequestID) },
                    onDiscard: { try await model.discardDraft(pullRequestID: pullRequestID) },
                    onFinish: { dismiss() }
                )
            case .failed(let message):
                failureView(message: message)
            }
        }
        .frame(minWidth: DraftEditorWindow.minimumWidth, idealWidth: DraftEditorWindow.minimumWidth, maxWidth: .infinity, minHeight: 480, maxHeight: .infinity)
        .navigationTitle(windowTitle)
        .navigationSubtitle(windowSubtitle)
        .task(id: pullRequestID) {
            await load()
        }
    }

    private var windowTitle: String {
        model.pullRequest(id: pullRequestID).map { "Review – \($0.title)" } ?? "Review Draft"
    }

    private var windowSubtitle: String {
        model.pullRequest(id: pullRequestID).map { "\($0.owner)/\($0.repo) #\($0.number)" } ?? ""
    }

    private func failureView(message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.badge.ellipsis")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(Palette.peach.ink)
                .accessibilityHidden(true)

            Text(message)
                .font(MenuStyle.bodyFont)
                .multilineTextAlignment(.center)

            Button {
                Task { await load() }
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
            }
            .buttonStyle(PillButtonStyle())
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func load() async {
        loadState = .loading

        do {
            loadState = .loaded(try await model.fetchDraft(pullRequestID: pullRequestID))
        } catch {
            loadState = .failed(ServiceClientError.message(for: error, subject: "this PR"))
        }
    }
}

struct WindowPlaceholderView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .onAppear { dismiss() }
    }
}
