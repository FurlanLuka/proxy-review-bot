import AppKit
import SwiftUI

struct MenuFooterView: View {
    @ObservedObject var model: BotModel
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let state = model.state {
                MenuItemButton(title: state.isPaused ? "Resume" : "Pause") {
                    model.togglePause()
                }
            }

            MenuItemButton(title: "Settings…", shortcutHint: "⌘,") {
                NSApp.activate(ignoringOtherApps: true)
                openSettings()
            }
            .keyboardShortcut(",")

            MenuItemButton(title: "Open logs") {
                model.openLogs()
            }

            MenuItemButton(title: "Quit", shortcutHint: "⌘Q") {
                NSApp.terminate(nil)
            }
            .keyboardShortcut("q")
        }
    }
}
