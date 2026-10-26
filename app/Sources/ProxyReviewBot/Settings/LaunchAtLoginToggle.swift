import OSLog
import ProxyReviewBotCore
import SwiftUI

struct LaunchAtLoginToggle: View {
    private let launchAgent = LaunchAgent()
    @State private var isEnabled = LaunchAgent().isInstalled
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Toggle("Launch at login", isOn: Binding(get: { isEnabled }, set: update))

            if let errorMessage {
                Text(errorMessage)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private func update(_ shouldEnable: Bool) {
        do {
            if shouldEnable {
                try launchAgent.install(executablePath: Bundle.main.executablePath ?? CommandLine.arguments[0])
            } else {
                try launchAgent.remove()
            }

            errorMessage = nil
        } catch {
            Logger.app.error("Launch at login change failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = error.localizedDescription
        }

        isEnabled = launchAgent.isInstalled
    }
}
