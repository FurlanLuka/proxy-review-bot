public struct SectionPreview<Item> {
    public static var previewCount: Int { 3 }

    public let visibleItems: [Item]
    public let hiddenCount: Int
    public let canShowLess: Bool

    public init(items: [Item], isShowingAll: Bool) {
        visibleItems = isShowingAll ? items : Array(items.prefix(Self.previewCount))
        hiddenCount = items.count - visibleItems.count
        canShowLess = isShowingAll && items.count > Self.previewCount
    }
}
