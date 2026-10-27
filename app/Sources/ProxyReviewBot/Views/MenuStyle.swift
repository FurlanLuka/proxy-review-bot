import SwiftUI

enum MenuStyle {
    static let cardSpacing: CGFloat = 6
    static let cardCornerRadius: CGFloat = 12
    static let bannerCornerRadius: CGFloat = 12
    static let innerCornerRadius: CGFloat = 8

    static let bannerFillOpacity = 0.14
    static let glyphFillOpacity = 0.16
    static let pillFillOpacity = 0.2

    static let titleFont = Font.system(size: 13, weight: .semibold)
    static let metaFont = Font.subheadline
    static let bodyFont = Font.callout
    static let labelFont = Font.system(size: 12, weight: .semibold)
    static let sectionFont = Font.system(size: 11, weight: .semibold)

    static func strokeOpacity(for contrast: ColorSchemeContrast) -> Double {
        contrast == .increased ? 0.3 : 0.06
    }

    static func prominentStrokeOpacity(for contrast: ColorSchemeContrast) -> Double {
        contrast == .increased ? 0.7 : 0.35
    }
}
