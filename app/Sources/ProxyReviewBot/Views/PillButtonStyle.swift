import SwiftUI

struct PillButtonStyle: ButtonStyle {
    var isProminent = false
    var tint: PastelColor?

    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var isFocused
    @Environment(\.colorSchemeContrast) private var contrast

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(MenuStyle.labelFont)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .foregroundStyle(foreground)
            .background(Capsule(style: .circular).fill(fill))
            .overlay(Capsule(style: .circular).strokeBorder(stroke))
            .overlay {
                if isFocused {
                    Capsule(style: .circular)
                        .strokeBorder(Color(nsColor: .keyboardFocusIndicatorColor), lineWidth: 2)
                }
            }
            .opacity(opacity(isPressed: configuration.isPressed))
            .contentShape(Capsule(style: .circular))
    }

    private var prominentTint: PastelColor? {
        isProminent ? tint : nil
    }

    private var foreground: Color {
        prominentTint?.ink ?? Color.primary.opacity(0.8)
    }

    private var fill: Color {
        prominentTint.map { $0.tint.opacity(MenuStyle.pillFillOpacity) } ?? Color.primary.opacity(0.06)
    }

    private var stroke: Color {
        guard let prominentTint else {
            return Color.primary.opacity(MenuStyle.strokeOpacity(for: contrast))
        }

        return prominentTint.tint.opacity(MenuStyle.prominentStrokeOpacity(for: contrast))
    }

    private func opacity(isPressed: Bool) -> Double {
        guard isEnabled else {
            return 0.45
        }

        return isPressed ? 0.75 : 1
    }
}

struct AnyLabelStyle: LabelStyle {
    private let makeLabel: (Configuration) -> AnyView

    init(_ style: some LabelStyle) {
        makeLabel = { AnyView(style.makeBody(configuration: $0)) }
    }

    func makeBody(configuration: Configuration) -> some View {
        makeLabel(configuration)
    }
}
