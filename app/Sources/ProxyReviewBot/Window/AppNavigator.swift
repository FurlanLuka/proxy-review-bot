import ProxyReviewBotCore
import SwiftUI

@MainActor
final class AppNavigator: ObservableObject {
    @Published var path: [AppRoute] = []

    func open(_ route: AppRoute) {
        path = AppRoute.path(opening: route)
    }

    func show(path newPath: [AppRoute]) {
        path = newPath
    }

    func goBack() {
        _ = path.popLast()
    }
}
