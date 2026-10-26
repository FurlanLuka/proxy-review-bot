import ProxyReviewBotCore
import SwiftUI

struct PullRequestRowView: View {
    @ObservedObject var model: BotModel
    let pullRequest: PullRequest
    @State private var isProgressExpanded: Bool
    @State private var isHovered = false
    @State private var isConfirmingStop = false
    @FocusState private var isStopFocused: Bool

    @Environment(\.accessibilityReduceMotion) private var isReducingMotion

    init(model: BotModel, pullRequest: PullRequest, isProgressExpanded: Bool = false) {
        self.model = model
        self.pullRequest = pullRequest
        _isProgressExpanded = State(initialValue: isProgressExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header

            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(PullRequestDetail.text(for: pullRequest, now: context.date))
                    .font(MenuStyle.bodyFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let progress = pullRequest.progress {
                progressSection(progress)
            }

            if hasActions {
                HStack(spacing: 6) {
                    PullRequestActionsView(model: model, pullRequest: pullRequest)

                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .card(isHighlighted: isHovered && pullRequest.status.isStoppable)
        .onHover { isHovered = $0 }
        .accessibilityElement(children: .contain)
        .stopActions(isAvailable: pullRequest.status.isStoppable) {
            isConfirmingStop = true
        }
        .confirmationDialog("Stop reviewing \(pullRequest.shortName)?", isPresented: $isConfirmingStop, titleVisibility: .visible) {
            Button("Stop Reviewing", role: .destructive) {
                model.stop(pullRequest)
            }

            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The bot stops working on this PR. It picks it up again when someone re-requests your review.")
        }
        .disabled(isBusy)
        .animation(isReducingMotion ? nil : .easeOut(duration: 0.15), value: isHovered)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 0) {
            headerSummary

            stopButton
        }
    }

    private var headerSummary: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusGlyph(status: pullRequest.status)

            VStack(alignment: .leading, spacing: 2) {
                Text(pullRequest.title)
                    .font(MenuStyle.titleFont)
                    .lineLimit(1)
                    .truncationMode(.tail)

                HStack(spacing: 4) {
                    Text(pullRequest.shortName)

                    if let author = pullRequest.author {
                        Text("·")
                        Text("@\(author)")
                    }
                }
                .font(MenuStyle.metaFont)
                .foregroundStyle(.secondary)
            }

            Spacer(minLength: 6)

            VStack(alignment: .trailing, spacing: 2) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    diffStat
                }

                if pullRequest.status.isInReview {
                    Text(PullRequestDetail.roundText(for: pullRequest))
                        .font(MenuStyle.metaFont.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var isStopVisible: Bool {
        isHovered || isStopFocused
    }

    private var isBusy: Bool {
        model.busyPullRequestIDs.contains(pullRequest.id)
    }

    private var hasActions: Bool {
        [.needsReview, .awaitingApproval, .draftReady, .needsYou].contains(pullRequest.status)
    }

    @ViewBuilder
    private var stopButton: some View {
        if pullRequest.status.isStoppable {
            IconButton(systemName: "xmark", label: "Stop Reviewing This PR", help: "Stop Reviewing This PR", role: .destructive, size: 20) {
                isConfirmingStop = true
            }
            .focused($isStopFocused)
            .padding(.trailing, -8)
            .opacity(isStopVisible ? 1 : 0)
            .allowsHitTesting(isStopVisible)
            .accessibilityHidden(!isStopVisible)
        }
    }

    private var diffStat: some View {
        HStack(spacing: 3) {
            Text("+\(pullRequest.additions)")
                .foregroundStyle(Palette.sage.ink)

            Text("−\(pullRequest.deletions)")
                .foregroundStyle(Palette.rose.ink)
        }
        .font(MenuStyle.metaFont.monospacedDigit().weight(.medium))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(pullRequest.additions) additions, \(pullRequest.deletions) deletions")
    }

    @ViewBuilder
    private func progressSection(_ progress: ReviewProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !progress.subagents.isEmpty {
                ProgressView(value: Double(progress.finishedSubagentCount), total: Double(progress.subagents.count))
                    .progressViewStyle(.linear)
                    .tint(Palette.lavender.tint)
            }

            DisclosureToggle(
                title: progress.message ?? "Working…",
                hint: "Shows each advisor's progress",
                isExpanded: $isProgressExpanded
            )

            if isProgressExpanded {
                ReviewProgressView(progress: progress)
                    .padding(10)
                    .background(
                        RoundedRectangle(cornerRadius: MenuStyle.innerCornerRadius, style: .continuous)
                            .fill(Color.primary.opacity(0.04))
                    )
            }
        }
    }
}

private extension View {
    @ViewBuilder
    func stopActions(isAvailable: Bool, stop: @escaping () -> Void) -> some View {
        if isAvailable {
            contextMenu {
                Button("Stop Reviewing…", role: .destructive, action: stop)
            }
            .accessibilityAction(named: "Stop Reviewing", stop)
        } else {
            self
        }
    }
}
