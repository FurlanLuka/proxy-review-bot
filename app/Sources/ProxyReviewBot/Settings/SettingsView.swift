import ProxyReviewBotCore
import SwiftUI

struct SettingsView: View {
    @ObservedObject var model: BotModel
    @State private var draft: BotSettings?
    @State private var isSaving = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let draft = Binding($draft), let savedSettings = model.state?.settings {
                VStack(spacing: 0) {
                    SettingsFormView(settings: draft, readiness: model.state?.readiness)

                    Divider()

                    actionBar(isChanged: draft.wrappedValue != savedSettings, savedSettings: savedSettings)
                        .padding(12)
                }
            } else {
                Text("Waiting for the service…")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(width: 520, height: 640)
        .onAppear(perform: loadDraftIfNeeded)
        .onChange(of: model.state?.settings) { oldSettings, newSettings in
            if draft == nil || draft == oldSettings {
                draft = newSettings
            }
        }
    }

    private func actionBar(isChanged: Bool, savedSettings: BotSettings) -> some View {
        HStack {
            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .font(.callout)
            }

            Spacer()

            Button("Revert") {
                draft = savedSettings
                errorMessage = nil
            }
            .disabled(!isChanged || isSaving)

            Button("Save") {
                save()
            }
            .keyboardShortcut(.defaultAction)
            .disabled(!isChanged || isSaving)
        }
    }

    private func loadDraftIfNeeded() {
        if draft == nil {
            draft = model.state?.settings
        }
    }

    private func save() {
        guard let draft else {
            return
        }

        isSaving = true

        Task {
            do {
                try await model.saveSettings(draft)
                self.draft = model.state?.settings
                errorMessage = nil
            } catch {
                errorMessage = (error as? ServiceClientError)?.code == "invalid_settings"
                    ? "The service rejected these settings"
                    : error.localizedDescription
            }

            isSaving = false
        }
    }
}
