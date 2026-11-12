import ProxyReviewBotCore
import SwiftUI

struct SettingsFormView: View {
    private static let pollIntervalOptions = [30, 60, 120, 300, 900]
    private static let errorSectionID = "settings-error"

    @ObservedObject var model: BotModel
    @Binding var settings: BotSettings
    let readiness: Readiness?
    let update: UpdateState?
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

            Section {
                Picker("Start reviews", selection: $settings.reviewMode) {
                    Text("Manually").tag(ReviewMode.manual)
                    Text("Automatically").tag(ReviewMode.auto)
                }
                .pickerStyle(.segmented)

                EditableListView(
                    title: "Start manually",
                    placeholder: "head → base",
                    entries: manualStartEntries,
                    normalize: BranchPair.normalize
                )

                Picker("Post reviews", selection: $settings.postReviews) {
                    Text("Ask me first").tag(PostReviewsMode.ask)
                    Text("Automatically").tag(PostReviewsMode.auto)
                }
                .pickerStyle(.segmented)

                if settings.postReviews == .auto {
                    Picker("Auto-approve", selection: $settings.autoApprove) {
                        Text("Off").tag(AutoApproveMode.off)
                        Text("On").tag(AutoApproveMode.on)
                        Text("Small PRs only").tag(AutoApproveMode.small)
                    }
                }

                if settings.postReviews == .auto && settings.autoApprove == .small {
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

                LabeledContent("Reviews at once") {
                    HStack(spacing: 6) {
                        Text("\(maxParallelReviews.wrappedValue)")
                            .monospacedDigit()

                        Stepper("Reviews at once", value: maxParallelReviews, in: 1...10)
                            .labelsHidden()
                    }
                }

                Picker("Check for PRs", selection: $settings.pollIntervalSeconds) {
                    ForEach(pollIntervalChoices, id: \.self) { seconds in
                        Text(Self.pollIntervalTitle(seconds: seconds)).tag(seconds)
                    }
                }

                Picker("Claude model", selection: $settings.claudeModel) {
                    ForEach(ClaudeModelChoice.choices(saved: settings.claudeModel), id: \.self) { choice in
                        Text(choice.title).tag(choice.model)
                    }
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("Review instructions")

                    TextEditor(text: reviewInstructions)
                        .font(.body)
                        .scrollContentBackground(.hidden)
                        .padding(4)
                        .frame(height: 84)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color.primary.opacity(0.05))
                        )
                        .overlay(alignment: .topLeading) {
                            if reviewInstructions.wrappedValue.isEmpty {
                                Text(ReviewInstructions.placeholder)
                                    .foregroundStyle(.tertiary)
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 4)
                                    .allowsHitTesting(false)
                            }
                        }
                        .accessibilityLabel("Review instructions")

                    Text(ReviewInstructions.counterText(for: reviewInstructions.wrappedValue))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            } header: {
                Text("Reviews")
            } footer: {
                Text("Claude model and instructions apply to reviews and replies.\nProxy's advisors use their own model.")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: true, vertical: false)
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

            if let update {
                updatesSection(update)
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

    private func updatesSection(_ update: UpdateState) -> some View {
        Section {
            LabeledContent {
                Button(update.button.title) {
                    switch update.button {
                    case .check:
                        model.checkForUpdate()
                    case .install:
                        model.installUpdate()
                    }
                }
                .disabled(!update.isButtonEnabled)
            } label: {
                Text(update.statusText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Toggle("Install updates automatically", isOn: autoUpdate)
        } header: {
            Text("Updates")
        } footer: {
            if let reason = update.cannotInstallReason {
                Text(reason)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private var reviewInstructions: Binding<String> {
        Binding {
            settings.reviewInstructions ?? ""
        } set: { text in
            settings.reviewInstructions = ReviewInstructions.clamped(text)
        }
    }

    private var maxParallelReviews: Binding<Int> {
        Binding {
            settings.maxParallelReviews ?? 3
        } set: { count in
            settings.maxParallelReviews = count
        }
    }

    private var autoUpdate: Binding<Bool> {
        Binding {
            settings.autoUpdate ?? true
        } set: { isOn in
            settings.autoUpdate = isOn
        }
    }

    private var manualStartEntries: Binding<[String]> {
        Binding {
            (settings.manualStartBranches ?? []).map(\.text)
        } set: { entries in
            settings.manualStartBranches = entries.compactMap(BranchPair.init(text:))
        }
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
