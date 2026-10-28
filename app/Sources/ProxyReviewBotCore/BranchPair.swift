import Foundation

public struct BranchPair: Codable, Equatable, Hashable, Sendable {
    private static let separators = ["→", "->", ":"]

    public var head: String
    public var base: String

    public init(head: String, base: String) {
        self.head = head
        self.base = base
    }

    public init?(text: String) {
        guard let separator = Self.separators.first(where: text.contains) else {
            return nil
        }

        let parts = text.components(separatedBy: separator).map { $0.trimmingCharacters(in: .whitespaces) }

        guard parts.count == 2, parts.allSatisfy(Self.isBranchName) else {
            return nil
        }

        self.init(head: parts[0], base: parts[1])
    }

    public var text: String {
        "\(head) → \(base)"
    }

    public static func normalize(_ text: String) -> String? {
        BranchPair(text: text)?.text
    }

    private static func isBranchName(_ name: String) -> Bool {
        !name.isEmpty && !name.contains(where: \.isWhitespace) && !separators.contains(where: name.contains)
    }
}
