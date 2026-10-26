import AppKit
import ProxyReviewBotCore
import SwiftUI

struct SetupCheckRowView: View {
    let check: ReadinessCheck

    @State private var isCopied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: check.isOk ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(check.isOk ? Palette.sage.ink : Palette.rose.ink)
                    .accessibilityLabel(check.isOk ? "Passed" : "Failed")

                Text(check.label)
                    .font(MenuStyle.bodyFont)
            }
            .accessibilityElement(children: .combine)

            if let fix = check.fix, !check.isOk {
                HStack(spacing: 6) {
                    Text(fix)
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.vertical, 6)

                    Spacer(minLength: 4)

                    IconButton(
                        systemName: isCopied ? "checkmark" : "doc.on.doc",
                        label: isCopied ? "Copied" : "Copy Command",
                        help: isCopied ? "Copied" : "Copy Command",
                        tint: isCopied ? Palette.sage.ink : nil
                    ) {
                        copy(fix)
                    }
                }
                .padding(.leading, 10)
                .padding(.vertical, 2)
                .background(
                    RoundedRectangle(cornerRadius: MenuStyle.innerCornerRadius, style: .continuous)
                        .fill(Color.primary.opacity(0.06))
                )
                .padding(.leading, 24)
            }
        }
        .task(id: isCopied) {
            guard isCopied else {
                return
            }

            try? await Task.sleep(for: .seconds(1.5))
            isCopied = false
        }
    }

    private func copy(_ command: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command, forType: .string)
        isCopied = true
    }
}
