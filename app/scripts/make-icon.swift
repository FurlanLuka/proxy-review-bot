import AppKit
import CoreGraphics

// Draws the Proxy Review Bot app icon (pull-request branches), full bleed, at every iconset size.
// Usage: swift app/scripts/make-icon.swift <output.iconset> [preview-dir]

let iconsetSizes: [(points: Int, scale: Int)] = [
    (16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2),
]

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
let glyphShadeHex: UInt32 = 0x3A28B8
// The glyph grows to fill the canvas now that the artwork has no margin of its own.
let glyphScale: CGFloat = 1.12

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(
        srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: alpha
    )
}

// Full bleed: macOS 26 applies its own rounded mask and frames icons that aren't edge to edge.
func drawBackground(in context: CGContext, unit: CGFloat) {
    let canvas = CGRect(x: 0, y: 0, width: 1024 * unit, height: 1024 * unit)

    let background = CGGradient(
        colorsSpace: colorSpace,
        colors: [color(0x7C4DFF), color(0x4F3BD6), color(0x2A1F8F)] as CFArray,
        locations: [0, 0.55, 1]
    )!
    context.drawLinearGradient(
        background,
        start: CGPoint(x: canvas.minX, y: canvas.maxY),
        end: CGPoint(x: canvas.maxX, y: canvas.minY),
        options: []
    )

    let glow = CGGradient(
        colorsSpace: colorSpace,
        colors: [color(0xFFFFFF, alpha: 0.22), color(0xFFFFFF, alpha: 0)] as CFArray,
        locations: [0, 1]
    )!
    context.drawRadialGradient(
        glow,
        startCenter: CGPoint(x: canvas.midX, y: canvas.maxY),
        startRadius: 0,
        endCenter: CGPoint(x: canvas.midX, y: canvas.maxY),
        endRadius: canvas.width * 0.75,
        options: []
    )
}

func withGlyphShadow(_ context: CGContext, unit: CGFloat, isSmall: Bool, draw: () -> Void) {
    context.saveGState()
    context.setShadow(
        offset: CGSize(width: 0, height: -8 * unit),
        blur: 24 * unit,
        color: color(0x120A3A, alpha: isSmall ? 0 : 0.35)
    )
    context.beginTransparencyLayer(auxiliaryInfo: nil)
    draw()
    context.endTransparencyLayer()
    context.restoreGState()
}

func strokeLine(_ context: CGContext, path: CGPath, width: CGFloat, hex: UInt32) {
    context.addPath(path)
    context.setStrokeColor(color(hex))
    context.setLineWidth(width)
    context.setLineCap(.round)
    context.setLineJoin(.round)
    context.strokePath()
}

func circleRect(center: CGPoint, radius: CGFloat) -> CGRect {
    CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
}

func sparklePath(center: CGPoint, radius: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let waist = radius * 0.28

    path.move(to: CGPoint(x: center.x, y: center.y + radius))
    path.addQuadCurve(to: CGPoint(x: center.x + radius, y: center.y), control: CGPoint(x: center.x + waist, y: center.y + waist))
    path.addQuadCurve(to: CGPoint(x: center.x, y: center.y - radius), control: CGPoint(x: center.x + waist, y: center.y - waist))
    path.addQuadCurve(to: CGPoint(x: center.x - radius, y: center.y), control: CGPoint(x: center.x - waist, y: center.y - waist))
    path.addQuadCurve(to: CGPoint(x: center.x, y: center.y + radius), control: CGPoint(x: center.x - waist, y: center.y + waist))
    path.closeSubpath()

    return path
}

