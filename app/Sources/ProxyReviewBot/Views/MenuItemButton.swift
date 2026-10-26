import SwiftUI

struct MenuItemButton: View {
    let title: String
    var shortcutHint: String?
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            HStack {
                Text(title)

                Spacer()

                if let shortcutHint {
                    Text(shortcutHint)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background(
                RoundedRectangle(cornerRadius: 5)
                    .fill(isHovered ? Color.accentColor.opacity(0.85) : .clear)
            )
            .foregroundStyle(isHovered ? Color.white : Color.primary)
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .padding(.horizontal, 5)
    }
}
