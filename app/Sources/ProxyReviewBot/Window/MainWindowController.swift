import AppKit
import OSLog
import ProxyReviewBotCore
import SwiftUI

@MainActor
final class MainWindowController: NSObject, NSWindowDelegate {
    static let showRequest = Notification.Name("ProxyReviewBotShowMainWindow")
    nonisolated static let pathUserInfoKey = "path"

    static let defaultSize = NSSize(width: 520, height: 720)
    private static let minimumSize = NSSize(width: 460, height: 480)

    let navigator = AppNavigator()
    private let window: NSWindow
    private var showRequestObserver: NSObjectProtocol?

    init(model: BotModel) {
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.defaultSize),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        super.init()

        let hostingController = NSHostingController(rootView: MainWindowView(model: model, navigator: navigator))
        hostingController.sceneBridgingOptions = [.toolbars, .title]
        hostingController.sizingOptions = []
        window.title = MenuBarAccessibilityLabel.appName
        window.contentMinSize = Self.minimumSize
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.delegate = self
        window.contentViewController = hostingController
        window.setContentSize(Self.defaultSize)

        if !window.setFrameUsingName(MenuBarAccessibilityLabel.appName) {
            window.center()
        }

        window.setFrameAutosaveName(MenuBarAccessibilityLabel.appName)
        showRequestObserver = NotificationCenter.default.addObserver(forName: Self.showRequest, object: nil, queue: .main) { [weak self] notification in
            let path = notification.userInfo?[Self.pathUserInfoKey] as? [AppRoute]

            MainActor.assumeIsolated {
                if let path {
                    self?.navigator.show(path: path)
                }

                self?.show()
            }
        }
    }

    var isFrontmost: Bool {
        window.isVisible && window.isKeyWindow && NSApp.isActive
    }

    func toggle() {
        if isFrontmost {
            hide()
        } else {
            show()
        }
    }

    func show() {
        NSApp.unhide(nil)
        NSApp.activate()

        if window.isMiniaturized {
            window.deminiaturize(nil)
        }

        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        Logger.app.info("Main window shown")
    }

    func hide() {
        NSApp.hide(nil)
        Logger.app.info("Main window hidden")
    }

    func showSettings() {
        navigator.open(.settings)
        show()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        hide()

        return false
    }
}
