// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "pdfvision",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "PDFMarkdown", targets: ["PDFMarkdown"]),
        .executable(name: "pdfvision", targets: ["pdfvision"]),
    ],
    dependencies: [
        // Newer releases require Swift 6.2; keep Swift 6.0 compatibility.
        .package(url: "https://github.com/swiftlang/swift-markdown.git", exact: "0.7.1"),
    ],
    targets: [
        .target(
            name: "PDFMarkdown",
            dependencies: [.product(name: "Markdown", package: "swift-markdown")]
        ),
        .executableTarget(
            name: "pdfvision",
            dependencies: ["PDFMarkdown"]
        ),
        .testTarget(
            name: "PDFMarkdownTests",
            dependencies: ["PDFMarkdown"]
        ),
    ]
)
