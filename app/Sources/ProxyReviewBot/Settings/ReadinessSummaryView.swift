import ProxyReviewBotCore
import SwiftUI

struct ReadinessSummaryView: View {
    let readiness: Readiness

    var body: some View {
        if readiness.checks.isEmpty {
            Text(readiness.status == .checking ? "Checking…" : "No checks reported")
                .foregroundStyle(.secondary)
        } else {
            ForEach(readiness.checks) { check in
                Label {
                    Text(check.label)
                } icon: {
                    Image(systemName: check.isOk ? "checkmark" : "xmark")
                        .foregroundStyle(check.isOk ? .green : .red)
                }
            }
        }
    }
}
