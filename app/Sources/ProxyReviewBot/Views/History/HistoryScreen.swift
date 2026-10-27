import ProxyReviewBotCore
import SwiftUI

struct HistoryScreen: View {
    @ObservedObject var model: BotModel

    @State private var loadState = LoadState.loading

    private enum LoadState {
        case loading
        case loaded([HistoryEntry])
        case failed(String)
    }

    var body: some View {
        Group {
            switch loadState {
            case .loading:
                ProgressView("Loading history…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case .loaded(let entries):
                HistoryContentView(entries: entries, now: Date())
            case .failed(let message):
                HistoryMessageView(symbol: "clock.badge.exclamationmark", message: message, tint: Palette.peach) {
                    Task { await load() }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("History")
        .toolbar {
            ToolbarItem {
                Button {
                    Task { await load() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .help("Refresh")
            }
        }
        .task {
            await load()
        }
    }

    private func load() async {
        loadState = .loading

        do {
            loadState = .loaded(try await model.fetchHistory())
        } catch {
            loadState = .failed(ServiceClientError.message(for: error, subject: "history"))
        }
    }
}

struct HistoryContentView: View {
    let entries: [HistoryEntry]
    let now: Date

    var body: some View {
        let days = HistoryGrouping.days(for: entries, now: now)

        if days.isEmpty {
            HistoryMessageView(symbol: "clock", message: "No finished PRs in the last 30 days", tint: Palette.stone, retry: nil)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: MenuStyle.cardSpacing) {
                    ForEach(days) { day in
                        MenuSectionHeader(title: day.title, count: day.entries.count)

                        ForEach(day.entries) { entry in
                            HistoryRowView(entry: entry)
                        }
                    }
                }
                .padding(16)
            }
        }
    }
}

struct HistoryMessageView: View {
    let symbol: String
    let message: String
    let tint: PastelColor
    let retry: (() -> Void)?

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(tint.ink)
                .accessibilityHidden(true)

            Text(message)
                .font(MenuStyle.bodyFont)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            if let retry {
                Button(action: retry) {
                    Label("Try Again", systemImage: "arrow.clockwise")
                }
                .buttonStyle(PillButtonStyle())
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
