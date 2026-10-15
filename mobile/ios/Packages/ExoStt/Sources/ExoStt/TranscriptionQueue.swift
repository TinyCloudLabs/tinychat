#if os(iOS)
import ExoCapture
import Foundation

/// Transcribes a committed note's audio with Apple's built-in on-device speech (plan §2.5), for notes
/// whose `options.transcriber == "on-device"`. This slice runs the whole job in-process on a
/// background queue: there is no `BGProcessingTask`/checkpoint persistence (T24 adds that), so a
/// note interrupted by the app dying restarts its decode from the beginning next time the queue
/// runs, instead of resuming mid-file. It never runs while a capture session is live: it checks
/// `CapturePauseGate.isActive()` before starting a note and again before every second of audio fed to
/// the analyzer, and stops promptly instead of competing with capture for CPU/memory. Audio is read
/// and fed lazily (`SpeechAudioFeed`), never as one in-memory array, so a note's memory use does not
/// scale with its length: a note left recording for a long time once crashed every launch decoding
/// itself whole (TC-836 incident).
/// Before each attempt, `AttemptGuard` persists an incremented attempt count to the note's sidecar;
/// after `AttemptGuard.maxAttempts` a note is marked `failed` instead of retried, so a note that
/// reliably crashes the decode can never crash-loop the app at every launch again.
///
/// Capture-priority handoff (plan §2.5, round-2 finding 3 override): `CaptureEngine.start` never
/// waits for this queue — it pushes `captureStarted()` (via `CaptureEngine.captureSessionStarted`,
/// wired in `ExoSttBootstrap`) and opens the mic immediately regardless. `CapturePauseGate` is the
/// signal that push sets; it stays active through a paused session too, not only a recording one,
/// and only `captureEnded()` (Stop, Discard, or a start that never acquired the mic) clears it. The
/// outer note-at-a-time loop (`CaptureYieldingLoop`) checks it between notes; the feed checks it
/// between buffers. Either way the queue releases at the next checkpoint and stays idle until
/// `captureEnded()`, then restarts that note's decode.
public final class TranscriptionQueue {
    public static let shared = TranscriptionQueue()

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

    public init() {
        let library = CaptureLibrary()
        let assets = AppleSpeechAssets.shared
        core = TranscriptionCore(library: library, backend: AppleSpeechBackend(assets: assets, audioURL: library.audioURL))
        // The launch-time asset check runs in the background; the worker waits for it (rather than
        // concluding the speech assets are missing) and this restarts the queue and refreshes the UI once done.
        Task { [weak self] in
            await assets.refresh()
            self?.core.initialCheckFinished()
        }
    }

    /// Scans every committed note for unfinished on-device work (native work inventory, plan §2.5)
    /// and adds it to the queue. Called at launch (after recovery), on every `committed` event, and
    /// when the speech assets finish installing.
    public func reconcile() { core.reconcile() }
    /// Clears interrupted explicit reruns during app launch; reruns are never resumed.
    public func recoverInterruptedReruns() { core.recoverInterruptedReruns() }

    /// Explicit enqueue: the UI's Retry for a `failed` note, or a fresh on-device recording. Resets
    /// the attempt count, since this is a deliberate retry, not an automatic one; a note that is
    /// already queued or decoding is left alone. `accepted` says whether the note is now in line:
    /// false for a note that already has its transcript. The choice is recorded in the note's sidecar
    /// so a restart resumes it; `failed` runs instead when the note could not be queued.
    public func enqueue(id: String, accepted: ((Bool) -> Void)? = nil, failed: ((Error) -> Void)? = nil) {
        core.enqueue(id: id, accepted: accepted, failed: failed)
    }
    /// User-confirmed rerun with a caller-computed revision and committed base. It is not resumable after relaunch.
    public func enqueueAgain(id: String, rev: Int, baseRev: Int, baseHash: String,
                             accepted: ((Bool) -> Void)? = nil, failed: ((Error) -> Void)? = nil) {
        core.enqueueAgain(id: id, rev: rev, baseRev: baseRev, baseHash: baseHash, accepted: accepted, failed: failed)
    }

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

/// Where Apple's speech assets come from: `makeSession` returns nil (the note waits) until the OS has them
/// installed for this phone's language. Readiness is re-read from the OS at every pump, since the OS can
/// drop assets nothing is using.
private final class AppleSpeechBackend: TranscriptionBackend {
    private let assets: AppleSpeechAssets
    private let audioURL: (String) -> URL

    init(assets: AppleSpeechAssets, audioURL: @escaping (String) -> URL) {
        self.assets = assets
        self.audioURL = audioURL
    }

    var isChecking: Bool { !assets.hasChecked }

    func makeSession() throws -> TranscriptionSession? {
        let target = BlockingResult<AppleSpeechAssets.Target?>()
        Task.detached(priority: .utility) { [assets] in target.finish(.success(await assets.refresh())) }
        guard let ready = try target.wait() else { return nil }
        return AppleSpeechSession(target: ready, audioURL: audioURL)
    }
}
#endif
