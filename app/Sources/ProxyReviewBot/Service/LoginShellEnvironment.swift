import Foundation
import OSLog

enum LoginShellEnvironment {
    static let fallbackPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

    static func resolvePath() -> String {
        let process = Process()
        let outputPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", #"printf %s "$PATH""#]
        process.standardOutput = outputPipe
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            Logger.service.error("Could not run the login shell: \(error.localizedDescription, privacy: .public)")
            return fallbackPath
        }

        let output = outputPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()

        guard process.terminationStatus == 0,
              let path = String(data: output, encoding: .utf8),
              !path.isEmpty
        else {
            Logger.service.error("The login shell returned no PATH, using the fallback")
            return fallbackPath
        }

        return path
    }
}
