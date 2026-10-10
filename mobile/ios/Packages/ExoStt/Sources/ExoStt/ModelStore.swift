import CryptoKit
import Foundation

public enum ModelState: String {
    case absent, queued, downloading, verifying, ready, failed
}

/// On-disk state for the downloadable models (plan §2.9), under `Application Support/models/`
/// (excluded from backup, like the voice-note library). One model = one subdirectory; a model is
/// `ready` only once every one of its files exists and matches its pinned sha256.
public final class ModelStore {
    public let root: URL
    private let queue = DispatchQueue(label: "xyz.tinycloud.exo.stt.modelstore")
    private var states: [String: ModelState] = [:]
    private var bytesDone: [String: Int64] = [:]
    private var errors: [String: String] = [:]

    public init(root: URL = ModelStore.defaultRoot) {
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        for id in ModelManifest.allIds { states[id] = .absent; bytesDone[id] = 0 }
        rescan()
    }

    public static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("models", isDirectory: true)
    }

    public func modelDir(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
    public func fileURL(_ id: String, _ file: ModelFile) -> URL { modelDir(id).appendingPathComponent(file.name) }

    /// Re-derives each downloadable model's state from what is actually on disk (sha256-verified),
    /// so a relaunch never trusts stale in-memory state. Called at init and after every download.
    /// The hashing (hundreds of MB) happens before the lock is taken, so `status`/`isReady`/`setState`
    /// callers, including the main thread, never wait on it.
    public func rescan() {
        var verified: [String: Bool] = [:]
        for id in ModelManifest.allIds {
            guard let files = ModelManifest.filesFor(id) else { continue }
            let allPresent = files.allSatisfy { file in
                let url = modelDir(id).appendingPathComponent(file.name)
                return (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? Int64 == file.bytes
            }
            verified[id] = allPresent && verify(id: id, files: files)
        }
        queue.sync {
            for (id, isVerified) in verified {
                guard let files = ModelManifest.filesFor(id) else { continue }
                if isVerified {
                    states[id] = .ready; bytesDone[id] = files.reduce(0) { $0 + $1.bytes }; errors[id] = nil
                } else if states[id] != .downloading && states[id] != .queued && states[id] != .verifying {
                    states[id] = .absent; bytesDone[id] = 0
                }
            }
        }
    }

    private func verify(id: String, files: [ModelFile]) -> Bool {
        for file in files {
            guard let data = try? Data(contentsOf: modelDir(id).appendingPathComponent(file.name)) else { return false }
            let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            guard digest == file.sha256 else { return false }
        }
        return true
    }

    public func status(_ id: String) -> (state: ModelState, bytes: Int64, error: String?) {
        queue.sync { (states[id] ?? .absent, bytesDone[id] ?? 0, errors[id]) }
    }

    public func isReady(_ id: String) -> Bool { queue.sync { states[id] == .ready } }

    public func setState(_ id: String, _ state: ModelState, bytes: Int64? = nil, error: String? = nil) {
        queue.sync {
            states[id] = state
            if let bytes { bytesDone[id] = bytes }
            errors[id] = error
        }
    }

    /// Moves a verified download into place, replacing any previous copy. Throws (never leaves a
    /// half-written file at the final path) if the move fails.
    func publish(id: String, file: ModelFile, from staged: URL) throws {
        let dir = modelDir(id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let final = dir.appendingPathComponent(file.name)
        if FileManager.default.fileExists(atPath: final.path) { try FileManager.default.removeItem(at: final) }
        try FileManager.default.moveItem(at: staged, to: final)
    }

    public func delete(_ id: String) {
        try? FileManager.default.removeItem(at: modelDir(id))
        setState(id, .absent, bytes: 0, error: nil)
    }
}
