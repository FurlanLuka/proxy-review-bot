import Foundation

struct ServiceLaunchConfiguration: Sendable {
    let bunURL: URL
    let serviceDirectory: URL
    let path: String

    static func resolve() -> ServiceLaunchConfiguration? {
        guard let serviceDirectory = ServiceDirectoryLocator.locate() else {
            return nil
        }

        let path = LoginShellEnvironment.resolvePath()

        return ServiceLaunchConfiguration(
            bunURL: ExecutableLocator.locateBun(inPath: path),
            serviceDirectory: serviceDirectory,
            path: path
        )
    }
}
