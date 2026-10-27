import ProxyReviewBotCore
import SwiftUI

struct DraftEditorContentView: View {
    let pullRequest: PullRequest?
    let onPost: (ReviewPostRequest) async throws -> Void
    let onDiscard: () async throws -> Void
    let onFinish: () -> Void

    @State private var editableDraft: EditableReviewDraft
    @State private var isSubmitting = false
    @State private var isConfirmingDiscard = false
    @State private var errorMessage: String?

    init(
        pullRequest: PullRequest?,
        draft: ReviewDraft,
        onPost: @escaping (ReviewPostRequest) async throws -> Void,
        onDiscard: @escaping () async throws -> Void,
        onFinish: @escaping () -> Void
    ) {
        self.pullRequest = pullRequest
        self.onPost = onPost
        self.onDiscard = onDiscard
        self.onFinish = onFinish
        _editableDraft = State(initialValue: EditableReviewDraft(draft: draft))
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    DraftHeaderView(pullRequest: pullRequest, draft: editableDraft.draft)

                    VStack(alignment: .leading, spacing: MenuStyle.cardSpacing) {
                        MenuSectionHeader(title: "Main review")

                        DraftTextEditor(text: $editableDraft.mainReview, minHeight: 120, placeholder: "Write the overall review…", accessibilityLabel: "Main review")
                    }

                    if !editableDraft.comments.isEmpty {
                        VStack(alignment: .leading, spacing: MenuStyle.cardSpacing) {
                            MenuSectionHeader(title: "Inline comments", count: editableDraft.comments.count)

                            ForEach($editableDraft.comments) { $comment in
                                DraftCommentCard(
                                    location: comment.item.location,
                                    link: pullRequest.map {
                                        DiffLink.lineURL(pullRequestURL: $0.url, path: comment.item.path, line: comment.item.line, side: comment.item.side)
                                    },
                                    isIncluded: $comment.isIncluded,
                                    text: $comment.item.body
                                )
                            }
                        }
                    }

                    if !editableDraft.fileComments.isEmpty {
                        VStack(alignment: .leading, spacing: MenuStyle.cardSpacing) {
                            MenuSectionHeader(title: "File comments", count: editableDraft.fileComments.count)

                            ForEach($editableDraft.fileComments) { $comment in
                                DraftCommentCard(
                                    location: comment.item.path,
                                    link: pullRequest.map { DiffLink.fileURL(pullRequestURL: $0.url, path: comment.item.path) },
                                    isIncluded: $comment.isIncluded,
                                    text: $comment.item.body
                                )
                            }
                        }
                    }
                }
                .padding(20)
            }

            Divider()

            footer
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
        }
        .background(Color(nsColor: .windowBackgroundColor))
        .disabled(isSubmitting)
        .confirmationDialog("Discard this draft?", isPresented: $isConfirmingDiscard, titleVisibility: .visible) {
            Button("Discard Draft", role: .destructive) {
                submit(onDiscard)
            }

            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Nothing is posted. The bot waits for new commits before reviewing this PR again.")
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle.fill")
                    .font(MenuStyle.bodyFont)
                    .foregroundStyle(Palette.rose.ink)
            }

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    discardButton

                    Spacer()

                    eventPicker

                    postButton
                }

                VStack(alignment: .trailing, spacing: 8) {
                    eventPicker

                    HStack(spacing: 8) {
                        discardButton

                        Spacer()

                        postButton
                    }
                }
            }
        }
    }

    private var discardButton: some View {
        Button(role: .destructive) {
            isConfirmingDiscard = true
        } label: {
            Label("Discard…", systemImage: "trash")
        }
        .buttonStyle(PillButtonStyle())
    }

    private var eventPicker: some View {
        PillSegmentedPicker(
            label: "Post as",
            options: editableDraft.availableEvents.map { ($0, $0.title) },
            selection: $editableDraft.event,
            tint: eventTint
        )
    }

    @ViewBuilder
    private var postButton: some View {
        let button = Button {
            submit { try await onPost(editableDraft.postRequest) }
        } label: {
            Label {
                Text(postTitle)
            } icon: {
                if isSubmitting {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: postSymbol)
                }
            }
        }
        .buttonStyle(PillButtonStyle(isProminent: true, tint: eventTint))
        .keyboardShortcut(.return, modifiers: .command)
        .disabled(!editableDraft.isPostable)

        if let reason = editableDraft.unpostableReason {
            button.help(reason)
        } else {
            button
        }
    }

    private var postTitle: String {
        switch editableDraft.postRequest.event {
        case .approve:
            return "Approve & Post"
        case .comment:
            return "Post Review"
        case .requestChanges:
            return "Request Changes"
        }
    }

    private var postSymbol: String {
        switch editableDraft.postRequest.event {
        case .approve:
            return "checkmark.seal"
        case .comment:
            return "paperplane"
        case .requestChanges:
            return "exclamationmark.bubble"
        }
    }

    private var eventTint: PastelColor {
        switch editableDraft.postRequest.event {
        case .approve:
            return Palette.sage
        case .comment:
            return Palette.sky
        case .requestChanges:
            return Palette.rose
        }
    }

    private func submit(_ operation: @escaping () async throws -> Void) {
        isSubmitting = true
        errorMessage = nil

        Task {
            do {
                try await operation()
                onFinish()
            } catch {
                errorMessage = ServiceClientError.message(for: error, subject: "the PR")
            }

            isSubmitting = false
        }
    }
}
