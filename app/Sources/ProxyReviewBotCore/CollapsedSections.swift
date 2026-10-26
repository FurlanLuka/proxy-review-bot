public struct CollapsedSections: Equatable, Sendable {
    public private(set) var titles: Set<String>

    public init(storedValue: String) {
        titles = Set(storedValue.split(separator: "\n").map(String.init))
    }

    public var storedValue: String {
        titles.sorted().joined(separator: "\n")
    }

    public func isCollapsed(_ title: String) -> Bool {
        titles.contains(title)
    }

    public mutating func setCollapsed(_ isCollapsed: Bool, title: String) {
        if isCollapsed {
            titles.insert(title)
        } else {
            titles.remove(title)
        }
    }
}