func drawPullRequest(in context: CGContext, unit: CGFloat, isSmall: Bool) {
    let lineWidth = (isSmall ? 92 : 58) * unit
    let nodeRadius = (isSmall ? 92 : 72) * unit
    let left = (isSmall ? 350 : 370) * unit
    let right = (isSmall ? 674 : 654) * unit
    let top = (isSmall ? 710 : 700) * unit
    let bottom = (isSmall ? 314 : 324) * unit
    let nodeCenters = [CGPoint(x: left, y: top), CGPoint(x: left, y: bottom), CGPoint(x: right, y: bottom)]

    withGlyphShadow(context, unit: unit, isSmall: isSmall) {
        let stem = CGMutablePath()
        stem.move(to: CGPoint(x: left, y: bottom))
        stem.addLine(to: CGPoint(x: left, y: top))
        strokeLine(context, path: stem, width: lineWidth, hex: 0xFFFFFF)

        let merge = CGMutablePath()
        merge.move(to: CGPoint(x: right, y: bottom))
        merge.addLine(to: CGPoint(x: right, y: bottom + 60 * unit))
        merge.addCurve(
            to: CGPoint(x: left, y: top - 110 * unit),
            control1: CGPoint(x: right, y: top - 170 * unit),
            control2: CGPoint(x: left, y: top - 330 * unit)
        )
        strokeLine(context, path: merge, width: lineWidth, hex: 0xFFFFFF)

        for center in nodeCenters {
            context.setFillColor(color(0xFFFFFF))
            context.fillEllipse(in: circleRect(center: center, radius: nodeRadius))
        }
    }

    guard !isSmall else {
        return
    }

    let holeRadius = nodeRadius * 0.45

    for center in nodeCenters {
        context.setFillColor(color(glyphShadeHex))
        context.fillEllipse(in: circleRect(center: center, radius: holeRadius))
    }

    context.addPath(sparklePath(center: CGPoint(x: 726 * unit, y: 752 * unit), radius: 62 * unit))
    context.setFillColor(color(0xFFFFFF, alpha: 0.95))
    context.fillPath()
    context.addPath(sparklePath(center: CGPoint(x: 806 * unit, y: 650 * unit), radius: 30 * unit))
    context.setFillColor(color(0xFFFFFF, alpha: 0.75))
    context.fillPath()
}

func drawIcon(in context: CGContext, size: CGFloat) {
    let unit = size / 1024

    drawBackground(in: context, unit: unit)
    context.saveGState()
    context.translateBy(x: size / 2, y: size / 2)
    context.scaleBy(x: glyphScale, y: glyphScale)
    context.translateBy(x: -size / 2, y: -size / 2)
    drawPullRequest(in: context, unit: unit, isSmall: size < 64)
    context.restoreGState()
}

func makeBitmap(width: Int, height: Int) -> (NSBitmapImageRep, NSGraphicsContext) {
    let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: width,
        pixelsHigh: height,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    )!

    return (bitmap, NSGraphicsContext(bitmapImageRep: bitmap)!)
}

func png(_ bitmap: NSBitmapImageRep, _ graphics: NSGraphicsContext) -> Data {
    graphics.flushGraphics()

    return bitmap.representation(using: .png, properties: [:])!
}

func renderPNG(pixels: Int) -> Data {
    let (bitmap, graphics) = makeBitmap(width: pixels, height: pixels)
    drawIcon(in: graphics.cgContext, size: CGFloat(pixels))

    return png(bitmap, graphics)
}

func renderStrip(sizes: [Int]) -> Data {
    let gap = 24
    let width = sizes.reduce(gap) { $0 + $1 + gap }
    let rowHeight = sizes.max()! + gap * 2
    let (bitmap, graphics) = makeBitmap(width: width, height: rowHeight * 2)
    let context = graphics.cgContext

    for (row, background) in [color(0xF2F2F5), color(0x1E1E22)].enumerated() {
        context.setFillColor(background)
        context.fill(CGRect(x: 0, y: row * rowHeight, width: width, height: rowHeight))

        var x = gap

        for pixels in sizes {
            context.saveGState()
            context.translateBy(x: CGFloat(x), y: CGFloat(row * rowHeight + (rowHeight - pixels) / 2))
            drawIcon(in: context, size: CGFloat(pixels))
            context.restoreGState()
            x += pixels + gap
        }
    }

    return png(bitmap, graphics)
}

let arguments = CommandLine.arguments

guard arguments.count >= 2 else {
    FileHandle.standardError.write("usage: make-icon.swift <output.iconset> [preview-dir]\n".data(using: .utf8)!)
    exit(1)
}

let iconsetURL = URL(fileURLWithPath: arguments[1])
try FileManager.default.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

for entry in iconsetSizes {
    let suffix = entry.scale == 1 ? "" : "@2x"
    let name = "icon_\(entry.points)x\(entry.points)\(suffix).png"
    try renderPNG(pixels: entry.points * entry.scale).write(to: iconsetURL.appendingPathComponent(name))
}

if arguments.count >= 3 {
    let previewURL = URL(fileURLWithPath: arguments[2])
    try FileManager.default.createDirectory(at: previewURL, withIntermediateDirectories: true)
    try renderStrip(sizes: [256, 128, 64, 32, 16]).write(to: previewURL.appendingPathComponent("strip.png"))
    try renderPNG(pixels: 1024).write(to: previewURL.appendingPathComponent("icon-1024.png"))
}
