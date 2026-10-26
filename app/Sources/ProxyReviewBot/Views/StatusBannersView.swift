import SwiftUI

struct StatusBannersView: View {
    @ObservedObject var model: BotModel

    var body: some View {
        if !banners.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(banners, id: \.text) { banner in
                    bannerRow(banner)
                }
            }
        }
    }

    private enum Accessory {
        case none
        case resume
        case dismiss
    }

    private struct Banner {
        let text: String
        let symbol: String
        let color: PastelColor
        var accessory = Accessory.none
    }

    private func bannerRow(_ banner: Banner) -> some View {
        HStack(spacing: 8) {
            Image(systemName: banner.symbol)
                .foregroundStyle(banner.color.ink)
                .accessibilityHidden(true)

            Text(banner.text)
                .font(MenuStyle.bodyFont)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 4)

            accessory(banner.accessory)
        }
        .padding(.leading, 12)
        .padding(.trailing, banner.accessory == .none ? 12 : 6)
        .padding(.vertical, banner.accessory == .none ? 8 : 4)
        .frame(minHeight: 34)
        .background(
            RoundedRectangle(cornerRadius: MenuStyle.bannerCornerRadius, style: .continuous)
                .fill(banner.color.tint.opacity(MenuStyle.bannerFillOpacity))
        )
    }

    @ViewBuilder
    private func accessory(_ accessory: Accessory) -> some View {
        switch accessory {
        case .none:
            EmptyView()
        case .resume:
            Button {
                model.togglePause()
            } label: {
                Label("Resume", systemImage: "play.fill")
            }
            .buttonStyle(PillButtonStyle(isProminent: true, tint: Palette.butter))
        case .dismiss:
            IconButton(systemName: "xmark", label: "Dismiss", help: "Dismiss") {
                model.actionMessage = nil
            }
        }
    }

    private var banners: [Banner] {
        var banners: [Banner] = []

        if let state = model.state {
            if state.isPaused {
                banners.append(Banner(
                    text: "Paused · nothing runs until you resume",
                    symbol: "pause.circle.fill",
                    color: Palette.butter,
                    accessory: .resume
                ))
            }

            if let usageLimitedUntil = state.usageLimitedUntilDate {
                banners.append(Banner(
                    text: "Usage limit · resumes at \(usageLimitedUntil.formatted(date: .omitted, time: .shortened))",
                    symbol: "gauge.with.dots.needle.100percent",
                    color: Palette.peach
                ))
            }
        }

        if let actionMessage = model.actionMessage {
            banners.append(Banner(
                text: actionMessage,
                symbol: "exclamationmark.triangle.fill",
                color: Palette.rose,
                accessory: .dismiss
            ))
        }

        return banners
    }
}
