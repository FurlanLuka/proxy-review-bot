import AppKit
import OSLog
import ProxyReviewBotCore
import SwiftUI

struct UninstallSection: View {
    @ObservedObject var model: BotModel
    @State private var isConfirming = false
    @State private var isUninstalling = false
    @State private var errorMessage: String?

    var body: some View {
        Section {
            Button("Uninstall Proxy Review Bot…", role: .destructive) {
                isConfirming = true
            }
            .disabled(isUninstalling)
            .confirmationDialog(
                "Uninstall Proxy Review Bot?",
                isPresented: $isConfirming,
                titleVisibility: .visible
            ) {
                Button("Uninstall, Keep Data", role: .destructive) {
                    uninstall(isDeletingData: false)
                }

                Button("Uninstall and Delete Data", role: .destructive) {
                    uninstall(isDeletingData: true)
                }

                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Moves the app to the Trash, removes the login item and quits. Nothing already posted on GitHub is touched. Your data is the settings, the database, the repo clones and the logs.")
            }

            if let errorMessage {
                SettingsErrorText(message: errorMessage)
            }
        } header: {
            Text("Uninstall")
        }
    }

    private func uninstall(isDeletingData: Bool) {
        Logger.app.info("Uninstalling (deleting data: \(isDeletingData, privacy: .public))")

        do {
            if Bundle.main.bundleURL.pathExtension == "app" {
                try FileManager.default.trashItem(at: Bundle.main.bundleURL, resultingItemURL: nil)
            }
        } catch {
            Logger.app.error("Moving the app to the Trash failed: \(error.localizedDescription, privacy: .public)")
            errorMessage = "Uninstall failed: \(error.localizedDescription)"
            return
        }

        isUninstalling = true
        var problems: [String] = []

        do {
            try LaunchAgent().remove()
        } catch {
            Logger.app.error("Removing the login item failed: \(error.localizedDescription, privacy: .public)")
            problems.append("The login item was left in place at \(LaunchAgent().plistURL.path).")
        }

        Task {
            if isDeletingData {
                problems += await deleteDataAfterServiceExits()
            } else {
                model.shutDown()
            }

            if !problems.isEmpty {
                showProblemsAlert(problems)
            }

            NSApp.terminate(nil)
        }
    }

    private func deleteDataAfterServiceExits() async -> [String] {
        guard await model.shutDownAndWaitForServiceExit() else {
            Logger.app.error("Service did not exit in time; data left in place")
            return ["The service didn't stop in time, so your data was not deleted."]
        }

        do {
            try InstallLocations().removeData()
            return []
        } catch {
            Logger.app.error("Deleting data failed: \(error.localizedDescription, privacy: .public)")
            return ["Some data could not be deleted. \(error.localizedDescription)."]
        }
    }

    private func showProblemsAlert(_ problems: [String]) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "The app was moved to the Trash, but not everything was removed"
        alert.informativeText = problems.joined(separator: "\n\n")
        alert.addButton(withTitle: "Quit")
        NSApp.activate()
        alert.runModal()
    }
}
