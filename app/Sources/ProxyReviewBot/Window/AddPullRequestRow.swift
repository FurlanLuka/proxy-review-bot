import ProxyReviewBotCore
import SwiftUI

struct AddPullRequestRow: View {
    @ObservedObject var model: BotModel
    let onAdded: (AddPullRequestResponse) -> Void
    let onClose: () -> Void

    @State private var link = ""
    @State private var isAdding = false
    @State private var errorMessage: String?
    @FocusState private var isFieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                TextField("Paste a GitHub PR link", text: $link)
                    .textFieldStyle(.roundedBorder)
                    .focused($isFieldFocused)
                    .onSubmit(add)
                    .disabled(isAdding)
                    .accessibilityLabel("GitHub PR link")

                Button(action: add) {
                    Label {
                        Text("Review")
                    } icon: {
                        if isAdding {
                            ProgressView()
                                .controlSize(.small)
                        } else {
                            Image(systemName: "sparkles")
                        }
                    }
                }
                .buttonStyle(PillButtonStyle(isProminent: true, tint: Palette.sky))
                .disabled(isAdding || PullRequestLinkInput.normalized(link) == nil)

                IconButton(systemName: "xmark", label: "Close", help: "Close (Esc)", size: 24, action: onClose)
            }

            if let errorMessage {
                SettingsErrorText(message: errorMessage)
            }
        }
        .onAppear {
            isFieldFocused = true
        }
        .onExitCommand(perform: onClose)
    }

    private func add() {
        guard !isAdding, let url = PullRequestLinkInput.normalized(link) else {
            return
        }

        isAdding = true
        errorMessage = nil

        Task {
            defer {
                isAdding = false
            }

            do {
                let response = try await model.addPullRequest(url: url)
                link = ""
                onAdded(response)
            } catch {
                errorMessage = ServiceClientError.message(for: error, subject: "that PR")
            }
        }
    }
}
