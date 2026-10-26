import AppKit
import ProxyReviewBotCore
import SwiftUI

struct SetupCheckRowView: View {
    let check: ReadinessCheck

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Label {
                Text(check.label)
            } icon: {
                Image(systemName: check.isOk ? "checkmark" : "xmark")
                    .foregroundStyle(check.isOk ? .green : .red)
            }

            if let fix = check.fix, !check.isOk {
                HStack(alignment: .firstTextBaseline) {
                    Text("Run: \(fix)")
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)

                    Spacer()

                    Button("Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(fix, forType: .string)
                    }
                    .controlSize(.small)
                }
                .padding(.leading, 24)
            }
        }
    }
}
