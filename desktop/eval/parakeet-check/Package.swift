// swift-tools-version:5.10
// A check outside the app: Parakeet TDT v3 through speech-swift, as TinyCloud One's Soniqo path runs it.
// Depends only on ParakeetASR and AudioCommon (Core ML; no MLX, so no Metal compiler and no full Xcode).

import PackageDescription

let package = Package(
  name: "parakeet-check",
  // speech-swift declares macOS 15. The app's build patches that to 14.2; this check does not.
  platforms: [.macOS("15.0")],
  dependencies: [
    // The commit the app's pinned Soniqo bridge resolves (speech-swift 0.0.22).
    .package(
      url: "https://github.com/soniqo/speech-swift",
      revision: "335a68c0db92564527881962ff11eb686863d2b8")
  ],
  targets: [
    .executableTarget(
      name: "parakeet-check",
      dependencies: [
        .product(name: "AudioCommon", package: "speech-swift"),
        .product(name: "ParakeetASR", package: "speech-swift"),
      ],
      path: "Sources/ParakeetCheck"
    )
  ]
)
