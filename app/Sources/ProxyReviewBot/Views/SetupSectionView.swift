import ProxyReviewBotCore
import SwiftUI

struct SetupSectionView: View {
    @ObservedObject var model: BotModel
    let readiness: Readiness
    let waitingCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .foregroundStyle(Palette.peach.ink)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 1) {
                    Text("Finish setting up")
                        .font(MenuStyle.titleFont)

                    Text(waitingCount > 0 ? "\(waitingCount) waiting · reviews resume once fixed" : "Reviews start once these pass")
                        .font(MenuStyle.metaFont)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button {
                    model.checkReadiness()
                } label: {
                    Label("Check Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(PillButtonStyle())
            }

            ForEach(readiness.checks) { check in
                SetupCheckRowView(check: check)
            }
        }
        .padding(12)
        .card()
    }
}
