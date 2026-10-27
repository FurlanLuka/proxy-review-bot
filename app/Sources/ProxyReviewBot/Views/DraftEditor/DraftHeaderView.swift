import ProxyReviewBotCore
import SwiftUI

struct DraftHeaderView: View {
    let pullRequest: PullRequest?
    let draft: ReviewDraft

    @State private var isCoverageExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                StatusGlyph(status: pullRequest?.status ?? .draftReady)

                VStack(alignment: .leading, spacing: 2) {
                    Text(pullRequest?.title ?? "Review Draft")
                        .font(.system(size: 16, weight: .semibold))

                    Text(subtitle)
                        .font(MenuStyle.metaFont)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)

            Text(draft.summary)
                .font(MenuStyle.bodyFont)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: MenuStyle.bannerCornerRadius, style: .continuous)
                        .fill(Palette.orchid.tint.opacity(MenuStyle.bannerFillOpacity))
                )

            if let coverage = draft.coverage, !coverage.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    DisclosureToggle(title: "Coverage", hint: "Shows what the review covered", isExpanded: $isCoverageExpanded)

                    if isCoverageExpanded {
                        Text(coverage)
                            .font(MenuStyle.bodyFont)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
    }

    private var subtitle: String {
        guard let pullRequest else {
            return "Will \(draft.filing == .approve ? "approve" : "comment")"
        }

        return [pullRequest.shortName, pullRequest.authorText]
            .compactMap { $0 }
            .joined(separator: " · ")
    }
}
