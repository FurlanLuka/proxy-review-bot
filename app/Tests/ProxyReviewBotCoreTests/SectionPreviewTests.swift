import ProxyReviewBotCore
import XCTest

final class SectionPreviewTests: XCTestCase {
    func testShowsTheFirstThreeAndCountsTheRest() {
        let preview = SectionPreview(items: [1, 2, 3, 4, 5], isShowingAll: false)

        XCTAssertEqual(preview.visibleItems, [1, 2, 3])
        XCTAssertEqual(preview.hiddenCount, 2)
    }

    func testShowingAllHidesNothing() {
        let preview = SectionPreview(items: [1, 2, 3, 4, 5], isShowingAll: true)

        XCTAssertEqual(preview.visibleItems.count, 5)
        XCTAssertEqual(preview.hiddenCount, 0)
        XCTAssertTrue(preview.canShowLess)
    }

    func testShortSectionsNeedNoButton() {
        XCTAssertEqual(SectionPreview(items: [1, 2], isShowingAll: false).hiddenCount, 0)
        XCTAssertFalse(SectionPreview(items: [1, 2, 3], isShowingAll: true).canShowLess)
    }
}
