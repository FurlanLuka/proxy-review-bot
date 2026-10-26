import SwiftUI

struct MenuSectionHeader: View {
    let title: String
    var count: Int?
    var isExpanded: Binding<Bool>?

    @Environment(\.accessibilityReduceMotion) private var isReducingMotion

    var body: some View {
        if let isExpanded {
            Button {
                withAnimation(isReducingMotion ? nil : .easeInOut(duration: 0.15)) {
                    isExpanded.wrappedValue.toggle()
                }
            } label: {
                header(chevronExpanded: isExpanded.wrappedValue)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(isExpanded.wrappedValue ? "Expanded" : "Collapsed")
            .accessibilityHint(isExpanded.wrappedValue ? "Hides this section" : "Shows this section")
        } else {
            header(chevronExpanded: nil)
        }
    }

    private func header(chevronExpanded: Bool?) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(MenuStyle.sectionFont)
                .foregroundStyle(.secondary)

            if let count {
                Text("\(count)")
                    .font(.system(size: 10, weight: .bold).monospacedDigit())
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule(style: .circular).fill(Color.primary.opacity(0.08)))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if let chevronExpanded {
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.secondary)
                    .rotationEffect(.degrees(chevronExpanded ? 90 : 0))
            }
        }
        .padding(.horizontal, 4)
        .padding(.top, 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}
