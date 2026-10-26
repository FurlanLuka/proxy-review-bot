import AppKit
import OSLog
import SwiftUI

@MainActor
enum SnapshotRenderer {
    static let environmentKey = "PRB_RENDER_SNAPSHOTS"

    static var outputDirectory: URL? {
        ProcessInfo.processInfo.environment[environmentKey].map { URL(fileURLWithPath: $0) }
    }

    static func renderWhenReady(model: BotModel, into directory: URL) {
        Task {
            while model.state == nil {
                try? await Task.sleep(for: .milliseconds(200))
            }

            try? await Task.sleep(for: .seconds(1))
            render(MenuContentView(model: model), name: "menu", into: directory)
            render(SettingsView(model: model), name: "settings", into: directory)
            NSApp.terminate(nil)
        }
    }

    private static func render<Content: View>(_ content: Content, name: String, into directory: URL) {
        let hostingView = NSHostingView(rootView: content.background(Color(nsColor: .windowBackgroundColor)))
        let size = hostingView.fittingSize
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )

        window.contentView = hostingView
        hostingView.frame = NSRect(origin: .zero, size: size)
        hostingView.layoutSubtreeIfNeeded()

        guard let bitmap = hostingView.bitmapImageRepForCachingDisplay(in: hostingView.bounds) else {
            Logger.app.error("Snapshot \(name, privacy: .public) could not allocate a bitmap")
            return
        }

        hostingView.cacheDisplay(in: hostingView.bounds, to: bitmap)

        let fileURL = directory.appendingPathComponent("\(name).png")

        do {
            try bitmap.representation(using: .png, properties: [:])?.write(to: fileURL)
            Logger.app.info("Snapshot written to \(fileURL.path, privacy: .public)")
        } catch {
            Logger.app.error("Snapshot \(name, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
        }
    }
}
