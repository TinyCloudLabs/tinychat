// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ReplicaStore",
    platforms: [.iOS("26.0"), .macOS(.v14)],
    products: [.library(name: "ReplicaStore", targets: ["ReplicaStore"])],
    targets: [
        .target(name: "ReplicaStore", linkerSettings: [.linkedLibrary("sqlite3")]),
        .testTarget(name: "ReplicaStoreTests", dependencies: ["ReplicaStore"]),
    ]
)
