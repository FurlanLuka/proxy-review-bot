import AppKit
import SwiftUI

typealias RGB = (red: Double, green: Double, blue: Double)

extension Color {
    static func pastel(light: RGB, dark: RGB, highContrastLight: RGB, highContrastDark: RGB) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let appearanceName = appearance.bestMatch(from: [
                .darkAqua,
                .aqua,
                .accessibilityHighContrastDarkAqua,
                .accessibilityHighContrastAqua,
            ])
            let rgb = switch appearanceName {
            case .accessibilityHighContrastDarkAqua:
                highContrastDark
            case .accessibilityHighContrastAqua:
                highContrastLight
            case .darkAqua:
                dark
            default:
                light
            }

            return NSColor(srgbRed: rgb.red / 255, green: rgb.green / 255, blue: rgb.blue / 255, alpha: 1)
        })
    }
}

struct PastelColor {
    let tint: Color
    let ink: Color

    init(tintLight: RGB, tintDark: RGB, inkLight: RGB, inkDark: RGB, inkHighContrastLight: RGB, inkHighContrastDark: RGB) {
        tint = Color.pastel(light: tintLight, dark: tintDark, highContrastLight: tintLight, highContrastDark: tintDark)
        ink = Color.pastel(light: inkLight, dark: inkDark, highContrastLight: inkHighContrastLight, highContrastDark: inkHighContrastDark)
    }
}

enum Palette {
    static let sage = PastelColor(
        tintLight: (74, 140, 98), tintDark: (163, 212, 178),
        inkLight: (48, 90, 63), inkDark: (184, 222, 195),
        inkHighContrastLight: (37, 70, 49), inkHighContrastDark: (229, 243, 233)
    )
    static let sky = PastelColor(
        tintLight: (70, 118, 184), tintDark: (167, 199, 242),
        inkLight: (48, 81, 127), inkDark: (191, 215, 246),
        inkHighContrastLight: (37, 62, 97), inkHighContrastDark: (229, 239, 251)
    )
    static let peach = PastelColor(
        tintLight: (186, 116, 62), tintDark: (245, 196, 155),
        inkLight: (115, 72, 38), inkDark: (246, 204, 169),
        inkHighContrastLight: (90, 56, 30), inkHighContrastDark: (252, 238, 227)
    )
    static let lavender = PastelColor(
        tintLight: (120, 98, 186), tintDark: (199, 184, 245),
        inkLight: (86, 65, 147), inkDark: (218, 209, 248),
        inkHighContrastLight: (66, 50, 113), inkHighContrastDark: (239, 236, 252)
    )
    static let mint = PastelColor(
        tintLight: (60, 140, 136), tintDark: (168, 220, 217),
        inkLight: (39, 90, 87), inkDark: (176, 223, 221),
        inkHighContrastLight: (30, 69, 66), inkHighContrastDark: (230, 245, 244)
    )
    static let rose = PastelColor(
        tintLight: (178, 86, 96), tintDark: (242, 175, 180),
        inkLight: (127, 58, 65), inkDark: (246, 201, 205),
        inkHighContrastLight: (97, 44, 50), inkHighContrastDark: (251, 232, 233)
    )
    static let butter = PastelColor(
        tintLight: (160, 128, 40), tintDark: (242, 221, 160),
        inkLight: (99, 79, 25), inkDark: (242, 221, 160),
        inkHighContrastLight: (77, 61, 19), inkHighContrastDark: (252, 247, 232)
    )
    static let periwinkle = PastelColor(
        tintLight: (92, 100, 184), tintDark: (180, 185, 242),
        inkLight: (64, 72, 148), inkDark: (208, 211, 247),
        inkHighContrastLight: (49, 56, 114), inkHighContrastDark: (234, 235, 251)
    )
    static let stone = PastelColor(
        tintLight: (120, 120, 128), tintDark: (176, 176, 184),
        inkLight: (81, 81, 86), inkDark: (212, 212, 217),
        inkHighContrastLight: (62, 62, 66), inkHighContrastDark: (231, 231, 234)
    )
    static let orchid = PastelColor(
        tintLight: (158, 88, 158), tintDark: (234, 184, 234),
        inkLight: (111, 62, 111), inkDark: (239, 202, 239),
        inkHighContrastLight: (85, 47, 85), inkHighContrastDark: (249, 235, 249)
    )
}
