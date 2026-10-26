// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ProxyReviewBot",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ProxyReviewBot",
            dependencies: ["ProxyReviewBotCore"]
        ),
        .target(name: "ProxyReviewBotCore"),
        .testTarget(
            name: "ProxyReviewBotCoreTests",
            dependencies: ["ProxyReviewBotCore"]
        ),
    ]
)
