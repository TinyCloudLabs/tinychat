import Capacitor
import ExoStt
import Foundation

@objc(OnDeviceSttPlugin)
public final class OnDeviceSttPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "OnDeviceSttPlugin"
    public let jsName = "OnDeviceStt"
    public var pluginMethods: [CAPPluginMethod] {
        var methods: [CAPPluginMethod] = [
            "status", "setAutoDownload", "downloadNow", "cancelDownload", "deleteModels", "enqueue", "cancel",
        ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }
        #if EXO_STT_BENCH
        methods.append(CAPPluginMethod(name: "benchmark", returnType: CAPPluginReturnPromise))
        #endif
        return methods
    }

    private let store = ModelDownloads.shared.store
    private let downloads = ModelDownloads.shared
    private let queue = TranscriptionQueue.shared
    private let autoDownloadKey = "exo.stt.autoDownload"

    override public func load() {
        queue.onQueueChanged = { [weak self] in
            DispatchQueue.main.async { self?.notifyListeners("status", data: self?.statusDict() ?? [:], retainUntilConsumed: true) }
        }
        queue.onProgress = { [weak self] id, percent in
            DispatchQueue.main.async { self?.notifyListeners("progress", data: ["id": id, "percent": percent]) }
        }
        queue.onTranscribed = { [weak self] id, outcome in
            DispatchQueue.main.async { self?.notifyListeners("transcribed", data: ["id": id, "outcome": outcome], retainUntilConsumed: true) }
        }
        queue.onFailed = { [weak self] id, code, message in
            DispatchQueue.main.async { self?.notifyListeners("failed", data: ["id": id, "code": code, "message": message], retainUntilConsumed: true) }
        }
    }

    private func statusDict() -> [String: Any] {
        let memory = ProcessInfo.processInfo.physicalMemory
        let pack = memory >= 6_000_000_000 ? "full" : "small"
        let models = ModelManifest.allIds.map { id -> [String: Any] in
            let (state, bytes, error) = store.status(id)
            return ["id": id, "state": state.rawValue, "bytes": bytes,
                    "totalBytes": ModelManifest.totalBytes(id), "error": error as Any? ?? NSNull()]
        }
        let engine = store.isReady(ModelManifest.parakeetFull) || store.isReady(ModelManifest.parakeetSmall) ? "parakeet" : "none"
        return [
            "models": models, "pack": pack,
            "autoDownload": UserDefaults.standard.bool(forKey: autoDownloadKey),
            "download": ["policy": "wifi", "state": downloads.downloadState().rawValue],
            "engine": engine, "appleSpeech": "unsupported",
            "queue": queue.queueSnapshot(),
        ]
    }

    @objc public func status(_ call: CAPPluginCall) {
        call.resolve(statusDict())
    }

    @objc public func setAutoDownload(_ call: CAPPluginCall) {
        // Stored, but has no automatic effect in this slice: downloads only start from
        // `downloadNow` (manual, Settings/recorder "Download"). T13 wires background auto-start.
        UserDefaults.standard.set(call.getBool("enabled") ?? false, forKey: autoDownloadKey)
        call.resolve()
        notifyListeners("status", data: statusDict(), retainUntilConsumed: true)
    }

    @objc public func downloadNow(_ call: CAPPluginCall) {
        let memory = ProcessInfo.processInfo.physicalMemory
        let modelId = ModelManifest.primaryModel(physicalMemoryBytes: memory)
        guard ModelManifest.filesFor(modelId) != nil else {
            call.reject("The on-device model for this phone's memory tier is not downloadable yet", "small_pack_unsupported")
            return
        }
        // Wi-Fi only in this slice, whatever `allowCellular` asks (TC-836 report, deviations).
        downloads.start(modelId: ModelManifest.sileroVad,
                        onProgress: { [weak self] id, done, total in self?.emitDownloadProgress(id, done, total) },
                        onFinished: { [weak self] _, vadResult in
            switch vadResult {
            case .failure(let error):
                call.reject("Could not download the speech-detection model", "download_failed", error)
            case .success:
                self?.downloads.start(modelId: modelId,
                                      onProgress: { id, done, total in self?.emitDownloadProgress(id, done, total) },
                                      onFinished: { _, result in
                    switch result {
                    case .failure(let error):
                        call.reject("Could not download the on-device transcription model", "download_failed", error)
                    case .success:
                        self?.queue.reconcile()
                        call.resolve()
                    }
                    self?.notifyListeners("status", data: self?.statusDict() ?? [:], retainUntilConsumed: true)
                })
            }
        })
        notifyListeners("status", data: statusDict(), retainUntilConsumed: true)
    }

    private func emitDownloadProgress(_ id: String, _ done: Int64, _ total: Int64) {
        store.setState(id, .downloading, bytes: done)
        notifyListeners("status", data: statusDict(), retainUntilConsumed: true)
    }

    @objc public func cancelDownload(_ call: CAPPluginCall) {
        downloads.cancel()
        call.resolve()
        notifyListeners("status", data: statusDict(), retainUntilConsumed: true)
    }

    @objc public func deleteModels(_ call: CAPPluginCall) {
        store.delete(ModelManifest.parakeetFull)
        store.delete(ModelManifest.parakeetSmall)
        store.delete(ModelManifest.sileroVad)
        call.resolve()
        notifyListeners("status", data: statusDict(), retainUntilConsumed: true)
    }

    @objc public func enqueue(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        queue.enqueue(id: id)
        call.resolve()
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("id is required", "invalid_argument"); return }
        queue.cancel(id: id)
        call.resolve()
    }

    #if EXO_STT_BENCH
    @objc public func benchmark(_ call: CAPPluginCall) {
        guard let relative = call.getString("dir"), relative == "Documents/stt-bench" else {
            call.reject("Benchmark directory must be Documents/stt-bench", "invalid_directory")
            return
        }
        let threads = call.getArray("threads", Int.self) ?? [4, 2]
        let directory = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(relative)
        DispatchQueue.global(qos: .utility).async {
            do {
                let result = try SttBenchmark.run(directory: directory, threads: threads)
                call.resolve(result)
            } catch {
                call.reject("STT benchmark failed: \(error)", "benchmark_failed", error)
            }
        }
    }
    #endif
}
