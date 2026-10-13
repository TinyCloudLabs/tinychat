// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ExoCapture",
    platforms: [.iOS("26.0")],
    products: [.library(name: "ExoCapture", targets: ["ExoCapture"])],
    dependencies: [.package(path: "../CaptureCore")],
    targets: [
        .target(name: "ExoCapture", dependencies: ["CaptureCore"]),
        .testTarget(name: "ExoCaptureTests", dependencies: ["ExoCapture", "CaptureCore"]),
    ],
    swiftLanguageModes: [.v5]
)
