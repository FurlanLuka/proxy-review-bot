import ProxyReviewBotCore
import XCTest

final class CollapsedSectionsTests: XCTestCase {
    func testNothingIsCollapsedByDefault() {
        XCTAssertFalse(CollapsedSections(storedValue: "").isCollapsed("In review"))
    }

    func testCollapsedTitlesSurviveARoundTrip() {
        var sections = CollapsedSections(storedValue: "")
        sections.setCollapsed(true, title: "Ready to review")
        sections.setCollapsed(true, title: "In review")
        sections.setCollapsed(false, title: "In review")

        let restored = CollapsedSections(storedValue: sections.storedValue)

        XCTAssertTrue(restored.isCollapsed("Ready to review"))
        XCTAssertFalse(restored.isCollapsed("In review"))
    }
}
