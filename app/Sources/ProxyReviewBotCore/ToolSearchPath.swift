import Foundation

public enum ToolSearchPath {
    public static let marker = "__PRB_PATH__"

    public static func extract(fromShellOutput output: String) -> String? {
        let parts = output.components(separatedBy: marker)

        guard parts.count >= 3 else {
            return nil
        }

        let path = parts[parts.count - 2].trimmingCharacters(in: .whitespacesAndNewlines)

        return path.isEmpty ? nil : path
    }

    public static func withKnownLocations(_ path: String, homeDirectory: String) -> String {
        let knownLocations = [
            "\(homeDirectory)/.local/bin",
            "\(homeDirectory)/.claude/local",
            "\(homeDirectory)/.bun/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
        ]
        let entries = path.split(separator: ":").map(String.init)
        let missing = knownLocations.filter { !entries.contains($0) }

        return (entries + missing).joined(separator: ":")
    }
}
