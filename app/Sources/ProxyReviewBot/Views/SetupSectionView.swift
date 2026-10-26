import ProxyReviewBotCore
import SwiftUI

struct SetupSectionView: View {
    @ObservedObject var model: BotModel
    let readiness: Readiness
    let waitingCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(readiness.checks) { check in
                SetupCheckRowView(check: check)
            }

            Button("Re-check") {
                model.checkReadiness()
            }
            .controlSize(.small)
        }
        .padding(12)

        Divider()

        if waitingCount > 0 {
            Text("\(waitingCount) waiting · reviews resume once fixed")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)

            Divider()
        }
    }
}
