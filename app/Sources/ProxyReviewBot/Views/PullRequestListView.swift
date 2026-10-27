import ProxyReviewBotCore
import SwiftUI

struct PullRequestListView: View {
    @ObservedObject var model: BotModel
    let sections: PullRequestSections
    @AppStorage("collapsedMenuSections") private var collapsedSectionsValue = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if sections.isEmpty {
                emptyState
            }

            if !sections.inReview.isEmpty {
                section(title: "In review", pullRequests: sections.inReview)
            }

            if !sections.readyToReview.isEmpty {
                section(title: "Ready to review", pullRequests: sections.readyToReview)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(Palette.sage.ink)
                .accessibilityHidden(true)

            Text("All caught up")
                .font(MenuStyle.titleFont)

            Text("No PRs are waiting on your review.")
                .font(MenuStyle.metaFont)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 22)
        .card()
    }

    private func section(title: String, pullRequests: [PullRequest]) -> some View {
        let isExpanded = isExpandedBinding(for: title)

        return VStack(alignment: .leading, spacing: MenuStyle.cardSpacing) {
            MenuSectionHeader(title: title, count: pullRequests.count, isExpanded: isExpanded)

            if isExpanded.wrappedValue {
                ForEach(pullRequests) { pullRequest in
                    PullRequestRowView(model: model, pullRequest: pullRequest)
                        .id(pullRequest.id)
                }
            }
        }
    }

    private func isExpandedBinding(for title: String) -> Binding<Bool> {
        Binding {
            !CollapsedSections(storedValue: collapsedSectionsValue).isCollapsed(title)
        } set: { isExpanded in
            var collapsedSections = CollapsedSections(storedValue: collapsedSectionsValue)
            collapsedSections.setCollapsed(!isExpanded, title: title)
            collapsedSectionsValue = collapsedSections.storedValue
        }
    }
}
