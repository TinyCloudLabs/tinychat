// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ExoStt",
    platforms: [.iOS("18.0"), .macOS(.v14)],
    products: [.library(name: "ExoStt", targets: ["ExoStt"])],
    dependencies: [
        .package(path: "../SttCore"),
        .package(url: "https://github.com/k2-fsa/sherpa-onnx", exact: "1.13.8")
    ],
    targets: [
        .target(name: "ExoStt", dependencies: [
            .product(name: "SttCore", package: "SttCore"),
            .product(name: "sherpa-onnx", package: "sherpa-onnx")
        ])
    ]
)
