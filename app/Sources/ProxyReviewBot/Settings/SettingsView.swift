import ProxyReviewBotCore
import SwiftUI

struct SettingsView: View {
    private static let saveDelay = Duration.milliseconds(500)

    @ObservedObject var model: BotModel
    @State private var draft: BotSettings?
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let draft = Binding($draft) {
                SettingsFormView(model: model, settings: draft, readiness: model.state?.readiness, errorMessage: errorMessage)
            } else {
                Text("Waiting for the service…")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: loadDraftIfNeeded)
        .onChange(of: model.state?.settings) { oldSettings, newSettings in
            if draft == nil || draft == oldSettings {
                draft = newSettings
            }
        }
        .task(id: draft) {
            await saveAfterDelay()
        }
    }

    private func loadDraftIfNeeded() {
        if draft == nil {
            draft = model.state?.settings
        }
    }

    private func saveAfterDelay() async {
        guard let draft, draft != model.state?.settings else {
            return
        }

        do {
            try await Task.sleep(for: Self.saveDelay)
            try await model.saveSettings(draft)

            if self.draft == draft {
                self.draft = model.state?.settings
            }

            errorMessage = nil
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled else {
                return
            }

            errorMessage = (error as? ServiceClientError)?.code == "invalid_settings"
                ? "The service rejected these settings"
                : error.localizedDescription
        }
    }
}
