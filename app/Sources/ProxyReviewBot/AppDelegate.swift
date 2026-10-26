import AppKit
import OSLog

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = BotModel()

    func applicationDidFinishLaunching(_ notification: Notification) {
        if isAnotherInstanceRunning {
            Logger.app.info("Another Proxy Review Bot is already running; quitting this one")
            exit(EXIT_SUCCESS)
        }

        model.start()

        if let directory = SnapshotRenderer.outputDirectory {
            SnapshotRenderer.renderWhenReady(model: model, into: directory)
        }
    }

    private var isAnotherInstanceRunning: Bool {
        guard let bundleIdentifier = Bundle.main.bundleIdentifier else {
            return false
        }

        return NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier)
            .contains { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.shutDown()
    }
}
