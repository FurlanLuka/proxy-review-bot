import SwiftUI

struct PillSegmentedPicker<Value: Hashable>: View {
    let label: String
    let options: [(value: Value, title: String)]
    @Binding var selection: Value
    let tint: PastelColor

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        HStack(spacing: 2) {
            ForEach(options, id: \.value) { option in
                segment(option)
            }
        }
        .background(Capsule(style: .circular).fill(Color.primary.opacity(0.06)))
        .overlay(Capsule(style: .circular).strokeBorder(Color.primary.opacity(MenuStyle.strokeOpacity(for: contrast))))
        .accessibilityRepresentation {
            Picker(label, selection: $selection) {
                ForEach(options, id: \.value) { option in
                    Text(option.title).tag(option.value)
                }
            }
            .pickerStyle(.segmented)
        }
    }

    private func segment(_ option: (value: Value, title: String)) -> some View {
        let isSelected = option.value == selection

        return Button {
            selection = option.value
        } label: {
            Text(option.title)
        }
        .buttonStyle(SegmentButtonStyle(isSelected: isSelected, tint: tint))
        .help("\(label): \(option.title)")
    }
}

private struct SegmentButtonStyle: ButtonStyle {
    let isSelected: Bool
    let tint: PastelColor

    @Environment(\.isFocused) private var isFocused

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(MenuStyle.labelFont)
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .foregroundStyle(isSelected ? tint.ink : Color.primary.opacity(0.7))
            .background(Capsule(style: .circular).fill(isSelected ? tint.tint.opacity(MenuStyle.pillFillOpacity) : Color.clear))
            .overlay {
                if isFocused {
                    Capsule(style: .circular)
                        .strokeBorder(Color(nsColor: .keyboardFocusIndicatorColor), lineWidth: 2)
                }
            }
            .opacity(configuration.isPressed ? 0.75 : 1)
            .contentShape(Capsule(style: .circular))
    }
}
