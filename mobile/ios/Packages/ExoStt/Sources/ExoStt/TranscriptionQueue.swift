#if os(iOS)
import AVFoundation
import ExoCapture
import Foundation
import SherpaOnnx
import SttCore

/// Decodes a committed note's audio and produces a transcript with sherpa-onnx (plan §2.5), for
/// notes whose `options.transcriber == "on-device"`. This slice runs the whole job in-process on a
/// background queue: there is no `BGProcessingTask`/checkpoint persistence (T24 adds that), so a
/// note interrupted by the app dying restarts its decode from the beginning next time the queue
/// runs, instead of resuming mid-file. It never runs while a capture session is live: it checks
/// `CapturePauseGate.isActive()` before loading a model and again before every VAD window, and
/// releases the recognizer promptly instead of competing with capture for CPU/memory. Audio is
/// decoded and fed to the VAD and recognizer in fixed-size windows (`AudioDecoder.decodeWindows`),
/// never as one in-memory array, so a note's memory use does not scale with its length: a note left
/// recording for a long time once crashed every launch decoding itself whole (TC-836 incident).
/// Before each attempt, `AttemptGuard` persists an incremented attempt count to the note's sidecar;
/// after `AttemptGuard.maxAttempts` a note is marked `failed` instead of retried, so a note that
/// reliably crashes the decode can never crash-loop the app at every launch again.
///
/// Capture-priority handoff (plan §2.5, round-2 finding 3 override): `CaptureEngine.start` never
/// waits for this queue — it pushes `captureStarted()` (via `CaptureEngine.captureSessionStarted`,
/// wired in `ExoSttBootstrap`) and opens the mic immediately regardless. `CapturePauseGate` is the
/// signal that push sets; it stays active through a paused session too, not only a recording one,
/// and only `captureEnded()` (Stop, Discard, or a start that never acquired the mic) clears it. The
/// outer note-at-a-time loop (`CaptureYieldingLoop`) checks it between notes; the per-window
/// capture check inside `Engine.transcribe` checks it between windows, i.e. between ASR segments —
/// never mid-recognize(), since that call can't be interrupted. Either way the engine releases at
/// the next checkpoint and this queue stays idle until `captureEnded()`, then resumes from exactly
/// where it left off.
public final class TranscriptionQueue {
    public static let shared = TranscriptionQueue(store: ModelDownloads.shared.store)

    private let core: TranscriptionCore
    public var onQueueChanged: (() -> Void)? {
        get { core.onQueueChanged }
        set { core.onQueueChanged = newValue }
    }
    public var onProgress: ((String, Int) -> Void)? {
        get { core.onProgress }
        set { core.onProgress = newValue }
    }
    public var onTranscribed: ((String, String) -> Void)? {
        get { core.onTranscribed }
        set { core.onTranscribed = newValue }
    }
    public var onFailed: ((String, String, String) -> Void)? {
        get { core.onFailed }
        set { core.onFailed = newValue }
    }

    public init(store: ModelStore) {
        let library = CaptureLibrary()
        core = TranscriptionCore(library: library, backend: SherpaBackend(store: store, audioURL: library.audioURL))
        // The launch-time model check runs in the background; the worker waits for it (rather than
        // concluding the model is missing) and this restarts the queue and refreshes the UI once done.
        store.onInitialCheckFinished { [weak self] in self?.core.initialCheckFinished() }
    }

    /// Scans every committed note for unfinished on-device work (native work inventory, plan §2.5)
    /// and adds it to the queue. Called at launch (after recovery), on every `committed` event, and
    /// when a model finishes downloading.
    public func reconcile() { core.reconcile() }

    /// Explicit enqueue: the UI's Retry for a `failed` note, or a fresh on-device recording. Resets
    /// the attempt count, since this is a deliberate retry, not an automatic one; a note that is
    /// already queued or decoding is left alone.
    public func enqueue(id: String) { core.enqueue(id: id) }

    /// Drops a queued note, or stops the note decoding right now at its next checkpoint; the worker
    /// then records the `cancelled` state itself, so a finishing decode and a cancel never race on the sidecar.
    public func cancel(id: String) { core.cancel(id: id) }

    /// Never blocks on a decode: the running note (with its last percent) and the pending ones, from memory.
    public func queueSnapshot() -> [[String: Any]] { core.queueSnapshot() }

    /// Pushed by `CaptureEngine` (via `captureSessionStarted`) the instant a session begins
    /// (capture-priority handoff, plan §2.5): never blocks, so capture never waits on this queue.
    public func captureStarted() { core.captureStarted() }

    /// Pushed by `CaptureEngine` (via `captureSessionEnded`) once a session has fully ended (Stop,
    /// Discard, or a start that never acquired the mic): resumes the queue from its checkpoint.
    public func captureEnded() { core.captureEnded() }
}

/// The shared capture engine's note library, seen through the queue's narrow `TranscriptionLibrary`.
private final class CaptureLibrary: TranscriptionLibrary {
    private let library = CaptureEngine.shared.library

    func audioURL(_ id: String) -> URL { library.audioURL(id) }
    func listCommitted() throws -> [[String: Any]] { try library.listCommitted() }
    func transcript(_ id: String) throws -> [String: Any]? { try library.transcript(id) }
    func readSidecar(_ id: String) throws -> [String: Any] { try library.readSidecar(id) }
    func updateStt(_ id: String, patch: [String: Any]) throws { try library.updateStt(id, patch: patch) }
    func putTranscript(_ id: String, object: [String: Any]) throws { try library.putTranscript(id, object: object) }
}

