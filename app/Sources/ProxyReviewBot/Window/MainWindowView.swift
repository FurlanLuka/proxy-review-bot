import ProxyReviewBotCore
import SwiftUI

struct MainWindowView: View {
    @ObservedObject var model: BotModel
    @ObservedObject var navigator: AppNavigator

    var body: some View {
        NavigationStack(path: $navigator.path) {
            HomeView(model: model)
                .navigationTitle(MenuBarAccessibilityLabel.appName)
                .navigationDestination(for: AppRoute.self) { route in
                    destination(for: route)
                }
        }
        .environmentObject(navigator)
    }

    @ViewBuilder
    private func destination(for route: AppRoute) -> some View {
        switch route {
        case .draft(let pullRequestID):
            DraftEditorScreen(model: model, pullRequestID: pullRequestID)
        case .history:
            HistoryScreen(model: model)
                .onExitCommand { navigator.goBack() }
        case .settings:
            SettingsView(model: model)
                .navigationTitle("Settings")
                .onExitCommand { navigator.goBack() }
        }
    }
}
