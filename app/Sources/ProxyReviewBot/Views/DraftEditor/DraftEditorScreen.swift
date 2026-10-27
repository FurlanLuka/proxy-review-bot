import ProxyReviewBotCore
import SwiftUI

struct DraftEditorScreen: View {
    @ObservedObject var model: BotModel
    let pullRequestID: Int

    @Environment(\.dismiss) private var dismiss
    @State private var loadState = LoadState.loading
    @State private var isLeaving = false

    private enum LoadState {
        case loading
        case loaded(ReviewDraft)
        case failed(String)
    }

    var body: some View {
        Group {
            if isDraftGone {
                draftGoneView
            } else {
                content
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle(screenTitle)
        .navigationSubtitle(screenSubtitle)
        .task(id: pullRequestID) {
            await load()
        }
    }

    private var isDraftGone: Bool {
        !isLeaving && model.state != nil && model.pullRequest(id: pullRequestID)?.status.hasDraft != true
    }

    @ViewBuilder
    private var content: some View {
        Group {
            switch loadState {
            case .loading:
                ProgressView("Loading the draft…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let draft):
                DraftEditorContentView(
                    pullRequest: model.pullRequest(id: pullRequestID),
                    draft: draft,
                    onPost: { request in
                        try await leaving { try await model.postDraft(request, pullRequestID: pullRequestID) }
                    },
                    onDiscard: {
                        try await leaving { try await model.discardDraft(pullRequestID: pullRequestID) }
                    },
                    onFinish: { dismiss() }
                )
            case .failed(let message):
                failureView(message: message)
            }
        }
    }

    private var screenTitle: String {
        model.pullRequest(id: pullRequestID).map { "Draft · \($0.shortName)" } ?? "Draft"
    }

    private var screenSubtitle: String {
        model.pullRequest(id: pullRequestID)?.title ?? ""
    }

    private var draftGoneView: some View {
        VStack(spacing: 10) {
            Image(systemName: "arrow.triangle.2.circlepath")
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(Palette.sky.ink)
                .accessibilityHidden(true)

            Text(DraftGoneMessage.text(for: model.pullRequest(id: pullRequestID)))
                .font(MenuStyle.bodyFont)
                .multilineTextAlignment(.center)

            Button {
                dismiss()
            } label: {
                Label("Back", systemImage: "chevron.left")
            }
            .buttonStyle(PillButtonStyle())
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func leaving<Result>(_ action: () async throws -> Result) async throws -> Result {
        isLeaving = true

        do {
            return try await action()
        } catch {
            isLeaving = false

            throw error
        }
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
