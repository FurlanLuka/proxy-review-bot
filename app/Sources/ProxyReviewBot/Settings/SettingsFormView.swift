import ProxyReviewBotCore
import SwiftUI

struct SettingsFormView: View {
    @Binding var settings: BotSettings
    let readiness: Readiness?

    var body: some View {
        Form {
            Section("Reviews") {
                Picker("Mode", selection: $settings.reviewMode) {
                    Text("Manual").tag(ReviewMode.manual)
                    Text("Auto").tag(ReviewMode.auto)
                }
                .pickerStyle(.segmented)

                Picker("Auto-approve", selection: $settings.autoApprove) {
                    Text("Off").tag(AutoApproveMode.off)
                    Text("On").tag(AutoApproveMode.on)
                    Text("Small PRs only").tag(AutoApproveMode.small)
                }

                if settings.autoApprove == .small {
                    TextField("Small = under (changed lines)", value: $settings.smallPullRequestLineLimit, format: .number)
                }

                Stepper("Max rounds: \(settings.maxRounds)", value: $settings.maxRounds, in: 1...20)

                Stepper("Check every \(settings.pollIntervalSeconds) seconds", value: $settings.pollIntervalSeconds, in: 15...3600, step: 15)
            }

            Section("Replies") {
                Toggle("Answer questions in the bot's threads", isOn: $settings.answerQuestions)
            }

            Section {
                EditableListView(title: "Watch", placeholder: "owner or owner/repo", entries: $settings.watch)
                EditableListView(title: "Skip", placeholder: "owner/repo", entries: $settings.skip)
            } header: {
                Text("Repos")
            } footer: {
                Text("An empty watch list means every repo.")
                    .foregroundStyle(.secondary)
            }

            Section("System") {
                LaunchAtLoginToggle()
                ToolPathField(name: "claude", path: $settings.toolPaths.claude)
                ToolPathField(name: "gh", path: $settings.toolPaths.gh)
                ToolPathField(name: "git", path: $settings.toolPaths.git)
            }

            if let readiness {
                Section("Status") {
                    ReadinessSummaryView(readiness: readiness)
                }
            }
        }
        .formStyle(.grouped)
    }
}
