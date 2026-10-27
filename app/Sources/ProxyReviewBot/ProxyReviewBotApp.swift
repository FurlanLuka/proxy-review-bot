import SwiftUI

@main
struct ProxyReviewBotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        LoginItemCommand.runIfRequested()
    }

    var body: some Scene {
        Settings {
            EmptyView()
        }
        .commands {
            CommandGroup(replacing: .appSettings) {
                Button("Settings…") {
                    appDelegate.showSettings()
                }
                .keyboardShortcut(",")
            }

            CommandGroup(replacing: .newItem) {
                Button("Close Window") {
                    appDelegate.hideMainWindow()
                }
                .keyboardShortcut("w")
            }
        }
    }
}
