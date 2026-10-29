import XCTest
@testable import ProxyReviewBotCore

final class UpdateStateTests: XCTestCase {
    private let updateJSON = """
    {
        "currentVersion": "0.6.0", "latestVersion": "0.6.1", "isUpdateAvailable": true, "canInstall": true,
        "cannotInstallReason": null, "phase": "waiting_for_reviews", "lastCheckedAt": 1000, "error": null,
        "lastUpdate": { "version": "0.6.0", "didSucceed": true }
    }
    """

    func testDecodesTheServiceUpdateState() throws {
        let update = try JSONDecoder().decode(UpdateState.self, from: Data(updateJSON.utf8))

        XCTAssertEqual(update.phase, .waitingForReviews)
        XCTAssertEqual(update.latestVersion, "0.6.1")
        XCTAssertEqual(update.lastUpdate, LastUpdate(version: "0.6.0", didSucceed: true))
    }

    func testAnUnknownPhaseReadsAsIdle() throws {
        let json = updateJSON.replacingOccurrences(of: "waiting_for_reviews", with: "rebooting")

        XCTAssertEqual(try JSONDecoder().decode(UpdateState.self, from: Data(json.utf8)).phase, .idle)
    }

    func testOlderServiceWithoutUpdateStateDecodes() throws {
        let json = """
        {
            "viewerLogin": null, "isPaused": false, "usageLimitedUntil": null,
            "readiness": { "status": "ready", "checks": [] },
            "settings": {
                "reviewMode": "manual", "postReviews": "ask", "autoApprove": "off", "smallPullRequestLineLimit": 200,
                "maxRounds": 5, "pollIntervalSeconds": 60, "answerQuestions": true, "watch": [], "skip": [],
                "toolPaths": { "claude": null, "gh": null, "git": null }
            },
            "pullRequests": []
        }
        """
        let state = try JSONDecoder().decode(BotState.self, from: Data(json.utf8))

        XCTAssertNil(state.update)
        XCTAssertNil(state.settings.autoUpdate)
    }

    func testStatusTextForEachState() {
        XCTAssertEqual(UpdateState(currentVersion: "0.6.0").statusText, "Version 0.6.0")
        XCTAssertEqual(UpdateState(currentVersion: "0.6.0", latestVersion: "0.6.0").statusText, "Version 0.6.0 · Up to date")
        XCTAssertEqual(
            UpdateState(currentVersion: "0.6.0", latestVersion: "0.6.1", isUpdateAvailable: true).statusText,
            "Version 0.6.1 is available"
        )

        let phases: [(UpdatePhase, String)] = [
            (.checking, "Checking for updates…"),
            (.waitingForReviews, "Updating to 0.6.1 after the current review…"),
            (.downloading, "Downloading 0.6.1…"),
            (.installing, "Installing 0.6.1. The app restarts on its own."),
            (.failed, "Couldn't download v0.6.1: HTTP 404"),
        ]

        for (phase, text) in phases {
            let update = UpdateState(
                currentVersion: "0.6.0",
                latestVersion: "0.6.1",
                isUpdateAvailable: true,
                phase: phase,
                error: phase == .failed ? "Couldn't download v0.6.1: HTTP 404" : nil
            )

            XCTAssertEqual(update.statusText, text, "\(phase)")
        }
    }

    func testAnUnfinishedUpdateIsReportedWithTheLogPath() {
        let update = UpdateState(
            currentVersion: "0.6.0",
            latestVersion: "0.6.1",
            isUpdateAvailable: true,
            lastUpdate: LastUpdate(version: "0.6.1", didSucceed: false)
        )

        XCTAssertEqual(update.statusText, "The update to 0.6.1 didn't finish. See ~/Library/Logs/ProxyReviewBot/update.log")
        XCTAssertNil(update.successNotice)
    }

    func testTheUnfinishedWarningGivesWayOnceThatVersionIsNoLongerOnOffer() {
        let unfinished = LastUpdate(version: "0.6.1", didSucceed: false)
        let notCheckedYet = UpdateState(currentVersion: "0.6.0", lastUpdate: unfinished)
        let newerRelease = UpdateState(
            currentVersion: "0.6.0",
            latestVersion: "0.6.2",
            isUpdateAvailable: true,
            lastUpdate: unfinished
        )
        let upToDate = UpdateState(currentVersion: "0.6.1", latestVersion: "0.6.1", lastUpdate: unfinished)

        XCTAssertEqual(notCheckedYet.statusText, "Version 0.6.0")
        XCTAssertEqual(newerRelease.statusText, "Version 0.6.2 is available")
        XCTAssertEqual(upToDate.statusText, "Version 0.6.1 · Up to date")
    }

    func testButtonOffersTheUpdateOnlyWhenItCanBeInstalled() {
        let available = UpdateState(currentVersion: "0.6.0", latestVersion: "0.6.1", isUpdateAvailable: true)
        let devRun = UpdateState(
            currentVersion: "0.6.0",
            latestVersion: "0.6.1",
            isUpdateAvailable: true,
            canInstall: false,
            cannotInstallReason: "Updates work only in the installed app"
        )

        XCTAssertEqual(available.button, .install)
        XCTAssertEqual(available.button.title, "Update now")
        XCTAssertEqual(devRun.button, .check)
        XCTAssertEqual(UpdateState(currentVersion: "0.6.0").button.title, "Check for updates")
    }

    func testButtonIsDisabledWhileBusy() {
        XCTAssertTrue(UpdateState(currentVersion: "0.6.0", phase: .idle).isButtonEnabled)
        XCTAssertTrue(UpdateState(currentVersion: "0.6.0", phase: .failed).isButtonEnabled)

        for phase in [UpdatePhase.checking, .waitingForReviews, .downloading, .installing] {
            XCTAssertFalse(UpdateState(currentVersion: "0.6.0", phase: phase).isButtonEnabled, "\(phase)")
        }
    }

    func testAFinishedUpdateIsAnnounced() {
        let update = UpdateState(currentVersion: "0.6.1", lastUpdate: LastUpdate(version: "0.6.1", didSucceed: true))

        XCTAssertEqual(
            update.successNotice,
            Notice(identifier: "update-0.6.1", title: "Updated to 0.6.1", body: "Proxy Review Bot installed the update and restarted.")
        )
    }

    func testUpdateActionsHitTheServiceRoutes() {
        XCTAssertEqual(ServiceAction.checkForUpdate.path, "/update/check")
        XCTAssertEqual(ServiceAction.installUpdate.path, "/update/install")
        XCTAssertEqual(ServiceAction.installUpdate.method, "POST")
    }

    func testAutoUpdateSettingRoundTrips() throws {
        let json = """
        {
            "reviewMode": "manual", "postReviews": "ask", "autoApprove": "off", "smallPullRequestLineLimit": 200,
            "maxRounds": 5, "pollIntervalSeconds": 60, "answerQuestions": true, "watch": [], "skip": [],
            "toolPaths": { "claude": null, "gh": null, "git": null }, "autoUpdate": false
        }
        """
        let settings = try JSONDecoder().decode(BotSettings.self, from: Data(json.utf8))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(settings)) as? [String: Any]

        XCTAssertEqual(settings.autoUpdate, false)
        XCTAssertEqual(encoded?["autoUpdate"] as? Bool, false)
    }
}
