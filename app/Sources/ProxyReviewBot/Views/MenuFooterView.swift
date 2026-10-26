import AppKit
import SwiftUI

struct MenuFooterView: View {
    @ObservedObject var model: BotModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        HStack(spacing: 2) {
            if let state = model.state {
                IconButton(
                    systemName: state.isPaused ? "play.fill" : "pause.fill",
                    label: state.isPaused ? "Resume Reviews" : "Pause Reviews",
                    help: state.isPaused ? "Resume Reviews" : "Pause Reviews"
                ) {
                    model.togglePause()
                }
            }

            IconButton(systemName: "gearshape", label: "Settings", help: "Settings (⌘,)") {
                NSApp.activate()
                openSettings()
            }
            .keyboardShortcut(",")

            IconButton(systemName: "doc.plaintext", label: "Open Logs", help: "Open Logs") {
                model.openLogs()
            }

            Spacer()

            IconButton(systemName: "power", label: "Quit Proxy Review Bot", help: "Quit (⌘Q)") {
                NSApp.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }
}
