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

    private let store: ModelStore
    private let capture = CaptureEngine.shared
    /// Runs the model load and the decode loop (the only long work); nothing ever `sync`s onto it.
    private let workQueue = DispatchQueue(label: "xyz.tinycloud.exo.stt.queue", qos: .utility)
    /// Short bookkeeping (reconcile scan, enqueue, cancel): never queued behind a decode, so a
    /// cancel or a freshly committed note is seen by the running pass right away.
    private let controlQueue = DispatchQueue(label: "xyz.tinycloud.exo.stt.control")
    private let captureGate = CapturePauseGate()
    private let state = TranscriptionState()
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
        controlQueue.async { [self] in
            guard let notes = try? capture.library.listCommitted() else { return }
            for note in notes {
                guard let id = note["id"] as? String,
                      let options = note["options"] as? [String: Any],
                      options["transcriber"] as? String == "on-device",
                      let stt = note["stt"] as? [String: Any],
                      let state = stt["state"] as? String,
                      ["waiting_for_model", "queued", "running"].contains(state) else { continue }
                if (try? capture.library.transcript(id)) != nil { continue }
                self.state.add(id)
            }
            kickWorker()
        }
    }

    /// Explicit enqueue: the UI's Retry for a `failed` note, or a fresh on-device recording. Resets
    /// the attempt count, since this is a deliberate retry, not an automatic one.
    public func enqueue(id: String) {
        controlQueue.async { [self] in
            guard (try? capture.library.transcript(id)) == nil else { return } // already has one
            try? capture.library.updateStt(id, patch: ["state": "queued", "error": NSNull(), "attempts": 0])
            state.add(id)
            onQueueChanged?()
            kickWorker()
        }
    }

    /// Drops a queued note, or stops the note decoding right now at its next window; the worker then
    /// records the `cancelled` state itself, so a finishing decode and a cancel never race on the sidecar.
    public func cancel(id: String) {
        controlQueue.async { [self] in
            switch state.cancel(id) {
            case .removedPending, .notFound:
                try? capture.library.updateStt(id, patch: ["state": "cancelled"])
            case .flaggedRunning:
                break
            }
            onQueueChanged?()
        }
    }

    /// Never blocks on a decode: the running note (with its last percent) and the pending ones, from memory.
    public func queueSnapshot() -> [[String: Any]] {
        state.snapshot()
    }

    /// Pushed by `CaptureEngine` (via `captureSessionStarted`) the instant a session begins
    /// (capture-priority handoff, plan §2.5): never blocks, so capture never waits on this queue.
    public func captureStarted() {
        captureGate.captureStarted()
    }

    /// Pushed by `CaptureEngine` (via `captureSessionEnded`) once a session has fully ended (Stop,
    /// Discard, or a start that never acquired the mic): resumes the queue from its checkpoint.
    public func captureEnded() {
        captureGate.captureEnded()
        kickWorker()
    }

    private func kickWorker() {
        workQueue.async { [self] in pump() }
    }

    /// Runs on `workQueue` only, so there is never more than one decode at a time.
    private func pump() {
        guard state.hasPending else { return }
        guard !captureGate.isActive() else { return } // Resumed by `captureEnded()`.
        let memory = ProcessInfo.processInfo.physicalMemory
        let modelId = ModelManifest.primaryModel(physicalMemoryBytes: memory)
        guard store.isReady(modelId), store.isReady(ModelManifest.sileroVad) else {
            state.markAllPending(state: "waiting_for_model")
            for id in state.pendingIds { try? capture.library.updateStt(id, patch: ["state": "waiting_for_model"]) }
            onQueueChanged?()
            return
        }
        state.markAllPending(state: "queued")
        let engine: Engine
        do {
            engine = try Engine(store: store, modelId: modelId)
        } catch {
            for id in state.removeAllPending() { fail(id, code: "model_load_failed", message: String(describing: error)) }
            onQueueChanged?()
            return
        }
        CaptureYieldingLoop.run(
            hasNext: { state.hasPending },
            next: { state.takeNext() },
            isPaused: { captureGate.isActive() }
        ) { next in
            guard let id = next else { return } // cancelled between hasNext and next
            defer { state.finishCurrent() }
            if (try? capture.library.transcript(id)) != nil { return } // finished while it was being re-queued
            let previousAttempts = ((try? capture.library.readSidecar(id))?["stt"] as? [String: Any])?["attempts"] as? Int ?? 0
            switch AttemptGuard.next(previousAttempts: previousAttempts) {
            case .giveUp:
                fail(id, code: "too_many_attempts", message: "gave up after \(AttemptGuard.maxAttempts) attempts")
                return
            case .proceed(let attempt):
                // Persisted before the risky decode starts: a crash mid-attempt still counts
                // against the cap next launch, instead of retrying the same note forever.
                try? capture.library.updateStt(id, patch: ["state": "running", "attempts": attempt,
                    "pack": modelId == ModelManifest.parakeetFull ? "full" : "small", "engine": "parakeet"])
            }
            onQueueChanged?()
            do {
                try process(id: id, engine: engine, modelId: modelId)
            } catch TranscriptionQueueError.captureStarted {
                // Not a failed attempt: an orderly yield to a resumed recording. Restore the
                // attempt count so being interrupted repeatedly never burns the crash-loop budget.
                try? capture.library.updateStt(id, patch: ["state": "queued", "attempts": previousAttempts])
                state.requeueCurrentFirst()
            } catch TranscriptionQueueError.cancelled {
                try? capture.library.updateStt(id, patch: ["state": "cancelled", "attempts": previousAttempts])
                onQueueChanged?()
            } catch {
                fail(id, code: "decode_failed", message: String(describing: error))
            }
        }
        if state.hasPending { workQueue.asyncAfter(deadline: .now() + 2) { [weak self] in self?.pump() } }
    }

    private func fail(_ id: String, code: String, message: String) {
        try? capture.library.updateStt(id, patch: ["state": "failed", "error": code])
        NSLog("ExoStt transcription failed id=%@ code=%@ message=%@", id, code, message)
        onFailed?(id, code, message)
        onQueueChanged?()
    }

    private func process(id: String, engine: Engine, modelId: String) throws {
        let audioURL = capture.library.audioURL(id)
        let totalWindows = estimatedWindows(audioURL)
        var segments: [[String: Any]] = []
        var decodedAny = false
        var segmentsDone = 0
        var windowsDone = 0
        var lastPercent = -1
        try engine.transcribe(
            file: audioURL,
            checkCapturing: { [self] in
                if state.isCancelRequested(id) { throw TranscriptionQueueError.cancelled }
                guard !captureGate.isActive() else { throw TranscriptionQueueError.captureStarted }
            },
            onWindow: { [self] in
                windowsDone += 1
                let percent = totalWindows.map { min(99, Int(Double(windowsDone) / Double($0) * 100)) } ?? 0
                // A window is 32 ms of audio: persist and announce progress only when the percent
                // moves, not ~30 times a second (each is a durable sidecar write and a bridge event).
                guard percent != lastPercent else { return }
                lastPercent = percent
                try? capture.library.updateStt(id, patch: ["windowsDone": windowsDone])
                state.setProgress(percent)
                onProgress?(id, percent)
            },
            onSegment: { [self] chunk, words in
                if !words.isEmpty {
                    decodedAny = true
                    // Milliseconds, not fractional seconds: CanonicalJSON only accepts whole-integer
                    // NSNumbers (TC-836 — the only type every other timestamp in this schema already uses).
                    segments.append(["start": chunk.start * 1000 / 16_000, "end": chunk.end * 1000 / 16_000,
                                      "text": words.map(\.text).joined(separator: " "), "speaker": NSNull()])
                }
                segmentsDone += 1
                try? capture.library.updateStt(id, patch: ["segmentsDone": segmentsDone])
            })
        let outcome = decodedAny ? "transcribed" : "no_speech"
        let transcript: [String: Any] = [
            "version": 1, "noteId": id, "transcriber": "on-device", "rev": 1,
            "engine": modelId == ModelManifest.parakeetFull ? "parakeet-tdt-0.6b-v3" : "parakeet-tdt-110m-en",
            "model": modelId, "language": "en", "outcome": outcome, "diarized": false,
            "segments": segments, "createdAt": ISO8601DateFormatter().string(from: Date()),
        ]
        try capture.library.putTranscript(id, object: transcript)
        try capture.library.updateStt(id, patch: ["state": "done", "error": NSNull()])
        onProgress?(id, 100)
        onTranscribed?(id, outcome)
        onQueueChanged?()
    }

    /// A cheap upper-bound estimate of VAD windows for progress reporting, from the container's
    /// duration; does not decode any audio. Nil if the file can't be opened.
    private func estimatedWindows(_ url: URL) -> Int? {
        guard let file = try? AVAudioFile(forReading: url), file.length > 0, file.processingFormat.sampleRate > 0 else { return nil }
        let seconds = Double(file.length) / file.processingFormat.sampleRate
        let totalSamples = Int(seconds * 16_000)
        return max(1, totalSamples / 512)
    }
}

enum TranscriptionQueueError: Error {
    case captureStarted
    case cancelled
    case modelFilesMissing
    case decodeFailed
}

/// One loaded recognizer + VAD config, scoped to a single `pump()` pass; ARC drops the
/// sherpa-onnx wrappers when `Engine` deinits, before capture competes for memory.
private final class Engine {
    private let recognizer: SherpaOnnxOfflineRecognizer
    private let vadModelPath: String
    private let threads: Int32

    private static let windowSize = 512

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
