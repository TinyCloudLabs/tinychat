import Capacitor
import Foundation
import ReplicaStore

/// TC-2862: the bridge to the device's local TinyCloud copy (`ReplicaStoreCore`). The web app's facade is
/// frontend/src/lib/replication/nativeReplicaStore.ts; it stays unused behind `VITE_EXO_NATIVE_REPLICA` until the SDK
/// can consume it, except the sign-out wipe, which always runs.
public final class ReplicaStorePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ReplicaStorePlugin"
    public let jsName = "TinyCloudReplicaStore"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getMany", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "write", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "estimate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "wipeAll", returnType: CAPPluginReturnPromise),
    ]

    /// SQLite and the Keychain block: keep them off the bridge's thread, one call at a time.
    private let queue = DispatchQueue(label: "xyz.tinycloud.replica-store", qos: .userInitiated)
    private lazy var core: ReplicaStoreCore? = {
        guard let directory = try? ReplicaStoreCore.defaultDirectory() else { return nil }
        return ReplicaStoreCore(directory: directory, secrets: KeychainSecretStore(), freeBytes: {
            let values = try? directory.deletingLastPathComponent()
                .resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
            return values?.volumeAvailableCapacityForImportantUsage
        })
    }()

    @objc func open(_ call: CAPPluginCall) {
        run(call) { core in
            let account = try Self.string(call, "account")
            var maxBytes: Int64?
            if let raw = call.getDouble("maxBytes") {
                guard let exact = Int64(exactly: raw.rounded(.down)) else { throw Self.invalid("maxBytes is out of range") }
                maxBytes = exact
            }
            let opened = try core.open(account: account, maxBytes: maxBytes)
            return ["schemaVersion": opened.schemaVersion, "created": opened.created]
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        run(call) { core in
            core.close()
            return [:]
        }
    }

    @objc func get(_ call: CAPPluginCall) {
        run(call) { core in
            let value = try core.get(store: Self.string(call, "store"), key: Self.string(call, "key"))
            return ["value": value ?? NSNull()]
        }
    }

    @objc func getMany(_ call: CAPPluginCall) {
        run(call) { core in
            guard let keys = call.getArray("keys") as? [String] else { throw Self.invalid("keys must be strings") }
            let values = try core.getMany(store: Self.string(call, "store"), keys: keys)
            return ["values": values.map { $0 ?? NSNull() as Any }]
        }
    }

    @objc func list(_ call: CAPPluginCall) {
        run(call) { core in
            let entries = try core.list(store: Self.string(call, "store"), prefix: call.getString("prefix"),
                                        limit: call.getInt("limit"))
            return ["entries": entries.map { ["key": $0.key, "value": $0.value] }]
        }
    }

    @objc func write(_ call: CAPPluginCall) {
        run(call) { core in
            guard let raw = call.getArray("ops") as? [[String: Any]] else { throw Self.invalid("ops must be objects") }
            try core.write(raw.map(Self.op))
            return [:]
        }
    }

    @objc func estimate(_ call: CAPPluginCall) {
        run(call) { core in
            let estimate = try core.estimate()
            return ["usedBytes": estimate.usedBytes, "freeBytes": estimate.freeBytes.map { $0 as Any } ?? NSNull()]
        }
    }

    @objc func wipe(_ call: CAPPluginCall) {
        run(call) { core in
            try core.wipe(account: Self.string(call, "account"))
            return [:]
        }
    }

    @objc func wipeAll(_ call: CAPPluginCall) {
        run(call) { core in
            try core.wipeAll()
            return [:]
        }
    }

    private func run(_ call: CAPPluginCall, _ body: @escaping (ReplicaStoreCore) throws -> [String: Any]) {
        queue.async { [weak self] in
            guard let core = self?.core else {
                call.reject("the replica directory is unavailable", "IO")
                return
            }
            do {
                call.resolve(try body(core))
            } catch let error as ReplicaStoreError {
                call.reject(error.message, error.code)
            } catch {
                call.reject(error.localizedDescription, "IO")
            }
        }
    }

    static func op(_ raw: [String: Any]) throws -> ReplicaOp {
        guard let store = raw["store"] as? String else { throw invalid("op.store is required") }
        switch raw["op"] as? String {
        case "put":
            guard let key = raw["key"] as? String, let value = raw["value"] as? String else {
                throw invalid("put needs key and value strings")
            }
            return .put(store: store, key: key, value: value)
        case "delete":
            guard let key = raw["key"] as? String else { throw invalid("delete needs a key") }
            return .delete(store: store, key: key)
        case "clear":
            return .clear(store: store)
        default:
            throw invalid("unknown op")
        }
    }

    private static func string(_ call: CAPPluginCall, _ name: String) throws -> String {
        guard let value = call.getString(name) else { throw invalid("\(name) is required") }
        return value
    }

    private static func invalid(_ message: String) -> ReplicaStoreError { ReplicaStoreError("INVALID_ARGUMENT", message) }
}
