import CryptoKit
import Foundation
import Network

public enum DownloadPolicyState: String {
    case idle, running, waitingForNetwork = "waiting_for_network", failed
}

/// Downloads the models this build supports (plan §2.9), Wi-Fi only: the slice drops the
/// background `URLSession` (T13 adds it), so a download pauses — never silently fails — while the
/// app is backgrounded or killed, and resumes the next time `downloadNow` runs (manually, or from
/// `TranscriptionQueue` when a note needs a model that is not `ready`).
public final class ModelDownloads: NSObject {
    public static let shared = ModelDownloads(store: ModelStore())

    public let store: ModelStore
    private let session: URLSession
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "xyz.tinycloud.exo.stt.pathmonitor")
    private var state: DownloadPolicyState = .idle
    private var activeModel: String?
    private var activeTask: URLSessionDownloadTask?
    private var onProgress: ((String, Int64, Int64) -> Void)?
    private var onFinished: ((String, Result<Void, Error>) -> Void)?
    private var wifiAvailable = true

    public init(store: ModelStore) {
        self.store = store
        let configuration = URLSessionConfiguration.default
        configuration.allowsCellularAccess = false
        configuration.allowsExpensiveNetworkAccess = false
        configuration.allowsConstrainedNetworkAccess = false
        self.session = URLSession(configuration: configuration)
        super.init()
        monitor.pathUpdateHandler = { [weak self] path in
            self?.wifiAvailable = path.usesInterfaceType(.wifi) && path.status == .satisfied
        }
        monitor.start(queue: monitorQueue)
    }

    public func downloadState() -> DownloadPolicyState { state }

    /// `handleBackgroundEvents` (T13's stub, ExoSttBootstrap.swift) stays `false`: this downloader
    /// never registers a background `URLSession`.
    public static func handleBackgroundEvents(identifier: String, completion: @escaping () -> Void) -> Bool {
        false
    }

    /// Starts (or resumes) downloading one model's files. `onProgress`/`onFinished` are set once by
    /// `TranscriptionQueue`/the plugin and reused for every model this process downloads.
    public func start(modelId: String, onProgress: @escaping (String, Int64, Int64) -> Void,
                      onFinished: @escaping (String, Result<Void, Error>) -> Void) {
        self.onProgress = onProgress
        self.onFinished = onFinished
        activeModel = modelId
        store.setState(modelId, .queued)
        if let archive = ModelManifest.archives[modelId] {
            downloadArchive(modelId: modelId, archive: archive)
            return
        }
        guard let files = ModelManifest.downloadable[modelId] else {
            onFinished(modelId, .failure(ModelDownloadError.unsupportedModel))
            return
        }
        downloadNextFile(modelId: modelId, files: files, index: 0, doneBytes: 0, totalBytes: files.reduce(0) { $0 + $1.bytes })
    }

    /// Downloads a `.tar.bz2` release asset whole, verifies it, then extracts and re-verifies the
    /// files inside it (the small, <6 GB RAM, pack: plan §2.9, mobile/docs/stt-on-device-slice.md).
    private func downloadArchive(modelId: String, archive: ModelArchive) {
        guard wifiAvailable else {
            state = .waitingForNetwork
            monitorQueue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.downloadArchive(modelId: modelId, archive: archive) }
            return
        }
        state = .running
        store.setState(modelId, .downloading, bytes: 0)
        let task = session.downloadTask(with: archive.url) { [weak self] location, _, error in
            guard let self else { return }
            if let error {
                self.state = .failed
                self.store.setState(modelId, .failed, error: (error as NSError).localizedDescription)
                self.onFinished?(modelId, .failure(error))
                return
            }
            guard let location else {
                self.store.setState(modelId, .failed, error: "no_response_body")
                self.onFinished?(modelId, .failure(ModelDownloadError.verificationFailed))
                return
            }
            do {
                try self.extractArchive(modelId: modelId, archive: archive, downloadedAt: location)
            } catch {
                self.state = .failed
                self.store.setState(modelId, .failed, error: String(describing: error))
                self.onFinished?(modelId, .failure(error))
                return
            }
            self.store.rescan()
            self.state = .idle
            self.onFinished?(modelId, self.store.isReady(modelId) ? .success(()) : .failure(ModelDownloadError.verificationFailed))
        }
        activeTask = task
        let observation = task.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
            self?.onProgress?(modelId, Int64(progress.fractionCompleted * Double(archive.bytes)), archive.bytes)
        }
        progressObservations.append(observation)
        task.resume()
    }

    private func extractArchive(modelId: String, archive: ModelArchive, downloadedAt: URL) throws {
        let dir = store.modelDir(modelId)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let stagedArchive = dir.appendingPathComponent("archive.tar.bz2")
        if FileManager.default.fileExists(atPath: stagedArchive.path) { try FileManager.default.removeItem(at: stagedArchive) }
        try FileManager.default.moveItem(at: downloadedAt, to: stagedArchive)
        defer { try? FileManager.default.removeItem(at: stagedArchive) }

        let archiveDigest = try sha256(of: stagedArchive)
        let archiveSize = (try FileManager.default.attributesOfItem(atPath: stagedArchive.path)[.size] as? Int64) ?? -1
        guard archiveDigest == archive.sha256, archiveSize == archive.bytes else {
            throw ModelDownloadError.verificationFailed
        }
        store.setState(modelId, .verifying, bytes: archive.bytes)

        let tarURL = dir.appendingPathComponent("archive.tar")
        if FileManager.default.fileExists(atPath: tarURL.path) { try FileManager.default.removeItem(at: tarURL) }
        try Bzip2.decompress(inputURL: stagedArchive, outputURL: tarURL)
        defer { try? FileManager.default.removeItem(at: tarURL) }

        let extracted = try TarReader.extract(tarURL: tarURL, wanted: Set(archive.entries.keys)) { name in
            dir.appendingPathComponent((archive.entries[name]?.name ?? "unknown") + ".extract")
        }
        guard extracted.count == archive.entries.count else { throw ModelDownloadError.verificationFailed }
        for (archivePath, file) in archive.entries {
            let staged = dir.appendingPathComponent(file.name + ".extract")
            let digest = try sha256(of: staged)
            let size = (try FileManager.default.attributesOfItem(atPath: staged.path)[.size] as? Int64) ?? -1
            guard digest == file.sha256, size == file.bytes else {
                try? FileManager.default.removeItem(at: staged)
                throw ModelDownloadError.verificationFailed
            }
            try store.publish(id: modelId, file: file, from: staged)
            _ = archivePath
        }
    }

    private func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { handle.closeFile() }
        var hasher = SHA256()
        while true {
            let chunk = handle.readData(ofLength: 1 << 20)
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    public func cancel() {
        activeTask?.cancel()
        activeTask = nil
        if let activeModel { store.setState(activeModel, .absent, bytes: 0) }
        activeModel = nil
        state = .idle
    }

    private func downloadNextFile(modelId: String, files: [ModelFile], index: Int, doneBytes: Int64, totalBytes: Int64) {
        guard index < files.count else {
            store.rescan()
            state = .idle
            activeModel = nil
            onFinished?(modelId, store.isReady(modelId) ? .success(()) : .failure(ModelDownloadError.verificationFailed))
            return
        }
        guard wifiAvailable else {
            state = .waitingForNetwork
            monitorQueue.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.downloadNextFile(modelId: modelId, files: files, index: index, doneBytes: doneBytes, totalBytes: totalBytes)
            }
            return
        }
        state = .running
        store.setState(modelId, .downloading, bytes: doneBytes)
        let file = files[index]
        let task = session.downloadTask(with: file.url) { [weak self] location, _, error in
            guard let self else { return }
            if let error {
                self.state = .failed
                self.store.setState(modelId, .failed, error: (error as NSError).localizedDescription)
                self.onFinished?(modelId, .failure(error))
                return
            }
            guard let location else {
                self.store.setState(modelId, .failed, error: "no_response_body")
                self.onFinished?(modelId, .failure(ModelDownloadError.verificationFailed))
                return
            }
            do {
                let data = try Data(contentsOf: location)
                let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard digest == file.sha256, Int64(data.count) == file.bytes else {
                    try? FileManager.default.removeItem(at: location)
                    throw ModelDownloadError.verificationFailed
                }
                try self.store.publish(id: modelId, file: file, from: location)
            } catch {
                self.state = .failed
                self.store.setState(modelId, .failed, error: "sha256_mismatch")
                self.onFinished?(modelId, .failure(error))
                return
            }
            self.store.setState(modelId, .downloading, bytes: doneBytes + file.bytes)
            self.downloadNextFile(modelId: modelId, files: files, index: index + 1,
                                  doneBytes: doneBytes + file.bytes, totalBytes: totalBytes)
        }
        activeTask = task
        let observation = task.progress.observe(\.fractionCompleted) { [weak self] progress, _ in
            self?.onProgress?(modelId, doneBytes + Int64(progress.fractionCompleted * Double(file.bytes)), totalBytes)
        }
        progressObservations.append(observation)
        task.resume()
    }

    private var progressObservations: [NSKeyValueObservation] = []
}

public enum ModelDownloadError: Error {
    case unsupportedModel
    case verificationFailed
}
