// swift-tools-version:5.10
// A check outside the app: speaker diarization of one recording channel with pyannote Community-1 on Core ML.
// Depends only on speech-swift's AudioCommon; the Community-1 sources are copied into Sources/Community1 so that
// the SpeechVAD product (which builds mlx-swift, and so needs the Metal compiler and full Xcode) is not used.

import PackageDescription

let package = Package(
  name: "diarize-check",
  // speech-swift declares macOS 15.
  platforms: [.macOS("15.0")],
  dependencies: [
    // The commit the app's pinned Soniqo bridge resolves (speech-swift 0.0.22).
    .package(
      url: "https://github.com/soniqo/speech-swift",
      revision: "335a68c0db92564527881962ff11eb686863d2b8")
  ],
  targets: [
    .target(
      name: "Community1",
      dependencies: [.product(name: "AudioCommon", package: "speech-swift")],
      path: "Sources/Community1"
    ),
    .executableTarget(
      name: "diarize-check",
      dependencies: ["Community1", .product(name: "AudioCommon", package: "speech-swift")],
      path: "Sources/DiarizeCheck"
    ),
  ]
)
