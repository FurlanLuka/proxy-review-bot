import SwiftUI

struct SettingsErrorText: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(MenuStyle.bodyFont)
            .foregroundStyle(Palette.rose.ink)
    }
}
