import AppKit
import OSLog
import SwiftUI

struct MenuWindowTopAnchor: NSViewRepresentable {
    func makeNSView(context: Context) -> AnchorView {
        AnchorView()
    }

    func updateNSView(_ nsView: AnchorView, context: Context) {}

    final class AnchorView: NSView {
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeObservers()

            guard let window else {
                return
            }

            let center = NotificationCenter.default
            observers = [NSWindow.didResizeNotification, NSWindow.didMoveNotification].map { name in
                center.addObserver(forName: name, object: window, queue: .main) { [weak window] _ in
                    MainActor.assumeIsolated {
                        if let window {
                            Self.pinUnderMenuBar(window)
                        }
                    }
                }
            }
        }

        static func pinUnderMenuBar(_ window: NSWindow) {
            guard window.isVisible, let screen = window.screen else {
                return
            }

            let menuBarBottom = screen.visibleFrame.maxY
            let frame = window.frame
            let hasSlippedDown = frame.maxY < menuBarBottom - 6
            let fitsBelowMenuBar = frame.height <= menuBarBottom - screen.frame.minY

            guard hasSlippedDown, fitsBelowMenuBar else {
                return
            }

            Logger.app.info("Menu slipped \(menuBarBottom - frame.maxY, privacy: .public)pt below the menu bar; moving it back")
            window.setFrameTopLeftPoint(NSPoint(x: frame.minX, y: menuBarBottom - 2))
        }

        private func removeObservers() {
            for observer in observers {
                NotificationCenter.default.removeObserver(observer)
            }

            observers = []
        }
    }
}
