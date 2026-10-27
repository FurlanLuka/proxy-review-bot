@testable import ProxyReviewBotCore
import XCTest

final class SettingsFlowTextTests: XCTestCase {
    func testHeaderTextNamesWhoStartsAndHowReviewsPost() {
        let cases: [(ReviewMode, PostReviewsMode, String)] = [
            (.manual, .ask, "You start reviews and post each draft"),
            (.manual, .auto, "You start reviews, they post on their own"),
            (.auto, .ask, "Reviews start on their own, you post each draft"),
            (.auto, .auto, "Reviews start and post on their own"),
        ]

        for (reviewMode, postReviews, expected) in cases {
            let settings = BotSettings(
                reviewMode: reviewMode,
                postReviews: postReviews,
                autoApprove: .off,
                smallPullRequestLineLimit: 200,
                maxRounds: 5,
                pollIntervalSeconds: 60,
                answerQuestions: true,
                watch: [],
                skip: [],
                toolPaths: ToolPaths()
            )

            XCTAssertEqual(settings.flowText, expected)
        }
    }
}
