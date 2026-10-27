import Foundation
import ProxyReviewBotCore
import XCTest

final class ServiceLaunchPlannerTests: XCTestCase {
    private let dataDirectory = URL(fileURLWithPath: "/Users/me/Library/Application Support/ProxyReviewBot")
    private let bunURL = URL(fileURLWithPath: "/Users/me/.bun/bin/bun")
    private let serviceDirectory = URL(fileURLWithPath: "/src/proxy-review-bot/service")

    private func inputs(bundlePath: String) -> ServiceLaunchInputs {
        ServiceLaunchInputs(
            bundleURL: URL(fileURLWithPath: bundlePath),
            dataDirectory: dataDirectory,
            developmentServiceDirectories: [URL(fileURLWithPath: "/missing"), serviceDirectory],
            bunURL: bunURL
        )
    }

    func testInstalledAppRunsTheBundledServiceWithNoArguments() {
        let result = ServiceLaunchPlanner.plan(
            for: inputs(bundlePath: "/Applications/ProxyReviewBot.app"),
            isExecutable: { _ in true },
            isDirectory: { _ in true }
        )

        XCTAssertEqual(
            try result.get(),
            ServiceLaunchPlan(
                executableURL: URL(fileURLWithPath: "/Applications/ProxyReviewBot.app/Contents/MacOS/proxy-review-bot-service"),
                arguments: [],
                workingDirectory: dataDirectory
            )
        )
    }

    func testInstalledAppWithoutTheBundledServiceFailsInsteadOfFallingBackToBun() {
        let result = ServiceLaunchPlanner.plan(
            for: inputs(bundlePath: "/Applications/ProxyReviewBot.app"),
            isExecutable: { _ in false },
            isDirectory: { _ in true }
        )

        XCTAssertEqual(result, .failure(.bundledServiceMissing))
        XCTAssertEqual(ServiceLaunchError.bundledServiceMissing.message, "The review service is missing from the app")
    }

    func testDevelopmentBuildRunsBunOnTheFirstServiceFolderThatExists() {
        let result = ServiceLaunchPlanner.plan(
            for: inputs(bundlePath: "/src/proxy-review-bot/app/.build/debug"),
            isExecutable: { _ in false },
            isDirectory: { $0 == self.serviceDirectory }
        )

        XCTAssertEqual(
            try result.get(),
            ServiceLaunchPlan(
                executableURL: bunURL,
                arguments: ["--no-env-file", "/src/proxy-review-bot/service/src/entry.ts"],
                workingDirectory: dataDirectory
            )
        )
    }

    func testDevelopmentBuildWithNoServiceFolderFails() {
        let result = ServiceLaunchPlanner.plan(
            for: inputs(bundlePath: "/tmp/debug"),
            isExecutable: { _ in true },
            isDirectory: { _ in false }
        )

        XCTAssertEqual(result, .failure(.developmentServiceMissing))
    }
}
