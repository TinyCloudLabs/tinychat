// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "SttCore",
    platforms: [.iOS("18.0"), .macOS(.v14)],
    products: [.library(name: "SttCore", targets: ["SttCore"])],
    targets: [
        .target(name: "SttCore"),
        .testTarget(name: "SttCoreTests", dependencies: ["SttCore"])
    ]
)
