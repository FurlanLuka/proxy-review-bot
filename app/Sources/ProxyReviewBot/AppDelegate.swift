import AppKit
import OSLog

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let model = BotModel()
    private var mainWindow: MainWindowController?
    private var statusItem: StatusItemController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        if isAnotherInstanceRunning {
            Logger.app.info("Another Proxy Review Bot is already running; quitting this one")
            exit(EXIT_SUCCESS)
        }

        model.start()

        let mainWindow = MainWindowController(model: model)
        self.mainWindow = mainWindow
        statusItem = StatusItemController(model: model) { [weak mainWindow] in
            mainWindow?.toggle()
        }

        if let directory = SnapshotRenderer.outputDirectory {
            SnapshotRenderer.renderWhenReady(model: model, into: directory)
        }
    }

    func showSettings() {
        mainWindow?.showSettings()
    }

    func hideMainWindow() {
        mainWindow?.hide()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        mainWindow?.show()

        return false
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
