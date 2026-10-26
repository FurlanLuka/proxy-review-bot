import Foundation

enum ServiceDirectoryLocator {
    static func locate() -> URL? {
        candidates().first { isDirectory($0) }
    }

    private static func candidates() -> [URL] {
        let bundledDirectory = Bundle.main.resourceURL?.appendingPathComponent("service")
        let environmentDirectory = ProcessInfo.processInfo.environment["PRB_SERVICE_DIR"].map { URL(fileURLWithPath: $0) }

        return [bundledDirectory, environmentDirectory, sourceTreeDirectory()].compactMap { $0 }
    }

    private static func sourceTreeDirectory() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("service")
            .standardizedFileURL
    }

    private static func isDirectory(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && isDirectory.boolValue
    }
}
