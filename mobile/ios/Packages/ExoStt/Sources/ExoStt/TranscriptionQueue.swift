#if os(iOS)
import AVFoundation
import ExoCapture
import Foundation
import SherpaOnnx
import SttCore

/// Decodes a committed note's audio and produces a transcript with sherpa-onnx (plan §2.5), for
/// notes whose `options.transcriber == "on-device"`. This slice runs the whole job in-process on a
/// background queue: there is no `BGProcessingTask`/checkpoint persistence (T23 adds that), so a
/// note interrupted by the app dying restarts its decode from the beginning next time the queue
/// runs, instead of resuming mid-file. It never runs while a capture session is live: it checks
/// `CaptureEngine.shared.isCapturing` before loading a model and again before every VAD segment,
/// and releases the recognizer promptly instead of competing with capture for CPU/memory.
public final class TranscriptionQueue {
    public static let shared = TranscriptionQueue(store: ModelDownloads.shared.store)

    private let store: ModelStore
    private let capture = CaptureEngine.shared
    private let runQueue = DispatchQueue(label: "xyz.tinycloud.exo.stt.queue")
    private var pending: [String] = []
    private var running = false
    public var onQueueChanged: (() -> Void)?
    public var onProgress: ((String, Int) -> Void)?
    public var onTranscribed: ((String, String) -> Void)?
    public var onFailed: ((String, String, String) -> Void)?

    public init(store: ModelStore) {
        self.store = store
    }

    /// Scans every committed note for unfinished on-device work (native work inventory, plan §2.5)
    /// and adds it to the queue. Called at launch (after recovery), on every `committed` event, and
    /// when a model finishes downloading.
    public func reconcile() {
        runQueue.async { [self] in
            guard let notes = try? capture.library.listCommitted() else { return }
            for note in notes {
                guard let id = note["id"] as? String,
                      let options = note["options"] as? [String: Any],
                      options["transcriber"] as? String == "on-device",
                      let stt = note["stt"] as? [String: Any],
                      let state = stt["state"] as? String,
                      ["waiting_for_model", "queued", "running"].contains(state) else { continue }
                if (try? capture.library.transcript(id)) != nil { continue }
                if !pending.contains(id) { pending.append(id) }
            }
            pump()
        }
    }

    /// Explicit enqueue: the UI's Retry for a `failed` note, or a fresh on-device recording. Reset
    /// so a previous failure's error does not stick around once the note is queued again.
    public func enqueue(id: String) {
        runQueue.async { [self] in
            guard (try? capture.library.transcript(id)) == nil else { return } // already has one
            try? capture.library.updateStt(id, patch: ["state": "queued", "error": NSNull()])
            if !pending.contains(id) { pending.append(id) }
            onQueueChanged?()
            pump()
        }
    }

    public func cancel(id: String) {
        runQueue.async { [self] in
            pending.removeAll { $0 == id }
            try? capture.library.updateStt(id, patch: ["state": "cancelled"])
            onQueueChanged?()
        }
    }

    public func queueSnapshot() -> [[String: Any]] {
        runQueue.sync {
            pending.map { id in
                let stt = (try? capture.library.readSidecar(id))?["stt"] as? [String: Any] ?? [:]
                return ["id": id, "state": stt["state"] as? String ?? "queued",
                        "percent": NSNull(), "error": stt["error"] as Any? ?? NSNull()]
            }
        }
    }

    private func pump() {
        guard !running, !pending.isEmpty else { return }
        guard !capture.isCapturing else { return } // Resumed by the next `committed` (capture ended).
        let memory = ProcessInfo.processInfo.physicalMemory
        let modelId = ModelManifest.primaryModel(physicalMemoryBytes: memory)
        guard store.isReady(modelId), store.isReady(ModelManifest.sileroVad) else {
            for id in pending { try? capture.library.updateStt(id, patch: ["state": "waiting_for_model"]) }
            onQueueChanged?()
            return
        }
        running = true
        let engine: Engine
        do {
            engine = try Engine(store: store, modelId: modelId)
        } catch {
            for id in pending { fail(id, code: "model_load_failed", message: String(describing: error)) }
            pending.removeAll()
            running = false
            onQueueChanged?()
            return
        }
        defer { running = false }
        while let id = pending.first {
            guard !capture.isCapturing else { break } // Leave it queued; release happens via `defer`.
            pending.removeFirst()
            try? capture.library.updateStt(id, patch: ["state": "running", "pack": modelId == ModelManifest.parakeetFull ? "full" : "small", "engine": "parakeet"])
            onQueueChanged?()
            do {
                try process(id: id, engine: engine, modelId: modelId)
            } catch TranscriptionQueueError.captureStarted {
                try? capture.library.updateStt(id, patch: ["state": "queued"])
                pending.insert(id, at: 0)
                break
            } catch {
                fail(id, code: "decode_failed", message: String(describing: error))
            }
        }
        if !pending.isEmpty { runQueue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.pump() } }
    }

    private func fail(_ id: String, code: String, message: String) {
        try? capture.library.updateStt(id, patch: ["state": "failed", "error": code])
        NSLog("ExoStt transcription failed id=%@ code=%@ message=%@", id, code, message)
        onFailed?(id, code, message)
        onQueueChanged?()
    }

    private func process(id: String, engine: Engine, modelId: String) throws {
        let audioURL = capture.library.audioURL(id)
        let samples = try AudioDecoder.decode16kMono(audioURL)
        let chunks = try engine.vadSegments(samples: samples)
        var segments: [[String: Any]] = []
        var decodedAny = false
        var done = 0
        for chunk in chunks {
            guard !capture.isCapturing else { throw TranscriptionQueueError.captureStarted }
            let words = try engine.recognize(samples: chunk.samples, origin: Double(chunk.start) / 16_000)
            if !words.isEmpty {
                decodedAny = true
                segments.append(["start": Double(chunk.start) / 16_000, "end": Double(chunk.end) / 16_000,
                                  "text": words.map(\.text).joined(separator: " "), "speaker": NSNull()])
            }
            done += 1
            try capture.library.updateStt(id, patch: ["segmentsDone": done])
            onProgress?(id, chunks.isEmpty ? 100 : Int(Double(done) / Double(chunks.count) * 100))
        }
        let outcome = decodedAny ? "transcribed" : "no_speech"
        let transcript: [String: Any] = [
            "version": 1, "noteId": id, "transcriber": "on-device", "rev": 1,
            "engine": modelId == ModelManifest.parakeetFull ? "parakeet-tdt-0.6b-v3" : "parakeet-tdt-110m-en",
            "model": modelId, "language": "en", "outcome": outcome, "diarized": false,
            "segments": segments, "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
        try capture.library.putTranscript(id, object: transcript)
        try capture.library.updateStt(id, patch: ["state": "done", "error": NSNull()])
        onTranscribed?(id, outcome)
        onQueueChanged?()
    }
}

