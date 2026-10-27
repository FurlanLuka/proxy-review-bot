import Foundation
import OSLog
import ProxyReviewBotCore

struct ServiceLaunchConfiguration: Sendable {
    let plan: ServiceLaunchPlan
    let path: String

    static func resolve() -> Result<ServiceLaunchConfiguration, ServiceLaunchError> {
        let path = LoginShellEnvironment.resolvePath()
        let environment = ProcessInfo.processInfo.environment
        let dataDirectory = environment["PRB_DATA_DIR"].map { URL(fileURLWithPath: $0) } ?? InstallLocations().dataDirectory
        createDirectory(dataDirectory)

        let environmentServiceDirectory = environment["PRB_SERVICE_DIR"].map { URL(fileURLWithPath: $0) }
        let developmentServiceDirectories = [environmentServiceDirectory, sourceTreeServiceDirectory()].compactMap { $0 }
        let inputs = ServiceLaunchInputs(
            bundleURL: Bundle.main.bundleURL,
            dataDirectory: dataDirectory,
            developmentServiceDirectories: developmentServiceDirectories,
            bunURL: ExecutableLocator.locateBun(inPath: path)
        )

        return ServiceLaunchPlanner.plan(
            for: inputs,
            isExecutable: { FileManager.default.isExecutableFile(atPath: $0.path) },
            isDirectory: isDirectory
        )
        .map { ServiceLaunchConfiguration(plan: $0, path: path) }
    }

    private static func createDirectory(_ directory: URL) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            Logger.service.error("Could not create the data folder \(directory.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func sourceTreeServiceDirectory() -> URL {
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
