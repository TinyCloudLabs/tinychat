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
        guard let files = ModelManifest.downloadable[modelId] else {
            onFinished(modelId, .failure(ModelDownloadError.unsupportedModel))
            return
        }
        self.onProgress = onProgress
        self.onFinished = onFinished
        activeModel = modelId
        store.setState(modelId, .queued)
        downloadNextFile(modelId: modelId, files: files, index: 0, doneBytes: 0, totalBytes: files.reduce(0) { $0 + $1.bytes })
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
