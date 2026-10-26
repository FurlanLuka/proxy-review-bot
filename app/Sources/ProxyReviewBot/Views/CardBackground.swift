import SwiftUI

struct CardBackground: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: MenuStyle.cardCornerRadius, style: .continuous)
                    .fill(Color.primary.opacity(0.05))
            )
            .overlay(
                RoundedRectangle(cornerRadius: MenuStyle.cardCornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(MenuStyle.strokeOpacity(for: contrast)))
            )
    }
}

extension View {
    func card() -> some View {
        modifier(CardBackground())
    }
}
