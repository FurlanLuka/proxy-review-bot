import Foundation

enum ExecutableLocator {
    static func locate(named name: String, inPath path: String) -> URL? {
        path
            .split(separator: ":")
            .map { URL(fileURLWithPath: String($0)).appendingPathComponent(name) }
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    static func locateBun(inPath path: String) -> URL {
        locate(named: "bun", inPath: path)
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bun/bin/bun")
    }
}
