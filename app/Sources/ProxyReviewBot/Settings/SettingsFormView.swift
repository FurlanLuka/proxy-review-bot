import ProxyReviewBotCore
import SwiftUI

struct SettingsFormView: View {
    private static let pollIntervalOptions = [30, 60, 120, 300, 900]
    private static let errorSectionID = "settings-error"

    @ObservedObject var model: BotModel
    @Binding var settings: BotSettings
    let readiness: Readiness?
    var errorMessage: String?

    var body: some View {
        ScrollViewReader { proxy in
            form
                .onChange(of: errorMessage) { _, newErrorMessage in
                    if newErrorMessage != nil {
                        withAnimation {
                            proxy.scrollTo(Self.errorSectionID, anchor: .top)
                        }
                    }
                }
        }
    }

    private var form: some View {
        Form {
            if let errorMessage {
                Section {
                    SettingsErrorText(message: errorMessage)
                }
                .id(Self.errorSectionID)
            }

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
                    LabeledContent("Small PR limit") {
                        HStack(spacing: 6) {
                            TextField("Small PR limit", value: $settings.smallPullRequestLineLimit, format: .number)
                                .labelsHidden()
                                .frame(width: 60)
                                .multilineTextAlignment(.trailing)

                            Text("changed lines")
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                LabeledContent("Max rounds") {
                    HStack(spacing: 6) {
                        Text("\(settings.maxRounds)")
                            .monospacedDigit()

                        Stepper("Max rounds", value: $settings.maxRounds, in: 1...20)
                            .labelsHidden()
                    }
                }

                Picker("Check for PRs", selection: $settings.pollIntervalSeconds) {
                    ForEach(pollIntervalChoices, id: \.self) { seconds in
                        Text(Self.pollIntervalTitle(seconds: seconds)).tag(seconds)
                    }
                }
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

            Section {
                LaunchAtLoginToggle()
                ToolPathField(label: "Claude path", path: $settings.toolPaths.claude)
                ToolPathField(label: "gh path", path: $settings.toolPaths.gh)
                ToolPathField(label: "git path", path: $settings.toolPaths.git)
            } header: {
                Text("System")
            } footer: {
                Text("Leave empty to find each tool on your PATH.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }

            if let readiness {
                Section("Status") {
                    if readiness.checks.isEmpty {
                        Text(readiness.status == .checking ? "Checking…" : "No checks reported")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(readiness.checks) { check in
                            SetupCheckRowView(check: check)
                        }
                    }
                }
            }

            UninstallSection(model: model)
        }
        .formStyle(.grouped)
    }

    private var pollIntervalChoices: [Int] {
        let current = settings.pollIntervalSeconds

        return Self.pollIntervalOptions.contains(current) ? Self.pollIntervalOptions : (Self.pollIntervalOptions + [current]).sorted()
    }

    private static func pollIntervalTitle(seconds: Int) -> String {
        if seconds == 60 {
            return "Every minute"
        }

        if seconds < 60 || !seconds.isMultiple(of: 60) {
            return "Every \(seconds) seconds"
        }

        return "Every \(seconds / 60) minutes"
    }
}