enum TranscriptionQueueError: Error {
    case captureStarted
    case modelFilesMissing
    case decodeFailed
}

/// One loaded recognizer + VAD, scoped to a single `pump()` pass, released at the end of it
/// (ARC drops the sherpa-onnx wrappers when `Engine` deinits).
private final class Engine {
    private let recognizer: SherpaOnnxOfflineRecognizer
    private let vadModelPath: String
    private let threads: Int32

    init(store: ModelStore, modelId: String) throws {
        let dir = store.root.appendingPathComponent(modelId, isDirectory: true)
        let vadDir = store.root.appendingPathComponent(ModelManifest.sileroVad, isDirectory: true)
        for file in ["encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt"] {
            guard FileManager.default.fileExists(atPath: dir.appendingPathComponent(file).path) else {
                throw TranscriptionQueueError.modelFilesMissing // unreachable: ModelStore verified `ready` first
            }
        }
        threads = 4
        let modelConfig = sherpaOnnxOfflineModelConfig(
            tokens: dir.appendingPathComponent("tokens.txt").path,
            transducer: sherpaOnnxOfflineTransducerModelConfig(
                encoder: dir.appendingPathComponent("encoder.int8.onnx").path,
                decoder: dir.appendingPathComponent("decoder.int8.onnx").path,
                joiner: dir.appendingPathComponent("joiner.int8.onnx").path),
            numThreads: Int(threads), provider: "cpu", modelType: "nemo_transducer")
        // TC-819's T23 recommendation: greedy search, blankPenalty 1.0, no chunk padding, 25 s soft VAD cap.
        var config = sherpaOnnxOfflineRecognizerConfig(featConfig: sherpaOnnxFeatureConfig(),
                                                       modelConfig: modelConfig, decodingMethod: "greedy_search",
                                                       blankPenalty: 1.0)
        recognizer = SherpaOnnxOfflineRecognizer(config: &config)
        vadModelPath = vadDir.appendingPathComponent("silero_vad.onnx").path
    }

    struct Chunk { let start: Int; let end: Int; let samples: [Float] }

    func vadSegments(samples: [Float]) throws -> [Chunk] {
        var vadConfig = sherpaOnnxVadModelConfig(
            sileroVad: sherpaOnnxSileroVadModelConfig(model: vadModelPath, minSilenceDuration: 0.4,
                                                     minSpeechDuration: 0.1, maxSpeechDuration: 25),
            numThreads: Int(threads))
        let vad = SherpaOnnxVoiceActivityDetectorWrapper(config: &vadConfig, buffer_size_in_seconds: 30)
        var chunks: [Chunk] = []
        func drain() {
            while !vad.isEmpty() {
                let segment = vad.front()
                chunks.append(Chunk(start: segment.start, end: segment.start + segment.samples.count, samples: segment.samples))
                vad.pop()
            }
        }
        for offset in stride(from: 0, to: samples.count, by: 512) {
            vad.acceptWaveform(samples: Array(samples[offset..<min(offset + 512, samples.count)]))
            drain()
        }
        vad.flush()
        drain()
        return chunks
    }

    func recognize(samples: [Float], origin: Double) throws -> [TimedWord] {
        let result = recognizer.decode(samples: samples)
        guard result.count > 0, let tokenPointers = result.result.pointee.tokens_arr else { return [] }
        var tokens: [String] = []
        for index in 0..<result.count {
            guard let pointer = tokenPointers[index] else { throw TranscriptionQueueError.decodeFailed }
            tokens.append(String(cString: pointer))
        }
        return try TokenWordAlignment.align(tokens: tokens, timestamps: result.timestamps,
                                            durations: result.durations, origin: origin)
    }
}
#endif
