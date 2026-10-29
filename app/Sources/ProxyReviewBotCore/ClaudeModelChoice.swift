public struct ClaudeModelChoice: Hashable, Sendable {
    public static let presets = [
        ClaudeModelChoice(model: nil, title: "Claude Code default"),
        ClaudeModelChoice(model: "fable", title: "Fable"),
        ClaudeModelChoice(model: "opus", title: "Opus"),
        ClaudeModelChoice(model: "sonnet", title: "Sonnet"),
        ClaudeModelChoice(model: "haiku", title: "Haiku"),
    ]

    public let model: String?
    public let title: String

    public static func choices(saved: String?) -> [ClaudeModelChoice] {
        guard let saved, !presets.contains(where: { $0.model == saved }) else {
            return presets
        }

        return presets + [ClaudeModelChoice(model: saved, title: saved)]
    }
}
