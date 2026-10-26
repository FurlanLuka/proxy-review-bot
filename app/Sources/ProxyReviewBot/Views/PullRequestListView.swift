import ProxyReviewBotCore
import SwiftUI

struct PullRequestListView: View {
    @ObservedObject var model: BotModel
    let sections: PullRequestSections
    @AppStorage("collapsedMenuSections") private var collapsedSectionsValue = ""
    @State private var sectionsShowingAll: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if sections.needsReview.isEmpty && sections.needsYou.isEmpty && sections.inReview.isEmpty {
                emptyState
            }

            if !sections.needsYou.isEmpty {
                section(title: "Needs you", pullRequests: sections.needsYou)
            }

            if !sections.inReview.isEmpty {
                section(title: "In review", pullRequests: sections.inReview)
            }

            if !sections.needsReview.isEmpty {
                section(title: "Ready to review", pullRequests: sections.needsReview)
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
                let isShowingAll = sectionsShowingAll.contains(title)
                let preview = SectionPreview(items: pullRequests, isShowingAll: isShowingAll)

                ForEach(preview.visibleItems) { pullRequest in
                    PullRequestRowView(model: model, pullRequest: pullRequest)
                }

                if preview.hiddenCount > 0 {
                    showMoreButton(title: "Show \(preview.hiddenCount) more", sectionTitle: title)
                } else if preview.canShowLess {
                    showMoreButton(title: "Show less", sectionTitle: title)
                }
            }
        }
    }

    private func showMoreButton(title: String, sectionTitle: String) -> some View {
        Button {
            if sectionsShowingAll.contains(sectionTitle) {
                sectionsShowingAll.remove(sectionTitle)
            } else {
                sectionsShowingAll.insert(sectionTitle)
            }
        } label: {
            Text(title)
                .font(MenuStyle.metaFont)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, minHeight: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("\(sectionTitle) section")
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
