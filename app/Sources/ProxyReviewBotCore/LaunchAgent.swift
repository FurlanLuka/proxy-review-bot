import Foundation

public struct LaunchAgent {
    public static let label = "com.furlanluka.proxy-review-bot"

    public let plistURL: URL

    public init(homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser) {
        plistURL = homeDirectory
            .appendingPathComponent("Library/LaunchAgents")
            .appendingPathComponent("\(Self.label).plist")
    }

    public var isInstalled: Bool {
        FileManager.default.fileExists(atPath: plistURL.path)
    }

    public static func propertyList(executablePath: String) -> [String: Any] {
        [
            "Label": label,
            "ProgramArguments": [executablePath],
            "RunAtLoad": true,
            "KeepAlive": ["SuccessfulExit": false],
            "LimitLoadToSessionType": "Aqua",
            "ProcessType": "Interactive",
        ]
    }

    public func install(executablePath: String) throws {
        let data = try PropertyListSerialization.data(
            fromPropertyList: Self.propertyList(executablePath: executablePath),
            format: .xml,
            options: 0
        )

        try FileManager.default.createDirectory(
            at: plistURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: plistURL, options: .atomic)
    }

    public func remove() throws {
        if isInstalled {
            try FileManager.default.removeItem(at: plistURL)
        }
    }
}
