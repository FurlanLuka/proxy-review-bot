import Foundation
import ProxyReviewBotCore

enum LoginItemCommand {
    static func runIfRequested(arguments: [String] = CommandLine.arguments) {
        guard let command = arguments.dropFirst().first(where: { $0.hasPrefix("--launch-at-login") }) else {
            return
        }

        exit(run(command) ? EXIT_SUCCESS : EXIT_FAILURE)
    }

    private static func run(_ command: String) -> Bool {
        let launchAgent = LaunchAgent()

        do {
            switch command {
            case "--launch-at-login-enable":
                try launchAgent.install(executablePath: Bundle.main.executablePath ?? CommandLine.arguments[0])
            case "--launch-at-login-disable":
                try launchAgent.remove()
            case "--launch-at-login-status":
                break
            default:
                print("Unknown command \(command)")
                return false
            }
        } catch {
            print("Launch at login change failed: \(error.localizedDescription)")
            return false
        }

        print("launch-at-login: \(launchAgent.isInstalled ? "enabled" : "disabled")")
        print("launch-agent: \(launchAgent.plistURL.path)")

        return true
    }
}
