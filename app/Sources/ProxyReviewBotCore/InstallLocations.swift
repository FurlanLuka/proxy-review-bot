import Foundation

public struct DataRemovalError: LocalizedError, Equatable {
    public let failedDirectories: [URL]

    public var errorDescription: String? {
        "Couldn't delete \(failedDirectories.map(\.path).joined(separator: ", "))"
    }
}

public struct InstallLocations {
    public let dataDirectory: URL
    public let logDirectory: URL

    public init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
        dataDirectory = homeDirectory.appendingPathComponent("Library/Application Support/ProxyReviewBot")
        logDirectory = homeDirectory.appendingPathComponent("Library/Logs/ProxyReviewBot")
    }

    public func removeData(removeItem: (URL) throws -> Void = { try FileManager.default.removeItem(at: $0) }) throws {
        var failedDirectories: [URL] = []

        for directory in [dataDirectory, logDirectory] where FileManager.default.fileExists(atPath: directory.path) {
            do {
                try removeItem(directory)
            } catch {
                failedDirectories.append(directory)
            }
        }

        if !failedDirectories.isEmpty {
            throw DataRemovalError(failedDirectories: failedDirectories)
        }
    }
}
