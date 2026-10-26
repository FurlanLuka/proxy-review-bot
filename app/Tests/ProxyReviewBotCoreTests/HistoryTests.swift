import Foundation
@testable import ProxyReviewBotCore
import XCTest

final class HistoryTests: XCTestCase {
    private let historyJSON = """
    {
        "entries": [
            {"id": 1, "owner": "acme", "repo": "api", "number": 412, "title": "Fix auth retry", "url": "https://github.com/acme/api/pull/412", "author": "ana", "outcome": "approved_by_bot", "rounds": 2, "finishedAt": 1793015179000},
            {"id": 2, "owner": "acme", "repo": "web", "number": 88, "title": "Onboarding copy", "url": "https://github.com/acme/web/pull/88", "author": "sam", "outcome": "rejected_somehow", "rounds": 1, "finishedAt": 1793015000000}
        ]
    }
    """

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    private func entry(id: Int, finishedAt date: Date, outcome: HistoryOutcome = .merged) -> HistoryEntry {
        HistoryEntry(
            id: id,
            owner: "acme",
            repo: "api",
            number: id,
            title: "Change \(id)",
            url: URL(string: "https://github.com/acme/api/pull/\(id)")!,
            author: "ana",
            outcome: outcome,
            rounds: 1,
            finishedAt: date.timeIntervalSince1970 * 1000
        )
    }

    func testDecodesEntriesAndToleratesUnknownOutcomes() throws {
        let response = try JSONDecoder().decode(HistoryResponse.self, from: Data(historyJSON.utf8))

        XCTAssertEqual(response.entries.map(\.outcome), [.approvedByBot, .unknown])
        XCTAssertEqual(response.entries[0].subtitle, "api #412 · @ana")
        XCTAssertEqual(response.entries[0].roundsText, "2 rounds")
        XCTAssertEqual(response.entries[1].roundsText, "1 round")
    }

    func testOutcomeNamesReadAsTheUserWouldSayThem() {
        XCTAssertEqual(HistoryOutcome.approvedByBot.displayName, "Approved by bot")
        XCTAssertEqual(HistoryOutcome.approvedByYou.displayName, "Approved")
        XCTAssertEqual(HistoryOutcome.merged.displayName, "Merged")
        XCTAssertEqual(HistoryOutcome.closed.displayName, "Closed")
        XCTAssertEqual(HistoryOutcome.takenOver.displayName, "You reviewed it")
        XCTAssertEqual(HistoryOutcome.stopped.displayName, "Stopped")
    }

    func testGroupsByDayNewestFirstWithFriendlyTitles() throws {
        let now = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 10, day: 26, hour: 15)))
        let earlierToday = now.addingTimeInterval(-3 * 3600)
        let laterToday = now.addingTimeInterval(-600)
        let yesterday = now.addingTimeInterval(-24 * 3600)
        let lastMonday = now.addingTimeInterval(-7 * 24 * 3600)

        let days = HistoryGrouping.days(
            for: [entry(id: 1, finishedAt: lastMonday), entry(id: 2, finishedAt: earlierToday), entry(id: 3, finishedAt: yesterday), entry(id: 4, finishedAt: laterToday)],
            now: now,
            calendar: calendar,
            locale: Locale(identifier: "en_GB")
        )

        XCTAssertEqual(days.map(\.title), ["Today", "Yesterday", "Mon 19 Oct"])
        XCTAssertEqual(days[0].entries.map(\.id), [4, 2])
        XCTAssertEqual(days[2].entries.map(\.id), [1])
    }

    func testNoEntriesGivesNoDays() {
        XCTAssertTrue(HistoryGrouping.days(for: [], now: Date(), calendar: calendar).isEmpty)
    }

    func testHistoryIsAGetRequest() {
        XCTAssertEqual(ServiceAction.fetchHistory.method, "GET")
        XCTAssertEqual(ServiceAction.fetchHistory.path, "/history")
        XCTAssertNil(try ServiceAction.fetchHistory.encodedBody())
    }

    func testFailedReviewHasItsOwnGlyph() {
        var failed = Fixtures.pullRequest(id: 1, status: .waitingOnAuthor)
        failed.reason = "Claude run timed out"

        XCTAssertEqual(failed.glyph, .failedReview)
        XCTAssertEqual(failed.glyph.accessibilityLabel, "Review failed")
        XCTAssertEqual(Fixtures.pullRequest(id: 2, status: .waitingOnAuthor).glyph, .status(.waitingOnAuthor))
        XCTAssertEqual(Fixtures.pullRequest(id: 3, status: .needsYou).glyph, .status(.needsYou))
    }
}
