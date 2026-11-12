// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ReplicaStore",
    platforms: [.iOS("26.0"), .macOS(.v14)],
    products: [.library(name: "ReplicaStore", targets: ["ReplicaStore"])],
    dependencies: [
        // Whole-file encryption (D-S5). Never link the system libsqlite3 alongside it.
        .package(url: "https://github.com/sqlcipher/SQLCipher.swift", exact: "4.20.0"),
    ],
    targets: [
        .target(name: "ReplicaStore", dependencies: [.product(name: "SQLCipher", package: "SQLCipher.swift")],
                cSettings: [.define("SQLITE_HAS_CODEC")]),
        .testTarget(name: "ReplicaStoreTests", dependencies: ["ReplicaStore"]),
    ]
)
