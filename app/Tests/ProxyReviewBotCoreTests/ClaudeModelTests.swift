import XCTest
@testable import ProxyReviewBotCore

final class ClaudeModelTests: XCTestCase {
    private let settingsJSON = """
    {
        "reviewMode": "auto", "postReviews": "ask", "autoApprove": "off", "smallPullRequestLineLimit": 200,
        "maxRounds": 5, "pollIntervalSeconds": 60, "answerQuestions": true, "watch": [], "skip": [],
        "toolPaths": { "claude": null, "gh": null, "git": null }
        %@
    }
    """

    func testNoSavedModelShowsClaudeCodeDefaultFirst() {
        let choices = ClaudeModelChoice.choices(saved: nil)

        XCTAssertEqual(choices.map(\.title), ["Claude Code default", "Fable", "Opus", "Sonnet", "Haiku"])
        XCTAssertEqual(choices.map(\.model), [nil, "fable", "opus", "sonnet", "haiku"])
    }

    func testSavedPresetAddsNoExtraChoice() {
        XCTAssertEqual(ClaudeModelChoice.choices(saved: "sonnet"), ClaudeModelChoice.presets)
    }

    func testSavedCustomModelIsKeptAsItsOwnChoice() {
        let choices = ClaudeModelChoice.choices(saved: "claude-opus-5-5")

        XCTAssertEqual(choices.last, ClaudeModelChoice(model: "claude-opus-5-5", title: "claude-opus-5-5"))
        XCTAssertEqual(choices.count, ClaudeModelChoice.presets.count + 1)
    }

    func testSettingsDecodeTheModelAndLeaveItOutWhenMissing() throws {
        let withModel = try JSONDecoder().decode(
            BotSettings.self,
            from: Data(String(format: settingsJSON, #", "claudeModel": "opus""#).utf8)
        )
        let nullModel = try JSONDecoder().decode(
            BotSettings.self,
            from: Data(String(format: settingsJSON, #", "claudeModel": null"#).utf8)
        )
        let older = try JSONDecoder().decode(BotSettings.self, from: Data(String(format: settingsJSON, "").utf8))
        let encodedWithModel = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(withModel)) as? [String: Any]
        )
        let encodedOlder = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(older)) as? [String: Any])

        XCTAssertEqual(withModel.claudeModel, "opus")
        XCTAssertNil(nullModel.claudeModel)
        XCTAssertNil(older.claudeModel)
        XCTAssertEqual(encodedWithModel["claudeModel"] as? String, "opus")
        XCTAssertNil(encodedOlder["claudeModel"])
    }

    func testSettingsDecodeReviewsAtOnceAndLeaveItOutWhenMissing() throws {
        let withLimit = try JSONDecoder().decode(
            BotSettings.self,
            from: Data(String(format: settingsJSON, #", "maxParallelReviews": 2"#).utf8)
        )
        let older = try JSONDecoder().decode(BotSettings.self, from: Data(String(format: settingsJSON, "").utf8))
        let encodedOlder = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(older)) as? [String: Any])

        XCTAssertEqual(withLimit.maxParallelReviews, 2)
        XCTAssertNil(older.maxParallelReviews)
        XCTAssertNil(encodedOlder["maxParallelReviews"])
    }

    func testSettingsDecodeReviewInstructionsAndLeaveThemOutWhenMissing() throws {
        let withInstructions = try JSONDecoder().decode(
            BotSettings.self,
            from: Data(String(format: settingsJSON, #", "reviewInstructions": "Be brief.""#).utf8)
        )
        let older = try JSONDecoder().decode(BotSettings.self, from: Data(String(format: settingsJSON, "").utf8))
        let encodedOlder = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(older)) as? [String: Any])

        XCTAssertEqual(withInstructions.reviewInstructions, "Be brief.")
        XCTAssertNil(older.reviewInstructions)
        XCTAssertNil(encodedOlder["reviewInstructions"])
    }

    func testReviewInstructionsAreCutAtTheLimitAndCounted() {
        let tooLong = String(repeating: "a", count: 4100)

        XCTAssertEqual(ReviewInstructions.clamped(tooLong).count, 4000)
        XCTAssertEqual(ReviewInstructions.clamped("Be brief."), "Be brief.")
        XCTAssertEqual(ReviewInstructions.counterText(for: "Be brief."), "9 / 4000")
    }

    func testReviewInstructionsCountAndCutInUtf16UnitsWithoutSplittingEmoji() {
        let emoji = String(repeating: "😀", count: 2001)
        let clamped = ReviewInstructions.clamped(emoji)

        XCTAssertLessThanOrEqual(clamped.utf16.count, 4000)
        XCTAssertEqual(clamped, String(repeating: "😀", count: 2000))
        XCTAssertTrue(clamped.unicodeScalars.allSatisfy { $0 == "😀".unicodeScalars.first })
        XCTAssertEqual(ReviewInstructions.counterText(for: "😀😀"), "4 / 4000")
    }
}
