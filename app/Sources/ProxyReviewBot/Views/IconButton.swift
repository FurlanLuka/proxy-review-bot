import SwiftUI

struct IconButton: View {
    let systemName: String
    let label: String
    let help: String
    var role: ButtonRole?
    var tint: Color?
    var size: CGFloat = 28
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(role: role, action: action) {
            Image(systemName: systemName)
                .font(.system(size: size * 13 / 28, weight: size < 28 ? .semibold : .medium))
        }
        .buttonStyle(IconButtonStyle(isHovered: isHovered, tint: tint, size: size))
        .help(help)
        .accessibilityLabel(label)
        .onHover { isHovered = $0 }
    }
}

private struct IconButtonStyle: ButtonStyle {
    let isHovered: Bool
    let tint: Color?
    let size: CGFloat

    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(tint ?? Color.secondary)
            .frame(width: size, height: size)
            .background(Circle().fill(Color.primary.opacity(isHovered ? 0.1 : 0)))
            .overlay {
                if isFocused {
                    Circle()
                        .strokeBorder(Color(nsColor: .keyboardFocusIndicatorColor), lineWidth: 2)
                }
            }
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Circle())
    }
}
