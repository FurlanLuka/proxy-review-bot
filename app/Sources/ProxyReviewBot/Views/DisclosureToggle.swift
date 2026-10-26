import SwiftUI

struct DisclosureToggle: View {
    let title: String
    let hint: String
    @Binding var isExpanded: Bool

    @Environment(\.accessibilityReduceMotion) private var isReducingMotion

    var body: some View {
        Button {
            withAnimation(isReducingMotion ? nil : .easeInOut(duration: 0.15)) {
                isExpanded.toggle()
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .rotationEffect(.degrees(isExpanded ? 90 : 0))

                Text(title)
                    .font(MenuStyle.metaFont)
                    .lineLimit(1)
            }
            .foregroundStyle(.secondary)
            .frame(minHeight: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint(hint)
    }
}
