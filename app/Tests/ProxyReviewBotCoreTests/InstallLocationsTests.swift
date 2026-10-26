import Foundation
import ProxyReviewBotCore
import XCTest

final class InstallLocationsTests: XCTestCase {
    func testPathsMatchTheServiceDefaults() {
        let locations = InstallLocations(homeDirectory: URL(fileURLWithPath: "/Users/ana"))

        XCTAssertEqual(locations.dataDirectory.path, "/Users/ana/Library/Application Support/ProxyReviewBot")
        XCTAssertEqual(locations.logDirectory.path, "/Users/ana/Library/Logs/ProxyReviewBot")
    }

    func testRemoveDataDeletesBothFoldersAndToleratesMissingOnes() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let locations = InstallLocations(homeDirectory: home)

        try FileManager.default.createDirectory(at: locations.dataDirectory, withIntermediateDirectories: true)
        try Data("db".utf8).write(to: locations.dataDirectory.appendingPathComponent("bot.sqlite"))
        try FileManager.default.createDirectory(at: locations.logDirectory, withIntermediateDirectories: true)
        try Data("log".utf8).write(to: locations.logDirectory.appendingPathComponent("service.log"))

        try locations.removeData()

        XCTAssertFalse(FileManager.default.fileExists(atPath: locations.dataDirectory.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: locations.logDirectory.path))

        try locations.removeData()
        try FileManager.default.removeItem(at: home)
    }

    func testOneFailedFolderDoesNotStopTheOtherAndIsReported() throws {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let locations = InstallLocations(homeDirectory: home)
        try FileManager.default.createDirectory(at: locations.dataDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: locations.logDirectory, withIntermediateDirectories: true)

        XCTAssertThrowsError(try locations.removeData { directory in
            if directory == locations.dataDirectory {
                throw CocoaError(.fileWriteNoPermission)
            }

            try FileManager.default.removeItem(at: directory)
        }) { error in
            XCTAssertEqual((error as? DataRemovalError)?.failedDirectories, [locations.dataDirectory])
        }

        XCTAssertTrue(FileManager.default.fileExists(atPath: locations.dataDirectory.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: locations.logDirectory.path))

        try FileManager.default.removeItem(at: home)
    }
}
