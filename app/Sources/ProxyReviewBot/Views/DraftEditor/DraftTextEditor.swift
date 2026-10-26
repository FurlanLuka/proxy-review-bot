import SwiftUI

struct DraftTextEditor: View {
    private static let font = Font.system(size: 13)
    private static let padding: CGFloat = 8
    private static let lineFragmentPadding: CGFloat = 5

    @Binding var text: String
    let minHeight: CGFloat
    let placeholder: String
    let accessibilityLabel: String

    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        ZStack(alignment: .topLeading) {
            Text(text + "\n")
                .font(Self.font)
                .padding(.horizontal, Self.lineFragmentPadding)
                .frame(maxWidth: .infinity, alignment: .leading)
                .hidden()

            if text.isEmpty {
                Text(placeholder)
                    .font(Self.font)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, Self.lineFragmentPadding)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }

            TextEditor(text: $text)
                .font(Self.font)
                .scrollContentBackground(.hidden)
                .scrollDisabled(true)
                .accessibilityLabel(accessibilityLabel)
        }
        .padding(Self.padding)
        .frame(minHeight: minHeight, alignment: .topLeading)
        .background(
            RoundedRectangle(cornerRadius: MenuStyle.innerCornerRadius, style: .continuous)
                .fill(Color.primary.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: MenuStyle.innerCornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(contrast == .increased ? 0.3 : 0.08))
        )
    }
}
