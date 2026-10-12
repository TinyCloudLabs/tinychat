// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ExoStt",
    platforms: [.iOS("26.0"), .macOS(.v14)],
    products: [
        .library(name: "ExoStt", targets: ["ExoStt"])
    ],
    dependencies: [
        .package(path: "../ExoCapture")
    ],
    targets: [
        .target(name: "ExoStt", dependencies: [
            .product(name: "ExoCapture", package: "ExoCapture", condition: .when(platforms: [.iOS]))
        ]),
        .testTarget(name: "ExoSttTests", dependencies: ["ExoStt"])
    ]
)
