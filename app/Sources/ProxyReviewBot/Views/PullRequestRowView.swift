import ProxyReviewBotCore
import SwiftUI

struct PullRequestRowView: View {
    @ObservedObject var model: BotModel
    let pullRequest: PullRequest
    @State private var isProgressExpanded: Bool
    @State private var isConfirmingStop = false

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

            if isConfirmingStop {
                stopConfirmation
            } else {
                ViewThatFits(in: .horizontal) {
                    actionsRow(isStopLabeled: true, isCompact: false)
                    actionsRow(isStopLabeled: false, isCompact: false)
                    actionsRow(isStopLabeled: false, isCompact: true)
                }
            }
        }
        .padding(12)
        .card()
        .accessibilityElement(children: .contain)
        .stopActions(isAvailable: pullRequest.status.isStoppable, wording: stopWording) {
            isConfirmingStop = true
        }
        .disabled(isBusy)
    }

    private var stopConfirmation: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(stopWording.question)
                .font(MenuStyle.metaFont)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 6) {
                Spacer(minLength: 0)

                Button("Cancel") {
                    isConfirmingStop = false
                }
                .buttonStyle(PillButtonStyle())
                .keyboardShortcut(.cancelAction)

                Button(role: .destructive) {
                    isConfirmingStop = false
                    model.stop(pullRequest)
                } label: {
                    Label(stopWording.confirmTitle, systemImage: stopWording.symbolName)
                }
                .buttonStyle(PillButtonStyle(isProminent: true, tint: Palette.rose))
            }
        }
    }

    private func actionsRow(isStopLabeled: Bool, isCompact: Bool) -> some View {
        HStack(spacing: 6) {
            PullRequestActionsView(model: model, pullRequest: pullRequest, isCompact: isCompact)

            Spacer(minLength: 0)

            if pullRequest.status.isStoppable {
                stopButton(isLabeled: isStopLabeled)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusGlyph(glyph: pullRequest.glyph)

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

                if pullRequest.showsRoundCount {
                    Text(PullRequestDetail.roundText(for: pullRequest))
                        .font(MenuStyle.metaFont.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var isBusy: Bool {
        model.busyPullRequestIDs.contains(pullRequest.id)
    }

    private func stopButton(isLabeled: Bool) -> some View {
        Button(role: .destructive) {
            isConfirmingStop = true
        } label: {
            Label(stopWording.buttonTitle, systemImage: stopWording.symbolName)
                .labelStyle(isLabeled ? AnyLabelStyle(.titleAndIcon) : AnyLabelStyle(.iconOnly))
        }
        .buttonStyle(PillButtonStyle())
        .help(stopWording.actionLabel)
        .accessibilityLabel(stopWording.actionLabel)
    }

    private var stopWording: StopWording {
        StopWording(isReviewStarted: pullRequest.isReviewStarted)
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
    func stopActions(isAvailable: Bool, wording: StopWording, stop: @escaping () -> Void) -> some View {
        if isAvailable {
            contextMenu {
                Button("\(wording.confirmTitle)…", role: .destructive, action: stop)
            }
            .accessibilityAction(named: wording.confirmTitle, stop)
        } else {
            self
        }
    }
}
