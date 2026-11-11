// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "pdf2markit",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .library(name: "PDFMarkdown", targets: ["PDFMarkdown"]),
        .executable(name: "pdf2markit", targets: ["pdf2markit"]),
    ],
    targets: [
        .target(name: "PDFMarkdown"),
        .executableTarget(
            name: "pdf2markit",
            dependencies: ["PDFMarkdown"]),
        .testTarget(
            name: "PDFMarkdownTests",
            dependencies: ["PDFMarkdown"]),
    ]
)
