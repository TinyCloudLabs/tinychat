// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CaptureCore",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "CaptureCore", targets: ["CaptureCore"])],
    targets: [
        .target(name: "CaptureCore"),
        .testTarget(name: "CaptureCoreTests", dependencies: ["CaptureCore"]),
    ]
)
