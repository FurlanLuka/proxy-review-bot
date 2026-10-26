import SwiftUI

@main
struct ProxyReviewBotApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        LoginItemCommand.runIfRequested()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(model: appDelegate.model)
        } label: {
            MenuBarLabel(model: appDelegate.model)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView(model: appDelegate.model)
        }

        WindowGroup("Review Draft", id: DraftEditorWindow.id, for: Int.self) { $pullRequestID in
            if let pullRequestID {
                DraftEditorWindowView(model: appDelegate.model, pullRequestID: pullRequestID)
            } else {
                WindowPlaceholderView()
            }
        }
        .defaultSize(DraftEditorWindow.defaultSize)
        .windowResizability(.contentMinSize)

        WindowGroup("History", id: HistoryWindow.id, for: String.self) { $value in
            if value == HistoryWindow.value {
                HistoryWindowView(model: appDelegate.model)
            } else {
                WindowPlaceholderView()
            }
        }
        .defaultSize(HistoryWindow.defaultSize)
        .windowResizability(.contentMinSize)
    }
}
