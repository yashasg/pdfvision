// swift-tools-version: 5.8
import PackageDescription

let package = Package(
    name: "PDFVisionDanger",
    products: [
        .library(name: "DangerDeps", type: .dynamic, targets: ["DangerDependencies"]),
    ],
    dependencies: [
        .package(url: "https://github.com/danger/swift.git", exact: "3.23.1"),
    ],
    targets: [
        .target(
            name: "DangerDependencies",
            dependencies: [.product(name: "Danger", package: "swift")]
        ),
    ]
)
