import Foundation
import OSLog
import ProxyReviewBotCore

enum LoginShellEnvironment {
    static let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    private static let shellTimeout: TimeInterval = 10

    static func resolvePath() -> String {
        let homeDirectory = FileManager.default.homeDirectoryForCurrentUser.path

        return ToolSearchPath.withKnownLocations(readShellPath() ?? fallbackPath, homeDirectory: homeDirectory)
    }

    private static func readShellPath() -> String? {
        let process = Process()
        let outputPipe = Pipe()
        let marker = ToolSearchPath.marker
        process.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        process.arguments = ["-ilc", "printf '\(marker)%s\(marker)' \"$PATH\""]
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            Logger.service.error("Could not run the login shell: \(error.localizedDescription, privacy: .public)")
            return nil
        }

        DispatchQueue.global().asyncAfter(deadline: .now() + shellTimeout) {
            if process.isRunning {
                process.terminate()
            }
        }

        let output = outputPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard let path = ToolSearchPath.extract(fromShellOutput: String(decoding: output, as: UTF8.self)) else {
            Logger.service.error("The login shell returned no PATH, using the fallback")
            return nil
        }

        return path
    }
}