private final class SherpaBackend: TranscriptionBackend {
    private let store: ModelStore
    private let audioURL: (String) -> URL

    init(store: ModelStore, audioURL: @escaping (String) -> URL) {
        self.store = store
        self.audioURL = audioURL
    }

    var isChecking: Bool { store.isChecking }

    func makeSession() throws -> TranscriptionSession? {
        let modelId = ModelManifest.primaryModel(physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory)
        guard store.isReady(modelId), store.isReady(ModelManifest.sileroVad) else { return nil }
        return SherpaSession(engine: try Engine(store: store, modelId: modelId), modelId: modelId, audioURL: audioURL)
    }
}

private final class SherpaSession: TranscriptionSession {
    private let engine: Engine
    private let modelId: String
    private let audioURL: (String) -> URL

    init(engine: Engine, modelId: String, audioURL: @escaping (String) -> URL) {
        self.engine = engine
        self.modelId = modelId
        self.audioURL = audioURL
    }

    var runPatch: [String: Any] {
        ["pack": modelId == ModelManifest.parakeetFull ? "full" : "small", "engine": "parakeet"]
    }

    func transcribe(id: String, checkCapturing: @escaping () throws -> Void,
                    onProgress: @escaping (Int, Int) -> Void, onSegment: @escaping (Int) -> Void) throws -> [String: Any] {
        let audioURL = audioURL(id)
        let duration = durationSeconds(audioURL)
        var segments: [[String: Any]] = []
        var decodedAny = false
        var segmentsDone = 0
        var windowsDone = 0
        var lastPercent = -1
        try engine.transcribe(
            file: audioURL,
            checkCapturing: checkCapturing,
            onWindow: {
                windowsDone += 1
                let percent = DecodeProgress.percent(windowsDone: windowsDone, windowSize: Engine.windowSize, durationSeconds: duration)
                // A window is 32 ms of audio: persist and announce progress only when the percent
                // moves, not ~30 times a second (each is a durable sidecar write and a bridge event).
                guard percent != lastPercent else { return }
                lastPercent = percent
                onProgress(percent, windowsDone)
            },
            onSegment: { chunk, words in
                if !words.isEmpty {
                    decodedAny = true
                    // Milliseconds, not fractional seconds: CanonicalJSON only accepts whole-integer
                    // NSNumbers (TC-836 — the only type every other timestamp in this schema already uses).
                    segments.append(["start": chunk.start * 1000 / 16_000, "end": chunk.end * 1000 / 16_000,
                                      "text": words.map(\.text).joined(separator: " "), "speaker": NSNull()])
                }
                segmentsDone += 1
                onSegment(segmentsDone)
            })
        return [
            "version": 1, "noteId": id, "transcriber": "on-device", "rev": 1,
            "engine": modelId == ModelManifest.parakeetFull ? "parakeet-tdt-0.6b-v3" : "parakeet-tdt-110m-en",
            "model": modelId, "language": "en", "outcome": decodedAny ? "transcribed" : "no_speech", "diarized": false,
            "segments": segments, "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
    }

    /// The note's length from its container; does not decode any audio. Nil if the file can't be opened.
    private func durationSeconds(_ url: URL) -> Double? {
        guard let file = try? AVAudioFile(forReading: url), file.length > 0, file.processingFormat.sampleRate > 0 else { return nil }
        return Double(file.length) / file.processingFormat.sampleRate
    }
}

/// One loaded recognizer + VAD config, scoped to a single `pump()` pass; ARC drops the
/// sherpa-onnx wrappers when `Engine` deinits, before capture competes for memory.
private final class Engine {
    private let recognizer: SherpaOnnxOfflineRecognizer
    private let vadModelPath: String
    private let threads: Int32

    static let windowSize = 512

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

    /// Streams `file` through the VAD and recognizer one `Engine.windowSize` window at a time
    /// (`AudioDecoder.decodeWindows`), so memory never scales with the note's length.
    /// `checkCapturing` is called before every window; `onWindow` after every window (progress);
    /// `onSegment` for every VAD speech segment once its words are recognized.
    func transcribe(file: URL, checkCapturing: @escaping () throws -> Void, onWindow: @escaping () -> Void,
                    onSegment: @escaping (Chunk, [TimedWord]) throws -> Void) throws {
        var vadConfig = sherpaOnnxVadModelConfig(
            sileroVad: sherpaOnnxSileroVadModelConfig(model: vadModelPath, minSilenceDuration: 0.4,
                                                     minSpeechDuration: 0.1, maxSpeechDuration: 25),
            numThreads: Int(threads))
        let vad = SherpaOnnxVoiceActivityDetectorWrapper(config: &vadConfig, buffer_size_in_seconds: 30)
        func drain() throws {
            while !vad.isEmpty() {
                let segment = vad.front()
                let chunk = Chunk(start: segment.start, end: segment.start + segment.samples.count, samples: segment.samples)
                let words = try recognize(samples: chunk.samples, origin: Double(chunk.start) / 16_000)
                try onSegment(chunk, words)
                vad.pop()
            }
        }
        try AudioDecoder.decodeWindows(file, windowSize: Engine.windowSize) { window in
            try checkCapturing()
            vad.acceptWaveform(samples: window)
            try drain()
            onWindow()
        }
        vad.flush()
        try drain()
    }

    private func recognize(samples: [Float], origin: Double) throws -> [TimedWord] {
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
