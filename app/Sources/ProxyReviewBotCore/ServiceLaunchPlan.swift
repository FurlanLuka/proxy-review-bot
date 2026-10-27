import Foundation

public struct ServiceLaunchPlan: Equatable, Sendable {
    public static let bundledExecutableName = "proxy-review-bot-service"

    public let executableURL: URL
    public let arguments: [String]
    public let workingDirectory: URL

    public init(executableURL: URL, arguments: [String], workingDirectory: URL) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.workingDirectory = workingDirectory
    }
}

public enum ServiceLaunchError: Error, Equatable, Sendable {
    case bundledServiceMissing
    case developmentServiceMissing

    public var message: String {
        switch self {
        case .bundledServiceMissing:
            return "The review service is missing from the app"
        case .developmentServiceMissing:
            return "The review service source folder wasn't found"
        }
    }
}

public struct ServiceLaunchInputs: Sendable {
    public let bundleURL: URL
    public let dataDirectory: URL
    public let developmentServiceDirectories: [URL]
    public let bunURL: URL

    public init(bundleURL: URL, dataDirectory: URL, developmentServiceDirectories: [URL], bunURL: URL) {
        self.bundleURL = bundleURL
        self.dataDirectory = dataDirectory
        self.developmentServiceDirectories = developmentServiceDirectories
        self.bunURL = bunURL
    }

    public var isAppBundle: Bool {
        bundleURL.pathExtension == "app"
    }

    public var bundledExecutableURL: URL {
        bundleURL.appendingPathComponent("Contents/MacOS/\(ServiceLaunchPlan.bundledExecutableName)")
    }
}

public enum ServiceLaunchPlanner {
    public static func plan(
        for inputs: ServiceLaunchInputs,
        isExecutable: (URL) -> Bool,
        isDirectory: (URL) -> Bool
    ) -> Result<ServiceLaunchPlan, ServiceLaunchError> {
        if inputs.isAppBundle {
            let executableURL = inputs.bundledExecutableURL

            guard isExecutable(executableURL) else {
                return .failure(.bundledServiceMissing)
            }

            return .success(ServiceLaunchPlan(executableURL: executableURL, arguments: [], workingDirectory: inputs.dataDirectory))
        }

        guard let serviceDirectory = inputs.developmentServiceDirectories.first(where: isDirectory) else {
            return .failure(.developmentServiceMissing)
        }

        let arguments = ["--no-env-file", serviceDirectory.appendingPathComponent("src/entry.ts").path]

        return .success(ServiceLaunchPlan(executableURL: inputs.bunURL, arguments: arguments, workingDirectory: inputs.dataDirectory))
    }
}
