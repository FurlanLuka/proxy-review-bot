import SwiftUI

struct DraftCommentCard: View {
    let location: String
    let link: URL?
    @Binding var isIncluded: Bool
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let link {
                    Link(destination: link) {
                        HStack(spacing: 4) {
                            Text(location)
                                .lineLimit(1)
                                .truncationMode(.middle)

                            Image(systemName: "arrow.up.right")
                                .font(.system(size: 9, weight: .bold))
                        }
                        .font(MenuStyle.metaFont.monospaced())
                        .foregroundStyle(Palette.sky.ink)
                    }
                    .help("Open this line in the PR on GitHub")
                } else {
                    Text(location)
                        .font(MenuStyle.metaFont.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }

                Spacer(minLength: 8)

                Toggle("Include", isOn: $isIncluded)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .font(MenuStyle.metaFont)
                    .accessibilityLabel("Include \(location)")
            }

            DraftTextEditor(text: $text, minHeight: 60, placeholder: "Write this comment…", accessibilityLabel: "Comment on \(location)")
                .disabled(!isIncluded)
        }
        .padding(12)
        .card()
        .opacity(isIncluded ? 1 : 0.55)
    }
}
