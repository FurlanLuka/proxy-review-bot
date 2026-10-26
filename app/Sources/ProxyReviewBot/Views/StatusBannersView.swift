import SwiftUI

struct StatusBannersView: View {
    @ObservedObject var model: BotModel

    var body: some View {
        if !messages.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(messages, id: \.self) { message in
                    Label(message, systemImage: "exclamationmark.circle")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.quaternary.opacity(0.5))

            Divider()
        }
    }

    private var messages: [String] {
        var messages: [String] = []

        if let state = model.state {
            if state.isPaused {
                messages.append("Paused")
            }

            if let usageLimitedUntil = state.usageLimitedUntilDate {
                messages.append("Usage limit, resumes at \(usageLimitedUntil.formatted(date: .omitted, time: .shortened))")
            }
        }

        if let actionMessage = model.actionMessage {
            messages.append(actionMessage)
        }

        return messages
    }
}
