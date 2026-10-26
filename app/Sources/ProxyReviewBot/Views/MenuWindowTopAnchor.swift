import AppKit
import SwiftUI

struct MenuWindowTopAnchor: NSViewRepresentable {
    func makeNSView(context: Context) -> AnchorView {
        AnchorView()
    }

    func updateNSView(_ nsView: AnchorView, context: Context) {}

    final class AnchorView: NSView {
        private var anchoredTop: CGFloat?
        private var observers: [NSObjectProtocol] = []

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeObservers()

            guard let window else {
                return
            }

            let center = NotificationCenter.default
            anchoredTop = window.isKeyWindow ? window.frame.maxY : nil
            observers = [
                center.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self, weak window] _ in
                    MainActor.assumeIsolated {
                        self?.anchoredTop = window?.frame.maxY
                    }
                },
                center.addObserver(forName: NSWindow.didResignKeyNotification, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated {
                        self?.anchoredTop = nil
                    }
                },
                center.addObserver(forName: NSWindow.didChangeScreenNotification, object: window, queue: .main) { [weak self, weak window] _ in
                    MainActor.assumeIsolated {
                        if window?.isKeyWindow == true {
                            self?.anchoredTop = window?.frame.maxY
                        }
                    }
                },
                center.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self, weak window] _ in
                    MainActor.assumeIsolated {
                        if let window {
                            self?.keepTop(of: window)
                        }
                    }
                },
            ]
        }

        private func keepTop(of window: NSWindow) {
            guard let anchoredTop, abs(window.frame.maxY - anchoredTop) > 0.5 else {
                return
            }

            window.setFrameTopLeftPoint(NSPoint(x: window.frame.minX, y: anchoredTop))
        }

        private func removeObservers() {
            for observer in observers {
                NotificationCenter.default.removeObserver(observer)
            }

            observers = []
        }
    }
}
