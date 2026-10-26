import Foundation

public enum ServiceLogLine {
    public enum Level: Equatable, Sendable {
        case info
        case warning
        case error
    }

    private struct Entry: Decodable {
        let level: String
    }

    public static func level(of line: String) -> Level {
        guard let entry = try? JSONDecoder().decode(Entry.self, from: Data(line.utf8)) else {
            return .error
        }

        switch entry.level {
        case "info":
            return .info
        case "warn":
            return .warning
        default:
            return .error
        }
    }
}
