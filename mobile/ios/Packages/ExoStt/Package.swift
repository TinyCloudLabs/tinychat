// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ExoStt",
    platforms: [.iOS("18.0"), .macOS(.v14)],
    products: [
        .library(name: "ExoStt", targets: ["ExoStt"]),
        .executable(name: "SttBenchMac", targets: ["SttBenchMac"])
    ],
    dependencies: [
        .package(path: "../SttCore"),
        .package(path: "../ExoCapture"),
        .package(url: "https://github.com/k2-fsa/sherpa-onnx", exact: "1.13.8")
    ],
    targets: [
        .systemLibrary(name: "CBZip2"),
        .target(name: "ExoStt", dependencies: [
            .product(name: "SttCore", package: "SttCore"),
            .product(name: "ExoCapture", package: "ExoCapture", condition: .when(platforms: [.iOS])),
            .product(name: "sherpa-onnx", package: "sherpa-onnx"),
            "CBZip2"
        ]),
        .executableTarget(name: "SttBenchMac", dependencies: ["ExoStt"]),
        .testTarget(name: "ExoSttTests", dependencies: ["ExoStt"])
    ]
)
