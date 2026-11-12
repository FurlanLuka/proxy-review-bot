import Foundation

/// The developer's own review instructions: the service keeps up to 4000 UTF-16 units, trimmed.
public enum ReviewInstructions {
    /// Matches the service's limit, which zod counts in UTF-16 units: an emoji counts as two
    public static let characterLimit = 4000
    public static let placeholder = "e.g. Keep comments short and friendly. Skip nitpicks about naming."

    /// Typing past the limit is cut off at a whole character, so a save never gets refused and emoji never split.
    public static func clamped(_ text: String) -> String {
        guard text.utf16.count > characterLimit else {
            return text
        }

        var length = 0
        var end = text.startIndex

        for character in text {
            let characterLength = character.utf16.count

            if length + characterLength > characterLimit {
                break
            }

            length += characterLength
            end = text.index(after: end)
        }

        return String(text[..<end])
    }

    public static func counterText(for text: String) -> String {
        "\(text.utf16.count) / \(characterLimit)"
    }
}
